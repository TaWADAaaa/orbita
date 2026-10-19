'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-english-release-'));
  const app = await electron.launch({ executablePath: path.join(root, '.runtime/electron/electron.exe'), args: [root], env: { ...process.env, ORBITA_TEST_PROFILE: profile }, timeout: 30000 });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.waitForFunction(() => window.orbitaI18n?.language === 'en' && document.querySelector('#interface-language'));
    assert.equal(await page.locator('#language-dialog').count(), 0);
    assert.equal((await page.evaluate(() => window.orbita.call('init'))).settings.language, 'en');
    assert.equal(await page.locator('#welcome h1').textContent(), 'What shall we do?');
    assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Tell me what you want to do…');
    const screenshots=path.join(root,'docs','assets');await fs.mkdir(screenshots,{recursive:true});
    await page.screenshot({path:path.join(screenshots,'orbita.png')});
    await page.locator('#access-button').click();
    await page.waitForFunction(() => document.querySelector('#permission-name').textContent === 'Restricted');
    await page.locator('#permission-cancel').click();
    await page.locator('[data-page="settings"]').click();
    await page.locator('[data-settings="data"]').click();
    assert.equal(await page.locator('.support-section summary').textContent(), 'Support Órbita');
    await page.locator('.support-section summary').click();
    await page.locator('#show-donations').click();
    const wallets = [
      ['BTC', 'Bitcoin · mainnet', 'bc1qt696cljgmhhwswdt2ulpwpmzdnc5fhuw4k8lz5'],
      ['SOL', 'Solana · mainnet', '3jmHYhw4iNcqSLvb5GxwDZev2qNx853TESEYYeEj3NYx'],
      ['USDT', 'USDT · BNB Chain (BEP-20)', '0x5D7c7e1055C2381a402b9e7F73d2cFa78f23c0F5']
    ];
    for (let index = 0; index < wallets.length; index++) {
      const row = page.locator('.donation-wallet').nth(index);
      assert.equal(await row.locator('strong').textContent(), wallets[index][0]);
      assert.equal(await row.locator('.donation-heading span').textContent(), wallets[index][1]);
      assert.equal(await row.locator('code').textContent(), wallets[index][2]);
      await row.locator('button').click();
      await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some(toast => toast.textContent.includes('Address copied.')));
      await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length > 0);
      const copied=await app.evaluate(async({ clipboard }, expected) => {const text=await clipboard.readText();return{matches:text===expected,length:text.length,expectedLength:expected.length};}, wallets[index][2]);
      assert.ok(copied.matches, `Copied donation address must match the selected wallet (${JSON.stringify(copied)})`);
      await page.locator('#toasts .toast').evaluateAll(items => items.forEach(item => item.remove()));
    }
    const output = path.join(root, 'test-output'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'donations-english.png') });
    await page.locator('#modal-close').click();
    await page.locator('[data-settings="appearance"]').click();
    await page.locator('#interface-language').selectOption('es');
    await page.waitForFunction(() => document.querySelector('#page-settings h1').textContent === 'Hacé tuya Órbita');
    await page.locator('[data-settings="data"]').click();
    await page.waitForFunction(() => document.querySelector('.support-section summary').textContent === 'Apoyar Órbita');
    await page.locator('[data-settings="appearance"]').click();
    await page.locator('#interface-language').selectOption('en');
    await page.reload();
    await page.waitForFunction(() => window.orbitaI18n?.language === 'en' && document.querySelector('#interface-language'));
    assert.equal(await page.locator('#page-settings h1').textContent(), 'Make Órbita yours');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ englishDefault: true, englishUI: true, spanishOptional: true, languagePersists: true, exactWallets: 3, clipboard: true, jsErrors: errors }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
