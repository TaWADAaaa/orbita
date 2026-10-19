'use strict';
const { _electron: electron }=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const root=path.resolve(__dirname,'..');
(async()=>{
 const output=path.join(root,'test-output');await fs.mkdir(output,{recursive:true});
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'orbita-ui-smoke-'));
 const sourceProfile=process.env.ORBITA_MODEL_PROFILE||path.join(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'Orbita Local');
 try{await fs.copyFile(path.join(sourceProfile,'models.json'),path.join(profile,'models.json'));}catch{console.log('SKIP: configure a local model first, or set ORBITA_MODEL_PROFILE to a prepared profile.');return;}
 await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({language:'es'}));
 const app=await electron.launch({executablePath:process.env.ORBITA_ELECTRON||path.join(root,'.runtime/electron/electron.exe'),args:[root],env:{...process.env,ORBITA_TEST_PROFILE:profile},timeout:30000});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let initial,chatId;try{
 await page.waitForFunction(()=>window.orbita&&document.querySelector('#composer-model').textContent!=='Sin modelo',null,{timeout:30000});
 initial=await page.evaluate(()=>window.orbita.call('init'));
 assert.ok(initial.models.length,'modelo real disponible');assert.ok(initial.runtime.ready,'motor preparado');
 await page.screenshot({path:path.join(output,'conversacion.png')});
 await page.locator('[data-page="models"]').click();
 assert.equal(await page.locator('.source-card').count(),3);
 assert.ok(await page.locator('.model-row.active').isVisible());
 await page.screenshot({path:path.join(output,'modelos.png')});
 await page.locator('#source-hf').click();await page.locator('#hf-query').fill('Qwen2.5-Coder-1.5B-Instruct-GGUF');await page.locator('#hf-search button').click();
 await page.locator('.hf-result').first().waitFor({timeout:30000});await page.locator('.hf-result').filter({hasText:'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF'}).first().click();
  await page.locator('.model-file').first().waitFor({timeout:30000});assert.ok((await page.locator('#hf-files').textContent()).includes('q4_k_m.gguf'));await page.locator('#modal-close').click();
  const hfWindowPromise=app.waitForEvent('window');await page.evaluate(()=>window.orbita.call('openHuggingFace'));const hfPage=await hfWindowPromise;await hfPage.waitForLoadState('domcontentloaded',{timeout:45000});
  assert.equal(new URL(hfPage.url()).hostname,'huggingface.co');assert.equal(await hfPage.evaluate(()=>typeof window.orbita),'undefined');await hfPage.close();
 await page.locator('[data-page="settings"]').click();
 await page.locator('[data-settings="appearance"]').click();
 await page.locator('[data-setting="theme"]').selectOption('midnight');await page.locator('[data-setting="fontSize"]').selectOption('16');
 await page.waitForTimeout(400);const saved=await page.evaluate(()=>window.orbita.call('init'));assert.equal(saved.settings.theme,'midnight');assert.equal(saved.settings.fontSize,16);
 await page.screenshot({path:path.join(output,'ajustes.png')});
 await page.reload();await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim()==='16px');
 await page.locator('[data-page="settings"]').click();assert.equal(await page.locator('[data-setting="theme"]').inputValue(),'midnight');
 await page.evaluate(s=>window.orbita.call('saveSettings',{settings:s}),{...initial.settings,maxTokens:128});await page.reload();await page.waitForFunction(()=>window.orbita&&document.querySelector('#composer-model').textContent!=='Sin modelo');
 await page.locator('#new-chat').click();await page.locator('#prompt').fill('Respondé en una frase corta en español: ¿dónde se ejecuta este modelo?');await page.locator('#send').click();
 await page.locator('#thinking').waitFor({state:'visible'});await page.screenshot({path:path.join(output,'pensando.png')});
 await page.locator('#thinking').waitFor({state:'hidden',timeout:240000});
 const reply=await page.locator('.message.assistant .message-body').last().textContent();assert.ok(reply?.length>8,'respuesta real con texto');assert.equal(await page.locator('.inline-error').count(),0,'sin errores de motor');
 const after=await page.evaluate(()=>window.orbita.call('init'));chatId=after.lastChatId;assert.ok(chatId,'conversación persistida');
 await page.screenshot({path:path.join(output,'respuesta-real.png')});
 console.log(JSON.stringify({ui:'OK',sources:3,hf:'OK',settingsReload:'OK',inference:reply,models:after.models.length,jsErrors:errors}));
 assert.deepEqual(errors,[]);
 }finally{if(initial)await page.evaluate(async({settings,id})=>{await window.orbita.call('stop');await window.orbita.call('saveSettings',{settings});if(id)await window.orbita.call('deleteChat',{id});},{settings:initial.settings,id:chatId}).catch(()=>{});await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
