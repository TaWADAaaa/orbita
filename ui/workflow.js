'use strict';
(() => {
  let memories=[],voicePhase='idle',voiceEpoch=0,audioContext=null,audioStream=null,audioSource=null,audioProcessor=null,audioMute=null,audioChunks=[],audioSamples=0,audioRate=16000,voiceTimer=null,voiceStarted=0;
  function attachMenu(){modal('Open',`<div class="simple-actions"><button class="secondary-btn" id="attach-folder">${icon('folder')}<span>Open folder</span></button><button class="secondary-btn" id="attach-file">${icon('file')}<span>Open file</span></button></div>`);$('#attach-folder').onclick=()=>safely(async()=>{closeModal();await chooseProject();});$('#attach-file').onclick=()=>safely(async()=>{closeModal();await openLocalFile();});}
  async function openLocalFile(){
    if(busy||messageQueue.length){toast('Wait for the task and queue to finish before opening another file.');return;}
    if(!await window.orbitaWorkspace.beforeProjectChange())return;
    const result=await api('openLocalFile');if(!result)return;state.project=result.project;newChat();renderProject();await refreshFiles();window.orbitaWorkspace.showPanel('files');if(result.file?.path)await window.orbitaWorkspace.openEditor(result.file.path);
  }
  function projectMenu(){
    if(!state.project)return attachMenu();
    modal('Working folder',`<p class="modal-subtitle" data-i18n-skip>${esc(state.project.path)}</p><div class="simple-actions"><button class="secondary-btn" id="reveal-project">${icon('folder')}<span>Open in File Explorer</span></button><button class="secondary-btn" id="package-project">${icon('box')}<span>Package as ZIP</span></button><button class="secondary-btn" id="change-project">${icon('folder')}<span>Choose another folder</span></button><button class="text-btn" id="clear-project">Close folder</button></div>`);
    $('#reveal-project').onclick=()=>safely(()=>api('revealProject'));
    $('#package-project').onclick=()=>safely(async()=>{if(busy)throw Error('Wait for the task to finish before packaging.');const button=$('#package-project');if(window.orbitaWorkspace.hasUnsaved()){const selected=$('#editor-name').textContent;if(!await window.orbitaWorkspace.beforeProjectChange())return;await window.orbitaWorkspace.openEditor(selected);}button.disabled=true;try{await api('packProject',{path:(state.project.name||'proyecto')+'.zip'});closeModal();await refreshFiles();toast('ZIP saved in your folder.');window.orbitaWorkspace.showPanel('files');}finally{if(button.isConnected)button.disabled=false;}});
    $('#change-project').onclick=()=>safely(async()=>{closeModal();await chooseProject();});
    $('#clear-project').onclick=()=>safely(async()=>{if(busy||messageQueue.length)throw Error('Wait for the task and queue to finish before closing the folder.');if(!await window.orbitaWorkspace.beforeProjectChange())return;await api('clearProject');state.project=null;renderProject();closeModal();newChat();});
  }
  function renderMemories(){
    const root=$('#memory-list');if(!root)return;root.replaceChildren();if(!memories.length){const empty=document.createElement('div');empty.className='memory-empty';empty.textContent=t('No memories yet.');root.append(empty);}
    memories.forEach(memory=>{const row=document.createElement('div');row.className='memory-item';const text=document.createElement('p');text.dataset.i18nSkip='';text.textContent=memory.content;const edit=document.createElement('button');edit.className='text-btn';edit.textContent=t('Edit');edit.onclick=()=>{const input=$('#memory-input');input.value=memory.content;input.dataset.id=memory.id;input.focus();};const remove=document.createElement('button');remove.className='icon-btn';remove.title=t('Delete memory');remove.innerHTML=icon('close');remove.onclick=()=>safely(async()=>{const result=await api('deleteMemory',{id:memory.id});memories=Array.isArray(result)?result:result.memories||[];if($('#memory-input').dataset.id===memory.id){$('#memory-input').value='';delete $('#memory-input').dataset.id;}renderMemories();});row.append(text,edit,remove);root.append(row);});
  }
  function supportUI(){
    const section=document.createElement('details');section.className='support-section';
    section.innerHTML='<summary>Support Órbita</summary><p>Donations are optional.</p><button type="button" class="secondary-btn" id="show-donations">Donations</button>';
    $('#settings-data .setting-section').append(section);
    $('#show-donations').onclick=()=>{
      const wallets=[
        {name:'BTC',network:'Bitcoin · mainnet',address:'bc1qt696cljgmhhwswdt2ulpwpmzdnc5fhuw4k8lz5'},
        {name:'SOL',network:'Solana · mainnet',address:'3jmHYhw4iNcqSLvb5GxwDZev2qNx853TESEYYeEj3NYx'},
        {name:'USDT',network:'USDT · BNB Chain (BEP-20)',address:'0x5D7c7e1055C2381a402b9e7F73d2cFa78f23c0F5'}
      ];
      modal('Support Órbita',`<p class="modal-subtitle">Use only the network shown for each address.</p><div class="donation-list">${wallets.map((wallet,index)=>`<section class="donation-wallet"><div class="donation-heading"><strong data-i18n-skip>${wallet.name}</strong><span>${wallet.network}</span></div><code data-i18n-skip>${wallet.address}</code><button type="button" class="secondary-btn donation-copy" data-wallet="${index}">Copy address</button></section>`).join('')}</div>`);
      $$('.donation-copy').forEach(button=>button.onclick=()=>safely(async()=>{await api('copyText',{text:wallets[Number(button.dataset.wallet)].address});toast('Address copied.');}));
    };
  }
  function memoryUI(){
    const section=document.createElement('details');section.id='memory-section';section.className='memory-section';section.innerHTML='<summary>Memory</summary><p>It can remember things you ask it to keep between conversations. You can review, edit or delete those memories here.</p><div id="memory-list"></div><form id="memory-form" class="memory-form"><textarea id="memory-input" class="setting-textarea" maxlength="2000" placeholder="Something you want it to remember…" aria-label="New memory"></textarea><button class="secondary-btn" type="submit">Save memory</button></form>';$('#settings-behavior .setting-section').append(section);
    $('#memory-form').onsubmit=event=>{event.preventDefault();safely(async()=>{const input=$('#memory-input'),content=input.value.trim();if(!content)return;const result=await api('saveMemory',{id:input.dataset.id||undefined,content});memories=Array.isArray(result)?result:result.memories||await api('listMemories');input.value='';delete input.dataset.id;renderMemories();});};renderMemories();
  }
  function voiceUI(phase,text){voicePhase=phase;const visible=phase!=='idle';$('#voice-strip').classList.toggle('hidden',!visible);$('#voice-strip').classList.toggle('recording',phase==='recording');$('#voice-status').textContent=t(text||'');$('#voice-finish').classList.toggle('hidden',phase!=='recording');$('#dictate').classList.toggle('recording',phase==='recording');$('#dictate').title=t(phase==='recording'?'Finish dictation':'Dictate a message');$('#dictate').disabled=visible&&phase!=='recording';}
  async function releaseAudio(){clearInterval(voiceTimer);voiceTimer=null;if(audioProcessor){audioProcessor.onaudioprocess=null;audioProcessor.disconnect();audioProcessor=null;}audioSource?.disconnect();audioMute?.disconnect();audioStream?.getTracks().forEach(track=>track.stop());audioStream=null;audioSource=null;audioMute=null;if(audioContext){await audioContext.close().catch(()=>{});audioContext=null;}}
  function makeWav(chunks,sampleCount,sampleRate){
    const source=new Float32Array(sampleCount);let cursor=0;for(const chunk of chunks){source.set(chunk,cursor);cursor+=chunk.length;}const length=Math.floor(sampleCount*16000/sampleRate);const wav=new Uint8Array(44+length*2),view=new DataView(wav.buffer);const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,36+length*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,length*2,true);
    for(let i=0;i<length;i++){const position=i*sampleRate/16000,index=Math.floor(position),fraction=position-index;const sample=Math.max(-1,Math.min(1,(source[index]||0)*(1-fraction)+(source[index+1]||0)*fraction));view.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true);}return wav;
  }
  async function startVoice(){
    if(voicePhase==='recording')return finishVoice();if(voicePhase!=='idle')return;const epoch=++voiceEpoch;
    try{voiceUI('preparing','Preparing dictation…');const status=await api('voiceStatus');if(!status.ready)await api('prepareVoice');if(epoch!==voiceEpoch)return;
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});if(epoch!==voiceEpoch){stream.getTracks().forEach(track=>track.stop());return;}audioStream=stream;const context=new AudioContext({sampleRate:16000});audioContext=context;await context.resume();if(epoch!==voiceEpoch)return;audioRate=context.sampleRate;audioSource=context.createMediaStreamSource(audioStream);audioProcessor=context.createScriptProcessor(4096,1,1);audioMute=context.createGain();audioMute.gain.value=0;audioChunks=[];audioSamples=0;
      audioProcessor.onaudioprocess=event=>{if(voicePhase!=='recording')return;const remaining=Math.max(0,Math.floor(audioRate*120)-audioSamples),chunk=new Float32Array(event.inputBuffer.getChannelData(0).subarray(0,remaining));if(chunk.length){audioChunks.push(chunk);audioSamples+=chunk.length;}if(audioSamples>=audioRate*120)finishVoice();};audioSource.connect(audioProcessor);audioProcessor.connect(audioMute);audioMute.connect(audioContext.destination);voiceStarted=Date.now();voiceUI('recording','Listening…');voiceTimer=setInterval(()=>{$('#voice-status').textContent=t('Listening…')+` ${Math.floor((Date.now()-voiceStarted)/1000)} s`;if(Date.now()-voiceStarted>=120000)finishVoice();},1000);
    }catch(error){if(epoch!==voiceEpoch)return;await releaseAudio();voiceUI('idle');toast(error.name==='NotAllowedError'?'The microphone is blocked. Allow access in Windows and try again.':error.name==='NotFoundError'?'No microphone found. Connect one and try again.':error.message||'Dictation could not start.',true);}
  }
  async function finishVoice(){
    if(voicePhase!=='recording')return;const epoch=voiceEpoch;voiceUI('transcribing','Transcribing…');const chunks=audioChunks,samples=audioSamples,rate=audioRate;audioChunks=[];audioSamples=0;await releaseAudio();if(epoch!==voiceEpoch)return;
    try{if(samples<rate*.25)throw Error('Speak a little longer before finishing dictation.');const result=await api('transcribeAudio',{audio:makeWav(chunks,samples,rate),language:state.settings.language||'en'});if(epoch!==voiceEpoch)return;const text=result.text?.trim();if(!text)throw Error('No words were heard. Try moving closer to the microphone.');const input=$('#prompt'),position=input.selectionStart;const prefix=position&& !/\s/.test(input.value[position-1])?' ':'';input.setRangeText(prefix+text,position,position,'end');input.dispatchEvent(new Event('input'));input.focus();}catch(error){if(epoch===voiceEpoch)toast(error.message,true);}finally{if(epoch===voiceEpoch)voiceUI('idle');}
  }
  async function cancelVoice(){voiceEpoch++;await releaseAudio();audioChunks=[];audioSamples=0;voiceUI('idle');await api('cancelVoice').catch(()=>{});}
  function receive(event){if(event.type==='memoryChanged'){memories=event.memories||[];renderMemories();return true;}if(event.type==='voice'){if(voicePhase==='preparing'&&['preparing','progress'].includes(event.phase))$('#voice-status').textContent=t('Preparing dictation…')+(Number.isFinite(event.percent)?` ${Math.floor(event.percent)}%`:'');return true;}return false;}
  function init(data){
    memories=data.memories||[];renderMemories();try{const saved=JSON.parse(sessionStorage.getItem('orbita.queue')||'null');if(saved&&saved.chatId===(currentChat?.id||null)&&Array.isArray(saved.items)){messageQueue=saved.items.filter(item=>typeof item?.text==='string'&&item.text.trim()).slice(0,20);queuePaused=true;renderQueue();}}catch{};
  }
  function setup(){
    $('[data-setting="defaultMode"]')?.closest('.setting-row').remove();memoryUI();supportUI();$('#dictate').onclick=()=>safely(startVoice);$('#voice-finish').onclick=()=>safely(finishVoice);$('#voice-cancel').onclick=()=>safely(cancelVoice);$('#prompt').addEventListener('focus',()=>{if(window.innerWidth<=1100)window.orbitaWorkspace.hidePanel();});
    const open=document.createElement('button');open.className='icon-btn editor-open-external';open.id='editor-open-external';open.title='Open with another app';open.innerHTML=icon('link');$('#editor-save').before(open);open.onclick=()=>safely(()=>api('openProjectFile',{path:$('#editor-name').textContent}));
    const choose=document.createElement('button');choose.id='workspace-open-file';choose.className='icon-btn';choose.title='Open file';choose.innerHTML=icon('file');$('#refresh-files').before(choose);choose.onclick=()=>safely(openLocalFile);
    window.addEventListener('orbita-language',event=>{if(event.detail?.settings)setSettings(event.detail.settings);});window.addEventListener('beforeunload',()=>{audioStream?.getTracks().forEach(track=>track.stop());persistQueue();});
    window.orbitaWorkflow={attachMenu,projectMenu,init,receive,makeWav};
  }
  setup();
})();
