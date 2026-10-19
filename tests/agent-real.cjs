'use strict';
const {Backend}=require('../backend.cjs');
const {ModelEngine}=require('../runtime.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const sandbox=await fs.mkdtemp(path.join(os.tmpdir(),'orbita-real-agent-'));const project=path.join(sandbox,'proyecto');await fs.mkdir(project);
 let backend;const events=[];const engine=new ModelEngine({dataDir:path.join(process.env.APPDATA,'Orbita Local'),getSettings:()=>backend?.job?.settings||backend?.settings||{},emit:()=>{}});
 await engine.init();
 backend=new Backend({dataDir:path.join(sandbox,'data'),engine,emit:event=>{events.push(event);if(event.type==='tool'){const t=event.tool;console.log(JSON.stringify({tool:t.data.tool,path:t.data.path}));if(['write_file','run_command'].includes(t.data.tool)){const approved=t.data.tool==='write_file'&&t.data.path==='saludo.py'&&t.data.content.length<1000&&t.data.content.includes('Hola desde');backend.approveTool({id:t.id,approved}).catch(console.error);}}}});
 try{
  await backend.init();await backend.saveSettings({settings:{maxTokens:512,maxSteps:6}});await backend.setProject(project);
  const start=Date.now();const result=await backend.sendMessage({text:'Creá un archivo en la raíz de la carpeta. La ruta exacta es saludo.py y su contenido debe ser exactamente: print("Hola desde Órbita")\nNo ejecutes comandos. Usá write_file para guardar el archivo en saludo.py. Al terminar confirmá que está guardado.',mode:'agent'});
  console.log(JSON.stringify({history:result.chat.messages}));
  const content=await fs.readFile(path.join(project,'saludo.py'),'utf8');assert.ok(content.includes('print(')&&content.includes('Hola desde Órbita'));
  assert.ok(events.some(e=>e.type==='toolResult'&&e.text==='Listo'));
  console.log(JSON.stringify({agent:'OK',seconds:(Date.now()-start)/1000,content,reply:result.chat.messages.filter(m=>m.role==='assistant').map(m=>m.content),project}));
 }finally{await backend.dispose();await engine.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
