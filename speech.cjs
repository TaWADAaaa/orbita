'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const {spawn}=require('node:child_process');

// Pinned upstream releases; downloads are verified before anything is executed.
const ASSETS=Object.freeze({
 runtime:{url:'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip',size:3968674,sha256:'d824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d'},
 model:{url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin',size:77691713,sha256:'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'}
});
const MAX_AUDIO=44+16000*2*120;
function audioBuffer(audio){
 let bytes;
 if(audio instanceof ArrayBuffer)bytes=Buffer.from(audio);else if(ArrayBuffer.isView(audio))bytes=Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength);else throw Error('El audio no llegó bien. Grabá otra vez.');
 if(bytes.length<44||bytes.length>MAX_AUDIO||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('Grabá hasta dos minutos e intentá otra vez.');
 let format,data;let offset=12;
 while(offset+8<=bytes.length){const id=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4);offset+=8;if(size>bytes.length-offset)throw Error('El audio está incompleto. Grabá otra vez.');if(id==='fmt '){if(size<16)throw Error('El audio no tiene un formato válido.');format={pcm:bytes.readUInt16LE(offset),channels:bytes.readUInt16LE(offset+2),rate:bytes.readUInt32LE(offset+4),bits:bytes.readUInt16LE(offset+14)};}if(id==='data')data=bytes.subarray(offset,offset+size);offset+=size+(size%2);}
 if(!format||format.pcm!==1||format.channels!==1||format.rate!==16000||format.bits!==16||!data?.length||data.length%2)throw Error('Grabá otra vez con el micrófono de Órbita.');
 return {bytes,data,duration:data.length/32000};
}
function run(executable,args,{cwd,env,signal,timeout=180000,onData}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Error('Cancelado.'));return;}
  const child=spawn(executable,args,{cwd,env:env||process.env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});let output='',settled=false;
  const finish=(err)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(output);};
  const abort=()=>{child.kill();finish(Error('Cancelado.'));};
  const timer=setTimeout(()=>{child.kill();finish(Error('La transcripción tardó demasiado. Probá con un audio más corto.'));},timeout);timer.unref?.();
  signal?.addEventListener('abort',abort,{once:true});
  const data=chunk=>{const text=chunk.toString('utf8');output=(output+text).slice(-32000);onData?.(text);};child.stdout.on('data',data);child.stderr.on('data',data);
  child.once('error',finish);child.once('close',code=>finish(code===0?null:Error('No se pudo convertir la voz en texto. Probá otra vez.')));
 });
}
class SpeechService{
 constructor({dataDir,emit=()=>{},getLanguage=()=> 'en',fetchImpl=globalThis.fetch}){this.dir=path.join(dataDir,'speech');this.emit=emit;this.getLanguage=getLanguage;this.fetch=fetchImpl;this.phase='idle';this.percent=0;this.operation=null;this.controller=null;this.transcriptionPending=false;this.cancelEpoch=0;this.model=path.join(this.dir,'ggml-tiny.bin');this.exe=path.join(this.dir,'runtime','Release','whisper-cli.exe');}
 _event(phase,extra={}){this.phase=phase;if(extra.percent!==undefined)this.percent=extra.percent;this.emit({type:'voice',phase,...extra});}
 async status(){const ready=await Promise.all([fs.stat(this.exe).then(s=>s.isFile()),fs.stat(this.model).then(s=>s.isFile()&&s.size===ASSETS.model.size)]).then(v=>v.every(Boolean)).catch(()=>false);return{ready,busy:!!this.operation||this.transcriptionPending,phase:this.phase,percent:this.percent};}
 async _download(asset,target,signal,base,weight){
  signal=AbortSignal.any([signal,AbortSignal.timeout(300000)]);
  const partial=target+'.part';await fs.rm(partial,{force:true});let handle;
  try{
   let url=asset.url,response;
   for(let i=0;i<8;i++){const parsed=new URL(url);if(parsed.protocol!=='https:'||!['github.com','huggingface.co'].includes(parsed.hostname)&&!['.githubusercontent.com','.hf.co'].some(suffix=>parsed.hostname.endsWith(suffix)))throw Error('La descarga no pudo verificarse.');response=await this.fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'Orbita/0.3'}});if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('No se pudo descargar el dictado.');url=new URL(next,url).href;continue;}break;}
   if(!response?.ok||!response.body)throw Error('No se pudo descargar el dictado. Revisá internet y probá otra vez.');
   const expected=Number(response.headers.get('content-length'));if(expected&&expected!==asset.size)throw Error('La descarga no coincide con el archivo esperado.');
   handle=await fs.open(partial,'wx');const hash=crypto.createHash('sha256');let size=0,last=-1;
   for await(const chunk of response.body){if(signal.aborted)throw Error('Cancelado.');size+=chunk.length;if(size>asset.size)throw Error('La descarga es más grande de lo esperado.');hash.update(chunk);await handle.writeFile(chunk);const percent=Math.floor(base+size/asset.size*weight);if(percent!==last){last=percent;this._event('preparing',{percent});}}
   await handle.close();handle=null;if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('La descarga está incompleta. Probá otra vez.');await fs.rename(partial,target);
  }finally{await handle?.close().catch(()=>{});await fs.rm(partial,{force:true}).catch(()=>{});}
 }
 async prepare(){
  if(this.operation)return this.operation;
  this.controller=new AbortController();const signal=this.controller.signal;
  this.operation=(async()=>{
   const status=await this.status();if(signal.aborted)throw Error('Cancelado.');
   if(status.ready){this._event('ready',{percent:100});return{ready:true,busy:false,phase:'ready',percent:100};}
   if(process.platform!=='win32'||process.arch!=='x64')throw Error('El dictado de esta versión necesita Windows de 64 bits.');
   await fs.mkdir(this.dir,{recursive:true});this._event('preparing',{percent:0});
   const archive=path.join(this.dir,'whisper-v1.8.3-x64.zip'),runtimeDir=path.join(this.dir,'runtime');
   if(!await fs.stat(this.exe).then(s=>s.isFile()).catch(()=>false)){
    await this._download(ASSETS.runtime,archive,signal,0,6);await fs.mkdir(runtimeDir,{recursive:true});
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    await run(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:ORBITA_SPEECH_ARCHIVE -DestinationPath $env:ORBITA_SPEECH_TARGET -Force"],{signal,env:{...process.env,ORBITA_SPEECH_ARCHIVE:archive,ORBITA_SPEECH_TARGET:runtimeDir},timeout:60000});
    await fs.rm(archive,{force:true});
   }
   if(!await fs.stat(this.model).then(s=>s.isFile()&&s.size===ASSETS.model.size).catch(()=>false))await this._download(ASSETS.model,this.model,signal,6,94);
   if(!(await this.status()).ready)throw Error('No se pudo preparar el dictado. Probá otra vez.');
   await fs.writeFile(path.join(this.dir,'sources.json'),JSON.stringify({runtime:ASSETS.runtime,model:ASSETS.model,installedAt:new Date().toISOString()},null,2),'utf8');this._event('ready',{percent:100});return{ready:true,busy:false,phase:'ready',percent:100};
  })().catch(error=>{this._event(signal.aborted?'idle':'error',{text:this._message(error.message)});throw Error(this._message(error.message));}).finally(()=>{this.operation=null;this.controller=null;});
  return this.operation;
 }
 _message(text){if(this.getLanguage()!=='en')return text;const map={'Cancelado.':'Cancelled.','El audio no llegó bien. Grabá otra vez.':'The recording did not arrive correctly. Please record it again.','Grabá hasta dos minutos e intentá otra vez.':'Record for up to two minutes and try again.','El audio está incompleto. Grabá otra vez.':'The recording is incomplete. Please record it again.','El audio no tiene un formato válido.':'The recording format could not be read.','Grabá otra vez con el micrófono de Órbita.':'Please record again using the microphone in Órbita.','El dictado de esta versión necesita Windows de 64 bits.':'Voice typing in this version requires 64-bit Windows.','La descarga no pudo verificarse.':'The download could not be verified. Please try again.','La descarga no coincide con el archivo esperado.':'The downloaded file could not be verified. Please try again.','La descarga es más grande de lo esperado.':'The downloaded file could not be verified. Please try again.','La descarga está incompleta. Probá otra vez.':'The download is incomplete. Please try again.','No se pudo descargar el dictado.':'Could not download voice typing. Please try again.','No se pudo convertir la voz en texto. Probá otra vez.':'Could not turn speech into text. Please try again.','La transcripción tardó demasiado. Probá con un audio más corto.':'Transcription took too long. Try a shorter recording.','No se pudo descargar el dictado. Revisá internet y probá otra vez.':'Could not download voice typing. Check your internet connection and try again.','No se pudo preparar el dictado. Probá otra vez.':'Could not set up voice typing. Please try again.'};return map[text]||'Voice typing could not finish. Please try again.';}
 async transcribe({audio,language='en'}={}){
  if(this.operation||this.transcriptionPending)throw Error(this.getLanguage()==='en'?'Voice typing is busy. Please wait.':'El dictado está ocupado. Esperá un momento.');
  const epoch=this.cancelEpoch;this.transcriptionPending=true;try{return await this._transcribe({audio,language},epoch);}finally{this.transcriptionPending=false;}
 }
 async _transcribe({audio,language},epoch){
  const checkCancelled=()=>{if(epoch!==this.cancelEpoch)throw Error(this._message('Cancelado.'));};
  let wav;try{wav=audioBuffer(audio);}catch(error){throw Error(this._message(error.message));}
  const status=await this.status();checkCancelled();
  if(!status.ready){await this.prepare();checkCancelled();}
  // Silence should not produce invented words from the speech model.
  let energy=0;for(let i=0;i<wav.data.length;i+=2){const sample=wav.data.readInt16LE(i)/32768;energy+=sample*sample;}if(Math.sqrt(energy/(wav.data.length/2))<.0008)return{text:'',duration:wav.duration};
  this.controller=new AbortController();const signal=this.controller.signal;let folder;
  this.operation=(async()=>{
   const temp=path.join(this.dir,'temporary');await fs.mkdir(temp,{recursive:true});folder=await fs.mkdtemp(path.join(temp,'voice-'));const input=path.join(folder,'audio.wav'),output=path.join(folder,'transcript');await fs.writeFile(input,wav.bytes);this._event('transcribing');
   await run(this.exe,['-m',this.model,'-f',input,'-l',language==='en'?'en':'es','-t',String(Math.max(1,Math.min(6,os.availableParallelism?.()||os.cpus().length))),'-otxt','-of',output,'-np','-nt'],{cwd:path.dirname(this.exe),signal,timeout:180000});
   const text=(await fs.readFile(output+'.txt','utf8')).replace(/\[(?:BLANK_AUDIO|MUSIC|SILENCE)\]/gi,'').replace(/\s+/g,' ').trim().slice(0,16000);this._event('ready');return{text,duration:wav.duration};
  })().catch(error=>{this._event(signal.aborted?'ready':'error',{text:this._message(error.message)});throw Error(this._message(error.message));}).finally(async()=>{if(folder&&path.dirname(folder)===path.join(this.dir,'temporary'))await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});this.operation=null;this.controller=null;});return this.operation;
 }
 cancel(){this.cancelEpoch++;this.controller?.abort();return true;}
 async dispose(){this.cancel();await this.operation?.catch(()=>{});}
}
module.exports={SpeechService,ASSETS,audioBuffer,MAX_AUDIO};
