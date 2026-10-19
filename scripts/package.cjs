'use strict';
// An explicit source list keeps local models, user profiles and caches out of releases.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareElectron } = require('../prepare-electron.cjs');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
function insideDist(filename) {
  const relative = path.relative(dist, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Packaging refused a path outside dist.');
  return filename;
}
async function hash(filename) { const result = crypto.createHash('sha256'); for await (const chunk of require('node:fs').createReadStream(filename)) result.update(chunk); return result.digest('hex'); }
async function copyFiles(source, target, select = () => true) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('A release file is a symbolic link: ' + path.relative(root, source));
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) if (select(name, path.join(source, name))) await copyFiles(path.join(source, name), path.join(target, name), select);
  } else if (stat.isFile()) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target); }
}
async function allFiles(directory, prefix = '') {
  const files = [];
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? prefix + '/' + item.name : item.name;
    if (item.isDirectory()) files.push(...await allFiles(path.join(directory, item.name), relative));
    else files.push(relative);
  }
  return files;
}
(async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('The package version must be a stable numeric version.');
  await prepareElectron();
  await fs.mkdir(dist, { recursive: true });
  const stem = `Orbita-${pkg.version}-win-x64`, staging = insideDist(path.join(dist, `${stem}-staging`));
  await fs.rm(staging, { recursive: true, force: true });
  const bundle = path.join(staging, 'Orbita'); await fs.mkdir(bundle, { recursive: true });
  try {
    const rootFiles = (await fs.readdir(root)).filter(name => /\.(cjs|md|ico|cmd)$/i.test(name) || ['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'LEEME.txt', '.gitignore', '.gitattributes'].includes(name));
    for (const name of rootFiles) await copyFiles(path.join(root, name), path.join(bundle, name));
    for (const name of ['ui', 'scripts', 'tests', '.github', 'docs']) {
      try { await fs.access(path.join(root, name)); } catch { continue; }
      await copyFiles(path.join(root, name), path.join(bundle, name), name => !/\.(wav|log)$/i.test(name) && !['node_modules', '.env', 'test-output'].includes(name));
    }
    await copyFiles(path.join(root, '.runtime', 'electron'), path.join(bundle, '.runtime', 'electron'));
    await copyFiles(path.join(root, '.runtime', 'bin'), path.join(bundle, '.runtime', 'bin'));
    const manifest = [];
    for (const filename of await allFiles(bundle)) manifest.push({ path: filename, size: (await fs.stat(path.join(bundle, filename))).size, sha256: await hash(path.join(bundle, filename)) });
    await fs.writeFile(path.join(bundle, 'MANIFEST.json'), JSON.stringify({ name: 'Orbita', version: pkg.version, platform: 'win32-x64', files: manifest }, null, 2) + '\n');
    const zip = insideDist(path.join(dist, stem + '.zip'));
    await fs.rm(zip, { force: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'zip-portable.ps1'), '-Source', staging, '-Output', zip], { windowsHide: true, stdio: 'inherit' });
    await fs.writeFile(path.join(dist, stem + '.sha256'), `${await hash(zip)}  ${path.basename(zip)}\n`);
    console.log(`Portable package: ${zip}`);
    console.log('The archive includes the complete app source and Electron notices. Models and personal data are excluded.');
  } finally { await fs.rm(insideDist(staging), { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
