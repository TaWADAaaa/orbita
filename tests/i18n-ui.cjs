'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-language-ui-'));
  const main = path.join(fixture, 'main.cjs');
  await fs.writeFile(main, "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}}).loadURL('about:blank');});");
  const app = await electron.launch({ executablePath: path.join(root, '.runtime/electron/electron.exe'), args: [main], timeout: 30000 });
  const page = await app.firstWindow();
  try {
    await page.setContent(`<div id="settings-appearance"><div class="setting-section"></div></div>
      <h1 id="heading">¿Qué vamos a crear?</h1><button id="save">Guardar</button><textarea id="prompt" placeholder="Contame qué querés hacer…" aria-label="Mensaje para la IA"></textarea>
      <div class="message-body"><p id="prose">Guardar</p><strong>Restringido</strong><div><button class="copy-code">Copiar</button><pre><code id="code">Guardar</code></pre></div></div>
      <button class="file-row"><span id="filename">Guardar</span></button><div class="tree-folder"><summary><span id="foldername">Datos</span></summary></div>
      <div class="web-article" id="web">Archivos</div><p data-i18n-skip id="memory">Memoria</p><div class="history-item"><button id="chatname">Conversación</button></div>
      <pre class="console-output empty" id="terminal-output">Acá ves los comandos que ejecutás vos o la IA.</pre><div id="dynamic"></div><div id="toasts"></div>`);
    await page.addStyleTag({ path: path.join(root, 'ui/i18n.css') });
    await page.evaluate(() => { window.languageCalls = []; window.failLanguage = true; window.orbita = { call: async (name, data) => { window.languageCalls.push({ name, data }); return window.failLanguage ? { error: 'No se pudo guardar el idioma. Volvé a intentar.' } : { language: data.settings.language }; } }; });
    await page.addScriptTag({ path: path.join(root, 'ui/i18n.js') });
    await page.evaluate(() => window.orbitaI18n.init(null));
    assert.equal(await page.locator('#language-dialog button').count(), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#language-dialog').evaluate(el => el.open), true);
    await page.locator('[data-language="en"]').click();
    await page.waitForFunction(() => document.querySelector('#language-error').textContent.length > 0);
    assert.equal(await page.locator('#language-dialog').evaluate(el => el.open), true);
    await page.evaluate(() => { window.failLanguage = false; });
    await page.locator('[data-language="en"]').click();
    await page.locator('#language-dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#heading').textContent === 'What shall we create?');
    assert.equal(await page.locator('#save').textContent(), 'Save');
    assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Tell me what you want to do…');
    assert.equal(await page.locator('#prompt').getAttribute('aria-label'), 'Message for the AI');
    assert.equal(await page.locator('.copy-code').textContent(), 'Copy');
    for (const [id, expected] of [['prose', 'Guardar'], ['code', 'Guardar'], ['filename', 'Guardar'], ['foldername', 'Datos'], ['web', 'Archivos'], ['memory', 'Memoria'], ['chatname', 'Conversación']]) assert.equal(await page.locator('#' + id).textContent(), expected, `${id} must stay unchanged`);
    assert.equal(await page.locator('#terminal-output').textContent(), 'Commands run by you or the AI appear here.');
    await page.evaluate(() => { document.querySelector('#dynamic').innerHTML = '<span id="level">Permitido por el nivel 6</span><span id="queue">En cola · 3</span><span id="voice">Escuchando… 12 s</span>'; });
    await page.waitForFunction(() => document.querySelector('#level').textContent === 'Allowed by level 6');
    assert.equal(await page.locator('#queue').textContent(), 'Queued · 3');
    assert.equal(await page.locator('#voice').textContent(), 'Listening… 12 s');
    await page.locator('#interface-language').selectOption('es');
    await page.waitForFunction(() => document.querySelector('#heading').textContent === '¿Qué vamos a crear?');
    assert.equal(await page.locator('#queue').textContent(), 'En cola · 3');
    assert.equal(await page.locator('#voice').textContent(), 'Escuchando… 12 s');
    await page.locator('#interface-language').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.evaluate(() => { for (let i = 0; i < 100; i++) window.orbitaI18n.apply(); });
    assert.equal(await page.locator('#heading').textContent(), 'What shall we create?');
    const whitespace = await page.evaluate(() => { const node = document.createTextNode('   \n'); document.querySelector('#dynamic').append(node); for (let i = 0; i < 10; i++) window.orbitaI18n.apply(); return node.nodeValue; });
    assert.equal(whitespace, '   \n');
    assert.equal(await page.evaluate(() => window.orbitaI18n.t('Ese valor está fuera del rango permitido. Elegí uno entre 1 y 7.')), 'That value is outside the allowed range. Choose one between 1 and 7.');
    console.log(JSON.stringify({ languageUI: 'OK', onboarding: 'two choices; saved before closing', english: 'OK', spanish: 'OK', dynamic: 'OK', userContent: 'unchanged', hints: 'translated', fixture }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
