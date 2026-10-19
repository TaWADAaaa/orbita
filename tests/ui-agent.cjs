'use strict';
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const root=path.resolve(__dirname,'..');
(async()=>{
 const project=await fs.mkdtemp(path.join(os.tmpdir(),'orbita-ui-agent-')),profile=await fs.mkdtemp(path.join(os.tmpdir(),'orbita-ui-agent-profile-'));await fs.copyFile(path.join(process.env.APPDATA,'Orbita Local','models.json'),path.join(profile,'models.json'));let app,page,initial,chatId;
 await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({language:null}));
 try{
  app=await electron.launch({executablePath:path.join(root,'.runtime/electron/electron.exe'),args:[root],env:{...process.env,ORBITA_TEST_PROFILE:profile},timeout:30000});page=await app.firstWindow();
  await page.locator('#language-dialog').waitFor();await page.locator('[data-language="es"]').click();await page.locator('#language-dialog').waitFor({state:'detached'});
  await page.waitForFunction(()=>window.orbita&&document.querySelector('#composer-model').textContent!=='Sin modelo');initial=await page.evaluate(()=>window.orbita.call('init'));
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},project);
  await page.evaluate(()=>window.orbita.call('saveSettings',{settings:{maxTokens:512,maxSteps:6}}));
  await page.locator('#new-chat').click();await page.locator('#attach-project').click();await page.locator('#attach-folder').click();await page.waitForFunction(()=>document.querySelector('#project-name').textContent.startsWith('orbita-ui-agent-'));
  await page.locator('#prompt').fill('Creá un archivo en la raíz de la carpeta. La ruta exacta es saludo.py y su contenido debe ser exactamente: print("Hola desde Órbita")\nNo ejecutes comandos. Usá write_file para guardar el archivo en saludo.py. Al terminar confirmá que está guardado.');await page.locator('#send').click();
  await page.locator('.tool-actions .primary-btn').waitFor({timeout:90000});assert.ok((await page.locator('.tool-card').first().textContent()).includes('saludo.py'));
  await page.screenshot({path:path.join(root,'test-output','revisar-cambio.png')});
  await assert.rejects(fs.access(path.join(project,'saludo.py')));
  await page.locator('.tool-actions .primary-btn').click();await page.locator('#thinking').waitFor({state:'hidden',timeout:90000});
  assert.ok((await fs.readFile(path.join(project,'saludo.py'),'utf8')).includes('Hola desde Órbita'));
  const after=await page.evaluate(()=>window.orbita.call('init'));chatId=after.lastChatId;
  await page.locator('[data-undo]').click();await page.locator('#confirm-undo').click();await page.locator('#modal').waitFor({state:'hidden'});
  await assert.rejects(fs.access(path.join(project,'saludo.py')));assert.ok((await page.locator('.tool-card').first().textContent()).includes('Cambio deshecho'));
  await page.screenshot({path:path.join(root,'test-output','cambio-deshecho.png')});
  console.log(JSON.stringify({guiAgent:'OK',reviewBeforeWrite:true,fileWritten:true,undo:'OK'}));
 }finally{
  if(page&&initial){await page.evaluate(async({settings,id})=>{await window.orbita.call('stop');await window.orbita.call('saveSettings',{settings});if(id)await window.orbita.call('deleteChat',{id});await window.orbita.call('clearProject');},{settings:initial.settings,id:chatId}).catch(()=>{});if(initial.project){await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},initial.project.path);await page.evaluate(()=>window.orbita.call('chooseProject')).catch(()=>{});}}
  if(app)await app.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
