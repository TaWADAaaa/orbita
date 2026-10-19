'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,Menu,session,clipboard}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {ModelEngine}=require('./runtime.cjs');
const {Backend}=require('./backend.cjs');
const {TerminalManager}=require('./terminal.cjs');
const {NetworkTools}=require('./network.cjs');
const {SpeechService}=require('./speech.cjs');
const {desktopTools}=require('./desktop.cjs');
app.setName('Órbita');
app.setPath('userData',process.env.ORBITA_TEST_PROFILE?path.resolve(process.env.ORBITA_TEST_PROFILE):path.join(app.getPath('appData'),'Orbita Local'));
app.setAppUserModelId('local.orbita.desktop');
let window,backend,engine,terminals,web,speech,desktop,hfWindow,projectWatcher,quitting=false;
const entry=path.join(__dirname,'ui','index.html');
const dataDir=app.getPath('userData');
function emit(data){if(data.type==='projectChanged')watchProject();if(window&&!window.isDestroyed())window.webContents.send('orbita:event',data);}
function tr(es,en){return backend?.settings?.language==='es'?es:en;}
function busyGuard(){if(backend?.busy)throw Error(tr('Detené la respuesta antes de hacer este cambio.','Stop the response before making this change.'));}
function watchProject(){
 projectWatcher?.close();projectWatcher=null;if(!backend.project)return;const projectPath=backend.project.path;
 try{projectWatcher=require('node:fs').watch(projectPath,{recursive:true},(_kind,name)=>{if(backend.project?.path!==projectPath)return;const relative=String(name||'').replace(/\\/g,'/');if(relative.split('/').some(part=>['.git','node_modules','.venv','venv','__pycache__','.ssh','.aws'].includes(part)||/^\.env(?:\.|$)/i.test(part)||part.startsWith('.orbita-tmp-')))return;emit({type:'filesChanged',path:relative||null,source:'disk'});});projectWatcher.on('error',()=>{projectWatcher?.close();projectWatcher=null;});}catch{emit({type:'error',text:'No se pudo actualizar la carpeta en vivo. Podés usar Actualizar en Archivos.'});}
}
function hfURL(raw){try{const url=new URL(raw);return url.protocol==='https:'&&url.hostname==='huggingface.co'&&!/^\/(login|join|settings|oauth|organizations\/new)(\/|$)/.test(url.pathname);}catch{return false;}}
function openHuggingFace(){
 if(hfWindow&&!hfWindow.isDestroyed()){hfWindow.focus();return true;}
 const partition='orbita-hf-browser',browserSession=session.fromPartition(partition);
 browserSession.setPermissionRequestHandler((_wc,_permission,done)=>done(false));browserSession.setPermissionCheckHandler(()=>false);
 hfWindow=new BrowserWindow({parent:window,width:1100,height:810,title:'Hugging Face · Órbita',backgroundColor:'#151517',autoHideMenuBar:true,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false,spellcheck:false}});
 hfWindow.webContents.on('will-navigate',(event,url)=>{if(!hfURL(url)){event.preventDefault();emit({type:'error',text:'El explorador abre modelos públicos de Hugging Face. Usá un modelo que no pida una cuenta.'});}});
 hfWindow.webContents.setWindowOpenHandler(({url})=>{if(hfURL(url))hfWindow.loadURL(url);return{action:'deny'};});
 const onDownload=(event,item)=>{event.preventDefault();const url=item.getURLChain().find(value=>{try{const parsed=new URL(value);return parsed.hostname==='huggingface.co'&&parsed.pathname.includes('/resolve/');}catch{return false;}})||item.getURL();if(!/\.gguf(?:\?|$)/i.test(url)){emit({type:'error',text:'Elegí un archivo GGUF de una sola pieza para usarlo en Órbita.'});return;}emit({type:'navigate',page:'models'});engine.download({url,name:item.getFilename()}).catch(e=>emit({type:'error',text:e.message}));window.focus();};
 browserSession.on('will-download',onDownload);hfWindow.on('closed',()=>{browserSession.removeListener('will-download',onDownload);hfWindow=null;});
 hfWindow.loadURL('https://huggingface.co/models?library=gguf&sort=downloads');return true;
}
async function selectDialog(options){const result=await dialog.showOpenDialog(window,options);return result.canceled?null:result.filePaths[0];}
function bindIPC(){
 const handlers={
  init:async()=>({...await backend.init(),terminals:terminals.list()}),
  saveSettings:data=>backend.saveSettings(data),resetSettings:()=>backend.resetSettings(),
  copyText:async({text})=>{if(typeof text!=='string'||text.length>1048576)throw Error(tr('No se pudo copiar ese texto.','That text could not be copied.'));await clipboard.writeText(text);return true;},
  chooseProject:async()=>{busyGuard();const selected=await selectDialog({title:tr('Elegí la carpeta de tu proyecto','Choose your project folder'),properties:['openDirectory']});if(!selected)return null;const project=await backend.setProject(selected);watchProject();return project;},
  openLocalFile:async()=>{busyGuard();const selected=await selectDialog({title:tr('Elegí un archivo','Choose a file'),properties:['openFile']});if(!selected)return null;const oldProject=backend.project?{...backend.project}:null;try{const project=await backend.setProject(path.dirname(selected)),file=await backend.readProjectFile({path:path.basename(selected)});watchProject();return{project,file:{...file,path:path.basename(selected)}};}catch(error){if(oldProject)await backend.setProject(oldProject.path);else await backend.clearProject();watchProject();throw error;}},
  openProjectFile:async({path:relative})=>{const info=await backend._resolve(relative);return desktop.openPath(info.absolute);},
  revealProject:async()=>desktop.openPath(await backend._root()),
  packProject:data=>backend.packProject(data),
  listMemories:()=>backend.listMemories(),saveMemory:data=>backend.saveMemory(data),deleteMemory:data=>backend.deleteMemory(data),
  clearProject:async()=>{const result=await backend.clearProject();watchProject();return result;},listProjectFiles:()=>backend.listProjectFiles({includeDirectories:true}),readProjectFile:data=>backend.readProjectFile(data),saveProjectFile:data=>backend.saveProjectFile(data),
  getChat:async data=>{const chat=await backend.getChat({...data,activateProject:true});watchProject();return chat;},deleteChat:data=>backend.deleteChat(data),
  sendMessage:data=>backend.sendMessage(data),stop:()=>backend.stop(),approveTool:data=>backend.approveTool(data),restoreChange:data=>backend.restoreChange(data),
  importLocalModel:async()=>{busyGuard();const selected=await selectDialog({title:tr('Elegí un modelo GGUF','Choose a GGUF model'),properties:['openFile'],filters:[{name:tr('Modelo local GGUF','Local GGUF model'),extensions:['gguf']}]});return selected?engine.importLocal(selected):null;},
  selectModel:async({id})=>{busyGuard();return engine.select(id);},removeModel:async({id})=>{busyGuard();return engine.remove(id);},
  searchHuggingFace:({query})=>engine.search(query),getModelFiles:({repo})=>engine.getFiles(repo),resolveModelLink:({url})=>engine.resolve(url),
  downloadModel:data=>engine.download(data),cancelDownload:()=>engine.cancelDownload(),
  installRuntime:data=>{busyGuard();return engine.installRuntime(data);},chooseRuntime:async()=>{busyGuard();const selected=await selectDialog({title:tr('Elegí el motor llama-server.exe','Choose the llama-server.exe engine'),properties:['openFile'],filters:[{name:tr('Motor llama.cpp','llama.cpp engine'),extensions:['exe']}]});return selected?engine.setRuntime(selected):null;},
  openHuggingFace,
  listTerminals:()=>terminals.list(),terminalStart:async({command})=>terminals.start({command,cwd:await backend._root(),origin:'user'}),terminalInput:data=>terminals.input(data),terminalStop:data=>terminals.stop(data),
  searchWeb:data=>web.search(data),readWebPage:data=>web.fetchPage(data),
  voiceStatus:()=>speech.status(),prepareVoice:()=>speech.prepare(),transcribeAudio:data=>speech.transcribe(data),cancelVoice:()=>speech.cancel(),
  openDataFolder:async()=>{await shell.openPath(dataDir);return true;},
  exportChat:async({id})=>{const chat=await backend.getChat({id});const selected=await dialog.showSaveDialog(window,{title:tr('Exportar conversación','Export chat'),defaultPath:(chat.title||tr('Conversación','Chat')).replace(/[<>:"/\\|?*]/g,'').slice(0,90)+'.md',filters:[{name:'Markdown',extensions:['md']}]});if(selected.canceled)return false;let text=`# ${chat.title||tr('Conversación','Chat')}\n\n`;for(const msg of chat.messages){if(['user','assistant'].includes(msg.role))text+=`## ${msg.role==='user'?tr('Vos','You'):'Órbita'}\n\n${msg.content}\n\n`;}await fs.writeFile(selected.filePath,text,'utf8');return true;}
 };
 for(const[name,handler]of Object.entries(handlers))ipcMain.handle('orbita:'+name,async(event,data)=>{
  if(event.sender!==window?.webContents||event.senderFrame?.url!==pathToFileURL(entry).href)return {error:'Esta acción solo está disponible dentro de Órbita.'};
  try{return await handler(data||{});}catch(err){await fs.appendFile(path.join(dataDir,'app.log'),new Date().toISOString()+' '+name+': '+err.message+'\n').catch(()=>{});return{error:err.message||'No se pudo completar. Probá otra vez.'};}
 });
}
function createWindow(){
 window=new BrowserWindow({width:1320,height:900,minWidth:760,minHeight:640,backgroundColor:'#151517',title:'Órbita',show:false,autoHideMenuBar:true,icon:path.join(__dirname,'orbita.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webviewTag:false,spellcheck:false}});
 window.setMenu(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(entry).href)event.preventDefault();});
 const trustedFrame=(wc,details)=>wc===window?.webContents&&wc.getURL()===pathToFileURL(entry).href&&details?.isMainFrame!==false&&(!details?.requestingUrl||details.requestingUrl===pathToFileURL(entry).href);
 const trustedAudio=(wc,permission,details)=>trustedFrame(wc,details)&&permission==='media'&&Array.isArray(details?.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio');
 window.webContents.session.setPermissionRequestHandler((wc,permission,done,details)=>done(trustedAudio(wc,permission,details)));window.webContents.session.setPermissionCheckHandler((wc,permission,_origin,details)=>trustedFrame(wc,details)&&permission==='media'&&details?.mediaType==='audio');
 window.webContents.on('will-prevent-unload',event=>{const answer=dialog.showMessageBoxSync(window,{type:'question',title:tr('Cambio sin guardar','Unsaved changes'),message:tr('Tenés un archivo con cambios sin guardar.','You have a file with unsaved changes.'),detail:tr('Volvé para guardarlo, o salí y descartá esa edición.','Go back to save it, or exit and discard the changes.'),buttons:[tr('Volver','Go back'),tr('Salir sin guardar','Exit without saving')],defaultId:0,cancelId:0,noLink:true});if(answer===1)event.preventDefault();});
 window.webContents.on('context-menu',(_event,params)=>{const template=params.isEditable?[{role:'undo',label:tr('Deshacer','Undo')},{role:'redo',label:tr('Rehacer','Redo')},{type:'separator'},{role:'cut',label:tr('Cortar','Cut')},{role:'copy',label:tr('Copiar','Copy')},{role:'paste',label:tr('Pegar','Paste')},{type:'separator'},{role:'selectAll',label:tr('Seleccionar todo','Select all')}]:params.selectionText?[{role:'copy',label:tr('Copiar','Copy')}]:[];if(template.length)Menu.buildFromTemplate(template).popup({window});});
 window.once('ready-to-show',()=>window.show());window.loadFile(entry);
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.whenReady().then(async()=>{
  await fs.mkdir(dataDir,{recursive:true});
  engine=new ModelEngine({dataDir,emit,getSettings:()=>backend?.job?.settings||backend?.settings||{context:4096,threads:8,gpuLayers:0,maxTokens:2048,temperature:.3,keepLoaded:true}});
  const terminalPathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')||'Path';
  terminals=new TerminalManager({emit,env:{[terminalPathKey]:path.join(__dirname,'.runtime','bin')+path.delimiter+(process.env[terminalPathKey]||'')}});web=new NetworkTools();desktop=desktopTools(shell,{getLanguage:()=>backend?.settings?.language||'en'});speech=new SpeechService({dataDir,emit,getLanguage:()=>backend?.settings?.language||'en'});backend=new Backend({dataDir,emit,engine,terminals,web,desktop});await engine.init();await backend.init();watchProject();bindIPC();Menu.setApplicationMenu(null);createWindow();
 }).catch(err=>{dialog.showErrorBox('Órbita could not open',err.message+'\nOpen Órbita again using its launcher.');app.quit();});
 app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;projectWatcher?.close();Promise.resolve(speech?.dispose()).catch(()=>{}).then(()=>backend?.dispose()).catch(()=>{}).then(()=>terminals?.dispose()).catch(()=>{}).then(()=>engine?.dispose()).catch(()=>{}).finally(()=>app.quit());});
 app.on('window-all-closed',()=>app.quit());
}
