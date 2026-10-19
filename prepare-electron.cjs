'use strict';

// Pin the upstream archive and SHA-256. Setup does not run a downloaded installer.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const ELECTRON_VERSION = '44.9.0';
const ARCHIVE = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const SHA256 = '88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931';
const URL = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ARCHIVE}`;
const quotePowerShell = value => `'${value.replace(/'/g, "''")}'`;

async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function archiveHash(filename) { const hash = crypto.createHash('sha256'); for await (const chunk of require('node:fs').createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function writeNodeWrapper(root) {
  const bin = path.join(root, '.runtime', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'node.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\electron\\electron.exe" %*\r\nexit /b %errorlevel%\r\n');
}
function insideRuntime(root, filename) {
  const relative = path.relative(path.join(root, '.runtime'), filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Setup refused a path outside its runtime folder.');
  return filename;
}
async function prepareElectron({ root = __dirname, log = console.log } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This version supports Windows x64.');
  root = path.resolve(root);
  const dir = path.join(root, '.runtime'), target = path.join(dir, 'electron'), executable = path.join(target, 'electron.exe');
  let installedVersion = ''; try { installedVersion = (await fs.readFile(path.join(target, 'version'), 'utf8')).trim(); } catch {}
  if (installedVersion === ELECTRON_VERSION && await exists(executable)) {
    await writeNodeWrapper(root);
    log(`Electron ${ELECTRON_VERSION} is ready.`);
    return executable;
  }
  await fs.mkdir(dir, { recursive: true });
  const zip = path.join(dir, ARCHIVE), partial = path.join(dir, `${ARCHIVE}.part`);
  if (!await exists(zip) || await archiveHash(zip) !== SHA256) {
    log(`Downloading Electron ${ELECTRON_VERSION} from its official release…`);
    const response = await fetch(URL, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Electron download failed (HTTP ${response.status}). Try setup again.`);
    try {
      await pipeline(Readable.fromWeb(response.body), require('node:fs').createWriteStream(partial));
      if (await archiveHash(partial) !== SHA256) throw new Error('The download did not match the official SHA-256. Run setup again.');
      await fs.rename(partial, zip);
    } finally { await fs.rm(insideRuntime(root, partial), { force: true }); }
  }
  const staging = insideRuntime(root, path.join(dir, `electron-${process.pid}.tmp`));
  if (await exists(staging)) throw new Error('A previous setup folder is still present. Close other setup processes and try again.');
  await fs.mkdir(staging);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quotePowerShell(zip)} -DestinationPath ${quotePowerShell(staging)}`], { windowsHide: true, stdio: 'pipe' });
    if ((await fs.readFile(path.join(staging, 'version'), 'utf8')).trim() !== ELECTRON_VERSION || !await exists(path.join(staging, 'electron.exe'))) throw new Error('Electron extraction was incomplete. Run setup again.');
    if (await exists(target)) throw new Error('A different Electron runtime is already installed. Close Órbita and move .runtime/electron aside before running setup.');
    await fs.rename(staging, target);
    await writeNodeWrapper(root);
    log(`Electron ${ELECTRON_VERSION} is ready. Its download matched the pinned SHA-256.`);
  } finally { await fs.rm(insideRuntime(root, staging), { recursive: true, force: true }); }
  return executable;
}

module.exports = { prepareElectron, writeNodeWrapper, ELECTRON_VERSION, SHA256, URL };
if (require.main === module) prepareElectron().catch(error => { console.error(error.message); process.exitCode = 1; });
