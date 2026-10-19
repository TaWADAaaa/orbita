'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state = { settings:{}, models:[], chats:[], activeModel:null, project:null, runtime:{}, hardware:{} };
let currentChat = null, busy = false, runtimeChanging = false, activeReply = null, thinkingTimer, startedAt, files = [], downloadActive = false;
let hfQuery = '', hfResults = [], hfSearchRevision = 0, fileSearchTimer, saveTimer, settingsRevision = 0;
const pendingToolCards = new Map();
const t = (text, values) => window.orbitaI18n?.t(text, values) || text;
let messageQueue = [], queuePaused = false, queueRunning = false;
const api = async (name, data = {}) => {
  if (!window.orbita) throw new Error('The app engine did not start. Close Órbita and open it again.');
  const result = await window.orbita.call(name, data);
  if (result && result.error) throw new Error(result.error);
  return result;
};
function toast(message, error = false) {
  const item = document.createElement('div'); item.className = `toast${error?' error':''}`;
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.textContent = '×'; close.title = 'Close'; close.onclick = () => item.remove();
  item.append(text,close); $('#toasts').append(item); setTimeout(() => item.remove(), error ? 13000 : 6000);
}
async function safely(task) { try { return await task(); } catch (err) { toast(err.message || 'Something went wrong. Try again.', true); } }
function showPage(page) {
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  $$('.nav-item[data-page]').forEach(el => el.classList.toggle('active',el.dataset.page===page));
  $('#page-label').textContent = {chat:'Conversation',models:'Models',settings:'Settings'}[page];
  $('#sidebar').classList.remove('open');
  if (page === 'models') renderModels();
}
function setSettings(s) {
  state.settings = s;
  if (s.language) window.orbitaI18n?.setLanguage(s.language);
  const palettes = {
    dark:{background:'#151517',sidebar:'#101012',surface:'#1c1c20',foreground:'#ecebf0',border:'#2b2a30',muted:'#939199',faint:'#64636c',hover:'#242429'},
    midnight:{background:'#0f1420',sidebar:'#0a0f18',surface:'#161e2d',foreground:'#e8edf5',border:'#283143',muted:'#929eb2',faint:'#65718b',hover:'#202b3e'},
    light:{background:'#f7f6f3',sidebar:'#eeedea',surface:'#ffffff',foreground:'#28252f',border:'#dedce2',muted:'#737079',faint:'#8f8b96',hover:'#eceaf1'},
    custom:{background:s.background||'#151517',sidebar:s.background||'#151517',surface:s.surface||'#1c1c20',foreground:s.foreground||'#ecebf0',border:s.border||'#2b2a30',muted:`color-mix(in srgb, ${s.foreground||'#ecebf0'} 68%, ${s.background||'#151517'})`,faint:`color-mix(in srgb, ${s.foreground||'#ecebf0'} 50%, ${s.background||'#151517'})`,hover:`color-mix(in srgb, ${s.surface||'#1c1c20'} 90%, ${s.foreground||'#ecebf0'})`}
  };
  const p = palettes[s.theme] || palettes.dark, root = document.documentElement;
  for (const [key,value] of Object.entries(p)) root.style.setProperty({'background':'--bg','sidebar':'--sidebar','surface':'--surface','foreground':'--text','border':'--border','muted':'--muted','faint':'--faint','hover':'--surface-hover'}[key],value);
  root.style.colorScheme = s.theme==='light'?'light':'dark';
  const accent = /^#[\da-f]{6}$/i.test(s.accent)?s.accent:'#b6a0f5';
  root.style.setProperty('--accent',accent); root.style.setProperty('--accent-rgb',accent.slice(1).match(/.{2}/g).map(n=>parseInt(n,16)).join(','));
  root.style.setProperty('--font-size',`${s.fontSize||14}px`); root.style.setProperty('--radius',`${s.radius??14}px`);
  root.style.setProperty('--chat-width',`${s.chatWidth||760}px`);
  root.style.setProperty('--font',s.fontFamily==='mono'?'Consolas, monospace':s.fontFamily==='humanist'?'Candara, Calibri, sans-serif':"OrbitaSystem, 'Segoe UI', sans-serif");
  document.body.classList.toggle('compact',s.density==='compact'); document.body.classList.toggle('no-motion',s.animations===false);
  $$('[data-setting]').forEach(el => { const v=s[el.dataset.setting]; if(v!==undefined){if(el.type==='checkbox')el.checked=!!v;else el.value=String(v);} });
  $$('[data-accent]').forEach(el=>el.classList.toggle('selected',el.dataset.accent.toLowerCase()===accent.toLowerCase()));
  $('#custom-colors').classList.toggle('hidden',s.theme!=='custom'); $('#temperature-value').textContent=s.temperature??.3;
  window.orbitaWorkspace?.renderAccess(s);
}
function saveSettings(key,value) {
  setSettings({...state.settings,[key]:value}); clearTimeout(saveTimer);const revision=++settingsRevision;
  saveTimer = setTimeout(()=>safely(async()=> {const settings = await api('saveSettings',{settings:{...state.settings}});if(revision===settingsRevision)setSettings(settings);}),200);
}
function renderHistory() {
  $('#history').innerHTML = state.chats.length ? '' : '<div class="history-empty">Your ideas start here.</div>';
  state.chats.forEach(chat=>{
    const row=document.createElement('div');row.className=`history-item${chat.id===currentChat?.id?' selected':''}`;
    const open=document.createElement('button');open.textContent=chat.title||'New conversation';open.title=chat.title||'New conversation';open.onclick=()=>safely(()=>openChat(chat.id));
    const del=document.createElement('button');del.className='history-delete';del.title='Delete conversation';del.innerHTML=icon('close');del.onclick=()=>confirmDeleteChat(chat.id);
    row.append(open,del);$('#history').append(row);
  });
}
function confirmDeleteChat(id){
  modal('Delete conversation','<p class="modal-subtitle">This conversation will be deleted from your computer. Project files stay as they are.</p><div class="modal-actions"><button class="secondary-btn" id="cancel-delete">Keep</button><button class="primary-btn" id="confirm-delete">Delete conversation</button></div>');
  $('#cancel-delete').onclick=closeModal;$('#confirm-delete').onclick=()=>safely(async()=>{if(busy)throw Error('Stop the current reply first.');await api('deleteChat',{id});state.chats=state.chats.filter(c=>c.id!==id);if(currentChat?.id===id)newChat();renderHistory();closeModal();});
}
async function openChat(id) {
  if(busy) {toast('Stop the reply before opening another conversation.');return;}
  if(messageQueue.length&&id!==currentChat?.id){toast('Send or remove the queued messages first.');return;}
  if(window.orbitaWorkspace&&!await window.orbitaWorkspace.beforeProjectChange())return;
  const chat=await api('getChat',{id});currentChat=chat;state.project=chat.projectPath?{path:chat.projectPath,name:chat.projectPath.split(/[\\/]/).filter(Boolean).pop()}:null;renderProject();$('#messages').innerHTML='';pendingToolCards.clear();
  $('#welcome').classList.toggle('hidden',chat.messages.length>0);
  chat.messages.forEach(msg=>renderMessage(msg));window.orbitaWorkspace?.chatOpened(chat);files=[];$('#file-filter').value='';if(!$('#files-panel').classList.contains('hidden'))await refreshFiles();renderHistory();showPage('chat');scrollBottom();
}
function newChat(){if(busy){toast('Stop the reply before starting another conversation.');return;}if(messageQueue.length){toast('Send or remove the queued messages first.');return;}currentChat=null;$('#messages').innerHTML='';$('#welcome').classList.remove('hidden');$('#prompt').value='';pendingToolCards.clear();renderHistory();showPage('chat');$('#prompt').focus();}
function markdown(text) {
  const blocks=[];
  let safe=String(text||'').replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g,(_,lang,code)=>{blocks.push(`<div class="code-block"><button class="copy-code">Copy</button><pre><code>${esc(code.replace(/\n$/,''))}</code></pre></div>`);return `\u0000BLOCK${blocks.length-1}\u0000`;});
  safe=esc(safe).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  safe=safe.replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^##? (.+)$/gm,'<h2>$1</h2>').replace(/^[-*] (.+)$/gm,'<div>• $1</div>').replace(/^\d+\. (.+)$/gm,'<div>$1</div>');
  safe=safe.split(/\n{2,}/).map(p=>/^<(h[23]|div)/.test(p)||p.startsWith('\u0000BLOCK')?p:`<p>${p.replace(/\n/g,'<br>')}</p>`).join('');
  return safe.replace(/\u0000BLOCK(\d+)\u0000/g,(_,n)=>blocks[n]);
}
function bindCodeCopies(el){$$('.copy-code',el).forEach(button=>button.onclick=()=>safely(async()=>{await api('copyText',{text:button.nextElementSibling.textContent});button.textContent='Copied';setTimeout(()=>button.textContent='Copy',1800);}));}
function renderMessage(msg) {
  if(msg.role==='tool'){renderTool(msg);return null;}
  if(!['user','assistant'].includes(msg.role))return null;
  const el=document.createElement('article');el.className=`message ${msg.role}`;
  el.innerHTML=`<div class="message-head"><span>${msg.role==='user'?'V':icon('spark')}</span>${msg.role==='user'?'You':'Órbita'}</div><div class="message-body"></div>`;
  $('.message-body',el).innerHTML=msg.role==='user'?esc(msg.content):markdown(msg.content);
  if(msg.role==='assistant'&&msg.content){const actions=document.createElement('div');actions.className='message-actions';const copy=document.createElement('button');copy.textContent='Copy reply';copy.onclick=()=>safely(async()=>{await api('copyText',{text:msg.content});toast('Reply copied.');});actions.append(copy);el.append(actions);}
  bindCodeCopies(el);$('#messages').append(el);return el;
}
function scrollBottom(){const box=$('#conversation');box.scrollTop=box.scrollHeight;}
function setBusy(value){
  busy=value;$('#thinking').classList.toggle('hidden',!value);$('#send').innerHTML=icon('arrow');$('#send').title=t(value?'Add to queue':'Send (Enter)');$('#prompt').readOnly=false;$('#stop-response').classList.toggle('hidden',!value);
  clearInterval(thinkingTimer);if(value){startedAt=Date.now();$('#thinking-time').textContent='';thinkingTimer=setInterval(()=>$('#thinking-time').textContent=`${Math.floor((Date.now()-startedAt)/1000)} s`,1000);}else $('#thinking-text').textContent='Thinking…';
  $$('[data-undo]').forEach(button=>button.disabled=value);
  renderQueue();
}
function persistQueue(){sessionStorage.setItem('orbita.queue',JSON.stringify({chatId:currentChat?.id||null,items:messageQueue}));}
function renderQueue(){
  const root=$('#message-queue');if(!root)return;root.replaceChildren();root.classList.toggle('hidden',!messageQueue.length);if(!messageQueue.length){persistQueue();return;}
  const head=document.createElement('div');head.className='queue-heading';const label=document.createElement('span');label.textContent=t('Queued')+` · ${messageQueue.length}`;head.append(label);
  if(!busy){const resume=document.createElement('button');resume.className='text-btn';resume.textContent=t('Continue');resume.onclick=()=>{queuePaused=false;drainQueue();};head.append(resume);}root.append(head);
  messageQueue.forEach(item=>{const row=document.createElement('div');row.className='queued-message';const edit=document.createElement('button');edit.className='queued-text';edit.textContent=item.text;edit.dataset.i18nSkip='';edit.title=t('Edit message');edit.onclick=()=>{if($('#prompt').value.trim()){toast('Send or clear your draft first.');return;}$('#prompt').value=item.text;messageQueue=messageQueue.filter(entry=>entry.id!==item.id);renderQueue();$('#prompt').focus();};const remove=document.createElement('button');remove.className='icon-btn';remove.innerHTML=icon('close');remove.title=t('Remove from queue');remove.onclick=()=>{messageQueue=messageQueue.filter(entry=>entry.id!==item.id);renderQueue();};row.append(edit,remove);root.append(row);});persistQueue();
}
async function stopResponse(){queuePaused=true;await safely(()=>api('stop'));renderQueue();}
async function drainQueue(){
  if(busy||queueRunning||queuePaused||!messageQueue.length)return;queueRunning=true;
  try{const item=messageQueue.shift();renderQueue();if(!await runMessage(item.text)){messageQueue.unshift(item);renderQueue();}}finally{queueRunning=false;if(!busy&&!queuePaused&&messageQueue.length)setTimeout(drainQueue,0);}
}
async function sendMessage(){
  if(runtimeChanging){toast('Wait for the engine setup to finish before sending a message.');return;}
  const text=$('#prompt').value.trim();if(!text)return;
  if(text.length>100000){toast('The message is too long. Send a smaller part.',true);return;}
  if(!state.activeModel){showPage('models');toast('Add and choose a model to get started.');return;}
  if(messageQueue.length>=20){toast('The queue is full. Wait for it to advance or remove a message.');return;}
  $('#prompt').value='';$('#prompt').style.height='auto';
  messageQueue.push({id:crypto.randomUUID(),text});renderQueue();if(!busy){queuePaused=false;await drainQueue();}
}
async function runMessage(text){
  $('#welcome').classList.add('hidden');const userMessage=renderMessage({role:'user',content:text});activeReply=null;setBusy(true);scrollBottom();
  try{const result=await api('sendMessage',{chatId:currentChat?.id||null,text,mode:'auto'});currentChat=result.chat;state.chats=result.chats;if(result.failed||result.stopped)queuePaused=true;renderHistory();persistQueue();return true;}
  catch(err){userMessage?.remove();queuePaused=true;toast(err.message||'Could not send. Try again.',true);return false;}
  finally{setBusy(false);activeReply=null;scrollBottom();}
}
function receive(event){
  if(event.type==='chatStarted'){if(!currentChat)currentChat={id:event.chatId,messages:[],projectPath:state.project?.path||null};persistQueue();return;}
  if(window.orbitaWorkflow?.receive(event))return;
  if(event.type==='projectChanged'){state.project=event.project;if(currentChat&&event.chatId===currentChat.id)currentChat.projectPath=event.project?.path;renderProject();safely(refreshFiles);return;}
  if(window.orbitaWorkspace?.receive(event))return;
  if(event.type==='navigate'&&['chat','models','settings'].includes(event.page)){showPage(event.page);return;}
  if(event.type==='status'){$('#thinking-text').textContent=event.text;if(event.text==='Respuesta detenida.'){const el=document.createElement('div');el.className='inline-error';el.textContent='Respuesta detenida.';$('#messages').append(el);}return;}
  if(event.type==='delta'){
    if(!activeReply){activeReply=renderMessage({role:'assistant',content:''});}
    activeReply.dataset.content=(activeReply.dataset.content||'')+event.text;
    const box=$('#conversation'),stick=box.scrollHeight-box.scrollTop-box.clientHeight<140;
    $('.message-body',activeReply).innerHTML=markdown(activeReply.dataset.content);if(stick)scrollBottom();return;
  }
  if(event.type==='replyEnd'){if(activeReply){bindCodeCopies(activeReply);const text=activeReply.dataset.content||'';if(text){const actions=document.createElement('div');actions.className='message-actions';const copy=document.createElement('button');copy.textContent='Copy reply';copy.onclick=()=>safely(async()=>{await api('copyText',{text});toast('Reply copied.');});actions.append(copy);activeReply.append(actions);}}activeReply=null;return;}
  if(event.type==='tool'){activeReply=null;renderTool(event.tool);scrollBottom();return;}
  if(event.type==='toolResult'){const el=pendingToolCards.get(event.id);if(el){$('.tool-actions',el)?.remove();$('.tool-state',el).textContent=event.text;if(['write_file','delete_file'].includes(el.dataset.tool)&&event.text==='Listo'){$('.tool-title span',el).textContent=el.dataset.tool==='delete_file'?'File deleted':'File saved';addUndo(el,event.id);}if(event.result){const details=document.createElement('details');details.innerHTML='<summary>View result</summary>';const pre=document.createElement('pre');pre.textContent=event.result;details.append(pre);el.insertBefore(details,$('.tool-state',el));}}return;}
  if(event.type==='error'){if(!busy){toast(event.text,true);return;}const el=document.createElement('div');el.className='inline-error';el.textContent=event.text;$('#messages').append(el);scrollBottom();return;}
  if(event.type==='download'){renderDownload(event);return;}
  if(event.type==='models'){state.models=event.models;state.activeModel=event.activeModel;renderModels();return;}
  if(event.type==='runtime'){state.runtime=event.runtime;renderRuntime();return;}
}
function renderTool(tool){
  const data=tool.data||tool; const kind=data.tool||data.name||'acción';
  const labels={read_file:'Read a file',list_files:'View the folder',search:'Search files',write_file:'Save a file',delete_file:'Delete a file',make_directory:'Create a folder',run_command:'Run a command',start_command:'Start a process',read_terminal:'Read the console',send_terminal:'Write to the console',stop_terminal:'Stop a process',web_search:'Search the web',read_url:'Read a page',open_file:'Open a file',pack_project:'Package as ZIP',remember:'Save a memory',forget:'Delete a memory'};
  const card=document.createElement('div');card.className='tool-card';card.dataset.tool=kind;card.dataset.path=data.path||'';const approval=!tool.status&&(tool.approvalRequired===true||['write_file','delete_file','make_directory','run_command','start_command','send_terminal','stop_terminal','web_search','read_url'].includes(kind));
  card.innerHTML=`<div class="tool-title">${icon(['run_command','start_command','read_terminal','send_terminal','stop_terminal'].includes(kind)?'code':['web_search','read_url'].includes(kind)?'link':'file')}<span>${esc(labels[kind]||kind)}</span></div><p data-i18n-skip>${esc(data.path||data.command||data.query||data.url||data.content||data.id||'')}</p>`;
  if(approval){
    const details=document.createElement('details');details.open=kind==='write_file'||['run_command','start_command','delete_file'].includes(kind);const summary=document.createElement('summary');summary.textContent=kind==='write_file'?'Review changes':['run_command','start_command','send_terminal'].includes(kind)?'Review the command':'View details';details.append(summary);
    const pre=document.createElement('pre');
    if(kind==='write_file'&&typeof tool.before==='string'){
      const before=tool.before.split('\n'),after=String(data.content||'').split('\n');let prefix=0;while(prefix<Math.min(before.length,after.length)&&before[prefix]===after[prefix])prefix++;
      let suffix=0;while(suffix<Math.min(before.length,after.length)-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
      const addLine=(line,cls,sign)=>{const s=document.createElement('span');s.className=`diff-line ${cls}`;s.textContent=sign+line;pre.append(s);};
      before.slice(Math.max(0,prefix-3),prefix).forEach(l=>addLine(l,'',' '));
      before.slice(prefix,before.length-suffix).forEach(l=>addLine(l,'remove','− '));after.slice(prefix,after.length-suffix).forEach(l=>addLine(l,'add','+ '));
      after.slice(after.length-suffix,after.length-suffix+3).forEach(l=>addLine(l,'',' '));
    }else pre.textContent=kind==='write_file'?data.content||'':kind==='delete_file'?tool.before||data.path:data.command||data.text||data.url||data.query||data.path||data.content||data.id||'';
    details.append(pre);card.append(details);
    const warning=document.createElement('p');warning.textContent=kind==='write_file'?'It will be saved in your folder. You can undo it.':kind==='delete_file'?'This file will be deleted. A copy is saved so you can restore it.':kind==='open_file'?'Opens with the app you use for this file.':kind==='pack_project'?'A ZIP of your project will be created.':kind==='remember'?'Saved for future conversations. You can delete it in Settings.':kind==='forget'?'This memory will be deleted. The conversation is kept.':['run_command','start_command','send_terminal'].includes(kind)?'This command runs on your PC and can change or delete things. Review it before continuing.':['web_search','read_url'].includes(kind)?'This request goes to the internet. Check what information it includes.':kind==='make_directory'?'A folder will be created inside your project.':'The AI will be able to see the result of this step.';card.append(warning);
    const actions=document.createElement('div');actions.className='tool-actions';const yes=document.createElement('button');yes.className='primary-btn';yes.textContent=kind==='write_file'?'Save change':kind==='delete_file'?'Delete file':kind==='make_directory'?'Create folder':['run_command','start_command'].includes(kind)?'Run':'Allow';const no=document.createElement('button');no.className='secondary-btn';no.textContent='Skip';
    const answer=approved=>safely(async()=>{yes.disabled=no.disabled=true;$('.tool-state',card).textContent=approved?'Working…':'Omitido por vos.';try{await api('approveTool',{id:tool.id,approved});actions.remove();}catch(e){yes.disabled=no.disabled=false;$('.tool-state',card).textContent='Could not finish. You can try again.';throw e;}});
    yes.onclick=()=>answer(true);no.onclick=()=>answer(false);actions.append(yes,no);card.append(actions);
  }else if(tool.result){const details=document.createElement('details');details.innerHTML='<summary>View result</summary>';const pre=document.createElement('pre');pre.textContent=tool.result;details.append(pre);card.append(details);}
  const status=document.createElement('div');status.className='tool-state';status.textContent=approval?'Waiting for your decision.':tool.status||'Listo';card.append(status);$('#messages').append(card);if(tool.id)pendingToolCards.set(tool.id,card);
  if(['write_file','delete_file'].includes(kind)&&tool.status==='Listo'){$('.tool-title span',card).textContent=kind==='delete_file'?'File deleted':'File saved';addUndo(card,tool.id);}if(tool.status==='Cambio deshecho')$('.tool-title span',card).textContent='Cambio deshecho';
  if(tool.authorization==='level'){const label=document.createElement('div');label.className='tool-auto-label';label.textContent=`Permitido por el nivel ${tool.accessLevel||state.settings.accessLevel||1}`;card.append(label);}
}
function addUndo(card,toolId){
  if($('[data-undo]',card))return;const recovery=card.dataset.tool==='delete_file';const button=document.createElement('button');button.className='text-btn';button.dataset.undo=toolId;button.disabled=busy;button.textContent=recovery?'Restore file':'Undo this change';button.style.margin='0 8px 8px';
  button.onclick=()=>{if(busy){toast('Wait for the task to finish before undoing the change.');return;}modal(recovery?'Restore file':'Undo this change',`<p class="modal-subtitle">${recovery?'The file will be restored from its saved copy. If another file already uses that name, Órbita keeps it and lets you know.':'The file will return to its previous version. If the AI created it, it will be deleted. If you changed it later, Órbita keeps your version and lets you know.'}</p><div class="modal-actions"><button class="secondary-btn" id="cancel-undo">Back</button><button class="primary-btn" id="confirm-undo">${recovery?'Restore':'Undo change'}</button></div>`);$('#cancel-undo').onclick=closeModal;$('#confirm-undo').onclick=()=>safely(async()=>{const result=await api('restoreChange',{chatId:currentChat.id,toolId});currentChat=result.chat||result;$('#messages').innerHTML='';pendingToolCards.clear();currentChat.messages.forEach(renderMessage);closeModal();toast(recovery?'File restored.':'Change undone.');if(!$('#files-panel').classList.contains('hidden'))await refreshFiles();});};card.append(button);
}
function renderModels(){
  $('#model-count').textContent=state.models.length;
  const active=state.models.find(m=>m.id===state.activeModel);
  $('#composer-model').innerHTML=`${esc(active?modelLabel(active):'No model')}${icon('chevron')}`;
  $('#model-status').innerHTML=`<span class="status-dot${active?'':' muted-dot'}"></span><span>${esc(active?modelLabel(active):'Choose a model')}</span>`;
  const root=$('#model-library');root.innerHTML='';
  if(!state.models.length)root.innerHTML=`<div class="empty-models">${icon('box')}<div><strong>Your first model is waiting</strong><p>Add one using any of the three options below.</p></div></div>`;
  state.models.forEach(model=>{
    const el=document.createElement('div');el.className=`model-row${model.id===state.activeModel?' active':''}`;
    el.title=model.name;el.innerHTML=`<div class="model-avatar">${icon('box')}</div><div class="model-details"><div class="model-name">${esc(modelLabel(model))}</div><div class="model-meta">${formatBytes(model.size)} · GGUF${model.id===state.activeModel?' · Elegido':''}</div></div><div class="model-buttons"></div>`;
    const use=document.createElement('button');use.className='secondary-btn';use.textContent=model.id===state.activeModel?'In use':'Use model';use.disabled=model.id===state.activeModel;use.onclick=()=>safely(async()=>{if(busy)throw Error('Stop the reply before changing models.');await api('selectModel',{id:model.id});state.activeModel=model.id;renderModels();toast('Model selected. It will load when you send a message.');});
    const remove=document.createElement('button');remove.className='icon-btn';remove.title='Remove from list';remove.innerHTML=icon('close');remove.onclick=()=>safely(async()=>{if(busy)throw Error('Stop the reply before removing a model.');const result=await api('removeModel',{id:model.id});state.models=result.models;state.activeModel=result.activeModel;renderModels();toast('Model removed from the list. The file stays on your PC.');});$('.model-buttons',el).append(use,remove);root.append(el);
  });renderRuntime();
}
function modelLabel(model){return String(model.name).replace(/\.gguf$/i,'').replace(/[-_](?:i?q\d|[bf]f?\d)[\w.-]*$/i,'').replace(/[-_]instruct/ig,'').replace(/[-_]/g,' ').replace(/^qwen/i,'Qwen').replace(/(\d)b\b/ig,'$1B');}
function renderRuntime(){
  const ready=state.runtime?.ready,gpu=ready&&state.runtime.cpuOnly===false;
  $('#runtime-info').textContent=ready?`Motor listo · ${gpu?'Graphics acceleration':'Processor'} · ${state.runtime.version||'llama.cpp'}`:'The engine runs your models offline.';
  $('#install-runtime').textContent=ready?(gpu?'Use processor':'Processor selected'):'Set up local engine';$('#install-runtime').disabled=ready&&!gpu;
  if(!$('#prepare-gpu')){const button=document.createElement('button');button.id='prepare-gpu';button.className='secondary-btn';button.style.marginLeft='8px';$('#install-runtime').after(button);button.onclick=()=>safely(()=>switchRuntime('vulkan'));}
  $('#prepare-gpu').textContent=gpu?'Graphics engine selected':'Use graphics acceleration';$('#prepare-gpu').disabled=!!gpu;
  if(!$('#gpu-engine-note')){const note=document.createElement('div');note.className='info-note';note.id='gpu-engine-note';$('#hardware-info').after(note);}
  $('#gpu-engine-note').innerHTML=`<p>${gpu?'The graphics engine is ready. Choose how many layers to send to the GPU.':'The current engine uses the processor. Enable the graphics engine to use GPU layers.'} <button class="text-btn" id="show-runtime">View engine →</button></p>`;
  $('#show-runtime').onclick=()=>{showPage('models');$('.advanced').open=true;$('.advanced').scrollIntoView({behavior:'smooth'});};
}
async function switchRuntime(variant){
  if(busy)throw Error('Stop the reply before changing engines.');
  if(runtimeChanging)throw Error('An engine is already being set up. Wait for it to finish.');runtimeChanging=true;
  const button=variant==='vulkan'?$('#prepare-gpu'):$('#install-runtime');button.disabled=true;button.textContent='Setting up…';
  try{state.runtime=await api('installRuntime',{variant});const gpuLayers=variant==='vulkan'?(Number(state.settings.gpuLayers)||20):0;setSettings(await api('saveSettings',{settings:{gpuLayers}}));renderRuntime();toast(variant==='vulkan'?'Graphics engine ready. You can adjust its use in Performance.':'Processor engine ready.');}
  finally{runtimeChanging=false;renderRuntime();}
}
function formatBytes(value){if(!value)return 'Size not provided';const units=['B','KB','MB','GB'];let n=value,i=0;while(n>=1024&&i<3){n/=1024;i++;}return `${n.toFixed(i===3?2:0)} ${units[i]}`;}
function modal(title,html){$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){ $('#modal').close(); }
function linkModal(){modal('Add by link','<p class="modal-subtitle">Paste a Hugging Face link to a public model or .gguf file. No account needed.</p><label for="model-url">Model link</label><input class="modal-input" id="model-url" type="url" placeholder="https://huggingface.co/autor/modelo"><div class="modal-actions"><button class="secondary-btn" id="cancel-link">Back</button><button class="primary-btn" id="resolve-link">Continue</button></div>');$('#cancel-link').onclick=closeModal;$('#resolve-link').onclick=()=>safely(async()=>{const button=$('#resolve-link');button.disabled=true;button.textContent='Searching…';try{const result=await api('resolveModelLink',{url:$('#model-url').value.trim()});if(result.files)renderHfFiles(result);else await startDownload(result);}finally{if(button.isConnected){button.disabled=false;button.textContent='Continue';}}});$('#model-url').focus();}
function hfBrowser(){modal('Browse Hugging Face','<p class="modal-subtitle">Public models to run on your PC. Search by name and choose a GGUF file.</p><form class="search-bar" id="hf-search"><input class="search-input" id="hf-query" placeholder="Search models…" aria-label="Search Hugging Face models"><button class="primary-btn" type="submit">Search</button></form><div class="browser-breadcrumb"><button id="hf-site">Open the site inside Órbita ↗</button></div><div id="hf-results" class="hf-results"></div>');$('#hf-query').value=hfQuery;$('#hf-search').onsubmit=e=>{e.preventDefault();searchHf();};$('#hf-site').onclick=()=>safely(()=>api('openHuggingFace'));if(hfResults.length)showHfResults();else searchHf();}
async function searchHf(){const revision=++hfSearchRevision;try{const query=$('#hf-query').value.trim();hfQuery=query;$('#hf-results').textContent='Searching models…';const results=await api('searchHuggingFace',{query});if(revision!==hfSearchRevision)return;hfResults=results;if($('#hf-results'))showHfResults();}catch(error){if(revision!==hfSearchRevision)return;if($('#hf-results'))$('#hf-results').textContent='Search failed. Check your connection and try Search again.';toast(error.message,true);}}
function showHfResults(){const root=$('#hf-results');root.innerHTML='';if(!hfResults.length)root.innerHTML='<p class="modal-subtitle">No models found. Try another name.</p>';hfResults.forEach(item=>{const button=document.createElement('button');button.className='hf-result';button.innerHTML=`<span><strong>${esc(item.id)}</strong><small>${Number(item.downloads||0).toLocaleString('es-AR')} descargas</small></span>${icon('chevron')}`;button.onclick=()=>safely(async()=>{button.disabled=true;try{renderHfFiles(await api('getModelFiles',{repo:item.id}));}finally{button.disabled=false;}});root.append(button);});}
function renderHfFiles(result){modal('Choose a GGUF file',`<div class="browser-breadcrumb"><button id="hf-back">← Browse</button><span>${esc(result.repo)}</span></div><p class="modal-subtitle">Q4 usually uses less memory. Large models can be slower. Choose a file that fits your PC’s memory.</p><div class="hf-results" id="hf-files"></div>`);$('#hf-back').onclick=hfBrowser;
  if(!result.files.length)$('#hf-files').innerHTML='<div class="inline-error">This model has no compatible GGUF files. Look for a single-file GGUF version.</div>';
  result.files.forEach(file=>{const row=document.createElement('div');row.className='model-file';row.innerHTML=`<div class="model-file-name">${esc(file.name)}<small>${formatBytes(file.size)}</small></div>`;const button=document.createElement('button');button.className='secondary-btn';button.textContent='Download';button.onclick=()=>safely(()=>startDownload({url:file.url,name:file.name,size:file.size,sha256:file.sha256,repo:result.repo}));row.append(button);$('#hf-files').append(row);});
}
async function startDownload(data){if(downloadActive)throw Error('A download is already running. Wait for it to finish or cancel it.');closeModal();showPage('models');downloadActive=true;renderDownload({type:'download',name:data.name||'Modelo',received:0,total:data.size||0,status:'starting'});try{const result=await api('downloadModel',data);if(result){state.models=result.models;state.activeModel=result.activeModel;renderModels();}}catch(e){downloadActive=false;$('#download-panel').classList.add('hidden');throw e;}}
function renderDownload(data){const root=$('#download-panel');root.classList.remove('hidden');if(data.status==='done'){downloadActive=false;root.innerHTML=`<div class="download-title"><span>${esc(data.name)} está listo.</span>${icon('check')}</div>`;return;}if(data.status==='cancelled'||data.status==='error'){downloadActive=false;root.innerHTML=`<div>${esc(data.text||'Download cancelled. You can try again.')}</div>`;return;}downloadActive=true;const percent=data.total?Math.min(100,100*data.received/data.total):0;root.innerHTML=`<div class="download-title"><span>${esc(data.name||'Preparing download…')}</span><button class="text-btn" id="cancel-download">Cancel</button></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><div class="download-details"><span>${data.total?`${formatBytes(data.received)} de ${formatBytes(data.total)}`:'Connecting…'}</span><span>${data.total?Math.floor(percent)+'%':''}</span></div>`;$('#cancel-download').onclick=()=>safely(()=>api('cancelDownload'));}
async function chooseProject(){if(busy){toast('Stop the reply before changing folders.');return;}if(messageQueue.length){toast('Send or remove the queued messages first.');return;}if(window.orbitaWorkspace&&!await window.orbitaWorkspace.beforeProjectChange())return;const project=await api('chooseProject');if(project){state.project=project;renderProject();files=[];$('#file-filter').value='';if(currentChat&&(currentChat.projectPath||null)!==project.path){newChat();toast('New conversation for this folder.');}if(!$('#files-panel').classList.contains('hidden'))await refreshFiles();}}
function projectMenu(){window.orbitaWorkflow?.projectMenu();}
function renderProject(){$('#project-name').toggleAttribute('data-i18n-skip',!!state.project);$('#project-name').textContent=state.project?.name||'Open a folder';$('#choose-project').title=state.project?.path||'Choose a working folder';window.orbitaWorkspace?.projectChanged();}
async function refreshFiles(){if(!state.project){files=[];renderFiles();return;}files=await api('listProjectFiles');renderFiles();}
function renderFiles(){if(window.orbitaWorkspace){window.orbitaWorkspace.renderTree();return;}const query=$('#file-filter').value.toLowerCase(),visible=files.filter(f=>f.path.toLowerCase().includes(query));$('#file-list').innerHTML='';if(!visible.length)$('#file-list').innerHTML='<p class="file-empty">No files to show.</p>';visible.slice(0,1200).forEach(file=>{const button=document.createElement('button');button.className='file-row';button.innerHTML=icon('file')+esc(file.path);button.title=file.path;button.onclick=()=>safely(async()=>{const data=await api('readProjectFile',{path:file.path});modal(file.path,`<pre class="file-preview">${esc(data.content)}</pre>`);});$('#file-list').append(button);});}
async function toggleFiles(){const panel=$('#files-panel');panel.classList.toggle('hidden');if(!panel.classList.contains('hidden'))await refreshFiles();}
function modelPicker(){if(!state.models.length){showPage('models');return;}modal('Choose a model','<div id="picker-models"></div><div class="modal-actions"><button class="text-btn" id="manage-models">Manage models →</button></div>');state.models.forEach(m=>{const button=document.createElement('button');button.className='hf-result';button.innerHTML=`<span><strong>${esc(m.name)}</strong><small>${formatBytes(m.size)}</small></span>${m.id===state.activeModel?icon('check'):icon('chevron')}`;button.onclick=()=>safely(async()=>{if(busy)throw Error('Stop the reply before changing models.');await api('selectModel',{id:m.id});state.activeModel=m.id;renderModels();closeModal();});$('#picker-models').append(button);});$('#manage-models').onclick=()=>{closeModal();showPage('models');};}
function bindEvents(){
  $$('.nav-item[data-page]').forEach(button=>button.onclick=()=>showPage(button.dataset.page));$('#new-chat').onclick=newChat;
  $('#send').onclick=sendMessage;$('#prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}};$('#prompt').oninput=()=>{$('#prompt').style.height='auto';$('#prompt').style.height=Math.min(200,$('#prompt').scrollHeight)+'px';};
  $$('[data-prompt]').forEach(button=>button.onclick=()=>{$('#prompt').value=button.dataset.prompt;$('#prompt').focus();});
  $('#choose-project').onclick=projectMenu;$('#attach-project').onclick=()=>window.orbitaWorkflow?.attachMenu();$('#toggle-files').onclick=()=>safely(toggleFiles);$('#close-files').onclick=()=>$('#files-panel').classList.add('hidden');$('#refresh-files').onclick=()=>safely(refreshFiles);$('#file-filter').oninput=()=>{clearTimeout(fileSearchTimer);fileSearchTimer=setTimeout(renderFiles,100);};
  $('#stop-response').onclick=stopResponse;
  $('#model-status').onclick=$('#composer-model').onclick=modelPicker;
  $('#source-hf').onclick=hfBrowser;$('#source-link').onclick=linkModal;$('#source-local').onclick=()=>safely(async()=>{const result=await api('importLocalModel');if(result){state.models=result.models;state.activeModel=result.activeModel;renderModels();toast('Model added. The file stays in its original folder.');}});
  $('#modal-close').onclick=closeModal;$('#modal').onclick=e=>{if(e.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};
  $$('[data-settings]').forEach(button=>button.onclick=()=>{$$('[data-settings]').forEach(el=>el.classList.toggle('active',el===button));$$('.settings-panel').forEach(el=>el.classList.toggle('active',el.id===`settings-${button.dataset.settings}`));});
  $$('[data-setting]').forEach(el=>{if(el.tagName==='TEXTAREA')el.maxLength=16000;el.addEventListener(el.type==='range'||el.type==='color'||el.tagName==='TEXTAREA'?'input':'change',()=>{const numeric=['fontSize','radius','chatWidth','context','threads','gpuLayers','maxTokens','temperature','maxSteps'];if(numeric.includes(el.dataset.setting)&&!el.checkValidity()){toast('Ese valor está fuera del rango permitido. Elegí uno entre '+el.min+' y '+el.max+'.',true);return;}let v=el.type==='checkbox'?el.checked:numeric.includes(el.dataset.setting)?Number(el.value):el.value;saveSettings(el.dataset.setting,v);});});
  $$('[data-accent]').forEach(button=>button.onclick=()=>saveSettings('accent',button.dataset.accent));$('#menu-toggle').onclick=()=>$('#sidebar').classList.toggle('open');
  $('#install-runtime').onclick=()=>safely(()=>switchRuntime('cpu'));
  $('#choose-runtime').onclick=()=>safely(async()=>{const runtime=await api('chooseRuntime');if(runtime){state.runtime=runtime;renderRuntime();}});
  $('#open-data').onclick=()=>safely(()=>api('openDataFolder'));$('#export-chat').onclick=()=>safely(async()=>{if(!currentChat)throw Error('Open a conversation before exporting it.');const result=await api('exportChat',{id:currentChat.id});if(result)toast('Conversation exported.');});
  $('#reset-settings').onclick=()=>{modal('Reset settings','<p class="modal-subtitle">Returns to the dark theme and initial settings. Your models and conversations are kept.</p><div class="modal-actions"><button class="secondary-btn" id="cancel-reset">Back</button><button class="primary-btn" id="confirm-reset">Reset</button></div>');$('#cancel-reset').onclick=closeModal;$('#confirm-reset').onclick=()=>safely(async()=>{clearTimeout(saveTimer);settingsRevision++;setSettings(await api('resetSettings'));closeModal();toast('Settings reset.');});};
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();newChat();}if(e.key==='Escape'&&busy&&!$('#modal').open)stopResponse();});
}
async function init(){bindEvents();if(window.orbita)window.orbita.onEvent(receive);await safely(async()=>{state=await api('init');setSettings(state.settings);renderModels();renderHistory();renderProject();$('#data-path').textContent=state.dataPath||'';$('#hardware-info').innerHTML=`<strong data-i18n-skip>${esc(state.hardware.cpu||'Local processor')}</strong><br>${esc(state.hardware.ramGB||'?')} GB de RAM · ${esc(state.hardware.threads||'?')} hilos disponibles`;window.orbitaWorkspace?.initState(state);if(state.chats.length&&state.lastChatId)await openChat(state.lastChatId);window.orbitaWorkflow?.init(state);window.orbitaI18n?.init(state.settings.language);});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
