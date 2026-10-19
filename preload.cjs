const {contextBridge,ipcRenderer}=require('electron');
const actions=new Set(['init','saveSettings','resetSettings','copyText','chooseProject','clearProject','listProjectFiles','readProjectFile','saveProjectFile','getChat','deleteChat','sendMessage','stop','approveTool','restoreChange','importLocalModel','selectModel','removeModel','searchHuggingFace','getModelFiles','resolveModelLink','downloadModel','cancelDownload','installRuntime','chooseRuntime','openHuggingFace','openDataFolder','exportChat','listTerminals','terminalStart','terminalInput','terminalStop','searchWeb','readWebPage','openLocalFile','openProjectFile','revealProject','packProject','listMemories','saveMemory','deleteMemory','voiceStatus','prepareVoice','transcribeAudio','cancelVoice']);
contextBridge.exposeInMainWorld('orbita',{
 call:(name,data={})=>{if(!actions.has(name))return Promise.reject(new Error('Esa acción no está disponible.'));return ipcRenderer.invoke('orbita:'+name,data);},
 onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('orbita:event',listener);return()=>ipcRenderer.removeListener('orbita:event',listener);}
});
