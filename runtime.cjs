'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');

const HF = 'https://huggingface.co';
const MAX_MODEL = 300 * 1024 ** 3;
const MIN_GGUF = 1024;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SPLIT = /-\d{5}-of-\d{5}\.gguf$/i;
const USER_AGENT = 'Orbita-Local/0.1';

function abortError() { const e = new Error('Se detuvo la operación.'); e.name = 'AbortError'; return e; }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function number(value, fallback, low, high) { const n = Number(value); return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback; }
function safeName(value) { return path.basename(String(value).replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180); }
function validateRepo(repo) { if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/').some(p => p === '.' || p === '..' || p.length > 100)) throw Error('El enlace no tiene un nombre de modelo válido.'); return repo; }
function compatibleName(name) { return /\.gguf$/i.test(name) && !SPLIT.test(name) && !/(^|\/)mmproj[-_.]/i.test(name); }
function modelURL(repo, file) { return `${HF}/${repo.split('/').map(encodeURIComponent).join('/')}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`; }
function allowedURL(value, kind, initial = false) {
  let url; try { url = new URL(value); } catch { throw Error('Pegá un enlace HTTPS válido de Hugging Face.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw Error('Usá un enlace HTTPS sin contraseña ni un puerto especial.');
  const host = url.hostname.toLowerCase();
  const okay = kind === 'runtime'
    ? ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(host)
    : initial ? ['huggingface.co', 'www.huggingface.co', 'hf.co'].includes(host)
      : host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co');
  if (!okay) throw Error(kind === 'runtime' ? 'La dirección del motor no es de su fuente oficial.' : 'Este enlace no es de Hugging Face. Elegí un modelo público de ese sitio.');
  return url;
}
async function validateGGUF(file) {
  if (path.extname(file).toLowerCase() !== '.gguf' || SPLIT.test(file)) throw Error('Elegí un archivo .gguf de una sola pieza. Los modelos divididos todavía no se pueden usar.');
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw Error('No se encuentra el archivo del modelo. Volvé a agregarlo desde su carpeta.');
  if (stat.size < MIN_GGUF || stat.size > MAX_MODEL) throw Error('El archivo está vacío, incompleto o es demasiado grande. Elegí un modelo GGUF completo.');
  const handle = await fsp.open(file, 'r');
  try {
    const header = Buffer.alloc(24); const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24 || header.subarray(0, 4).toString('ascii') !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4)) || header.readBigUInt64LE(8) === 0n) throw Error('El archivo no parece un modelo GGUF válido. Puede estar incompleto o ser otro tipo de archivo.');
  } finally { await handle.close(); }
  return stat;
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); };
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); };
    const timer = setTimeout(done, ms); signal?.addEventListener('abort', stop, { once: true });
  });
}
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = ''; let finished = false;
    const timer = setTimeout(() => { child.kill(); finish(Error('El motor tardó demasiado en responder.')); }, 30000);
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-512000); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? null : Error(output.trim() || 'El motor no pudo iniciarse.'), output));
  });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.unref(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(error => error ? reject(error) : resolve(port)); });
  });
}

class ModelEngine {
  constructor({ dataDir, emit = () => {}, getSettings = () => ({}) }) {
    this.dataDir = path.resolve(dataDir); this.emit = emit; this.getSettings = getSettings;
    this.models = []; this.activeId = null; this.runtimePath = null; this.runtimeInfo = {}; this._runtimes = {};
    this._fetch = (...args) => fetch(...args); this._download = null; this._downloadTask = null; this._server = null; this._generating = false; this._changing = false; this._changePromise = null; this._disposed = false;
    this._saveQueue = Promise.resolve();
  }
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'models'), { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'logs'), { recursive: true });
    let saved = {};
    try { saved = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'models.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') await this._log('No se pudo leer models.json: ' + error.message); }
    for (const item of Array.isArray(saved.models) ? saved.models : []) {
      if (typeof item.path !== 'string' || typeof item.id !== 'string') continue;
      try { const stat = await validateGGUF(item.path); this.models.push({ id: item.id, name: safeName(item.name || path.basename(item.path)), path: path.resolve(item.path), size: stat.size, ...(typeof item.sourceUrl === 'string' ? { sourceUrl: item.sourceUrl } : {}) }); } catch { /* Missing or incomplete files are not offered as usable models. */ }
    }
    this.activeId = this.models.some(m => m.id === saved.activeId) ? saved.activeId : this.models[0]?.id || null;
    if (saved.runtimes && typeof saved.runtimes === 'object' && !Array.isArray(saved.runtimes)) {
      for (const variant of ['cpu', 'vulkan']) if (typeof saved.runtimes[variant]?.path === 'string') this._runtimes[variant] = saved.runtimes[variant];
    }
    if (typeof saved.runtimePath === 'string') {
      try { await this._inspectRuntime(saved.runtimePath, saved.runtimeInfo || {}); }
      catch (error) { await this._log('Motor guardado no disponible: ' + error.message); }
    }
    // Discard abandoned partial files only after a day; a preparation process may still be writing one.
    for (const name of await fsp.readdir(path.join(this.dataDir, 'models'))) if (/^[\da-f-]+\.part$/i.test(name)) {
      const part = path.join(this.dataDir, 'models', name), stat = await fsp.stat(part).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fsp.unlink(part).catch(() => {});
    }
    return this.status();
  }
  status() { return { ready: !!this.runtimePath, version: this.runtimeInfo.version || '', path: this.runtimePath, loaded: !!this._server?.ready, cpuOnly: this.runtimeInfo.cpuOnly !== false, variant: this.runtimeInfo.variant || (this.runtimeInfo.cpuOnly === false ? 'vulkan' : 'cpu'), verified: !!this.runtimeInfo.verified, release: this.runtimeInfo.release || null, activeModel: this.activeId }; }
  _snapshot() { return { models: this.models.map(m => ({ ...m })), activeModel: this.activeId }; }
  _modelsChanged() { const result = this._snapshot(); this.emit({ type: 'models', ...result }); return result; }
  _runtimeChanged() { const runtime = this.status(); this.emit({ type: 'runtime', runtime }); return runtime; }
  _change(task) {
    if (this._disposed) throw Error('El motor se cerró. Volvé a abrir la app.');
    if (this._generating) throw Error('Primero detené la respuesta para cambiar el modelo o el motor.');
    if (this._changing) throw Error('Ya hay un cambio de modelo o motor en curso. Esperá a que termine.');
    // Acquire before the first await, including cached-runtime checks and long downloads.
    this._changing = true;
    this._changePromise = Promise.resolve().then(() => { if (this._disposed) throw abortError(); return task(); }).finally(() => { this._changing = false; this._changePromise = null; });
    return this._changePromise;
  }
  _save() {
    const body = JSON.stringify({ models: this.models, activeId: this.activeId, runtimePath: this.runtimePath, runtimeInfo: this.runtimeInfo, runtimes: this._runtimes }, null, 2);
    this._saveQueue = this._saveQueue.catch(() => {}).then(async () => {
      const file = path.join(this.dataDir, 'models.json'), temp = file + '.' + crypto.randomUUID() + '.tmp';
      await fsp.writeFile(temp, body, 'utf8'); await fsp.rename(temp, file);
    });
    return this._saveQueue;
  }
  async _log(text) {
    const file = path.join(this.dataDir, 'logs', 'engine.log');
    try {
      const stat = await fsp.stat(file).catch(() => null); if (stat?.size > 4 * 1024 ** 2) await fsp.rename(file, file + '.previous').catch(() => {});
      await fsp.appendFile(file, `[${new Date().toISOString()}] ${String(text).slice(-32000)}\n`);
    } catch { /* Logging must not prevent the user from working. */ }
  }
  async importLocal(file) {
    const resolved = path.resolve(file); const stat = await validateGGUF(resolved);
    const match = this.models.find(m => (process.platform === 'win32' ? m.path.toLowerCase() === resolved.toLowerCase() : m.path === resolved));
    if (match) return this._snapshot();
    this.models.push({ id: crypto.randomUUID(), name: safeName(path.basename(resolved)), path: resolved, size: stat.size });
    if (!this.activeId) this.activeId = this.models[this.models.length - 1].id;
    await this._save(); return this._modelsChanged();
  }
  async select(id) {
    return this._change(async () => {
      if (!this.models.some(m => m.id === id)) throw Error('Ese modelo ya no está en tu lista.');
      if (this.activeId !== id) await this.unload();
      this.activeId = id; await this._save(); return this._modelsChanged();
    });
  }
  async remove(id) {
    return this._change(async () => {
      if (this.activeId === id) await this.unload();
      this.models = this.models.filter(m => m.id !== id);
      if (this.activeId === id) this.activeId = this.models[0]?.id || null;
      await this._save(); return this._modelsChanged();
    });
  }
  async _request(value, { kind = 'model', signal, method = 'GET', headers = {}, initial = false } = {}) {
    let url = allowedURL(value, kind, initial);
    for (let redirects = 0; redirects <= 8; redirects++) {
      checkAbort(signal);
      let response; const connection = new AbortController(); const timer = setTimeout(() => connection.abort(), 60000);
      try { response = await this._fetch(url.href, { method, redirect: 'manual', signal: signal ? AbortSignal.any([signal, connection.signal]) : connection.signal, headers: { 'User-Agent': USER_AGENT, ...headers } }); }
      catch (error) { if (signal?.aborted) throw abortError(); throw Error('No se pudo conectar. Revisá tu conexión e intentá de nuevo.'); }
      finally { clearTimeout(timer); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => {});
        if (!location) throw Error('El servidor no indicó dónde está el archivo.');
        url = allowedURL(new URL(location, url).href, kind); continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw Error('Este modelo necesita permiso o una cuenta. Elegí un modelo público que se pueda descargar libremente.');
        if (response.status === 404) throw Error('No encontramos ese modelo o archivo. Revisá el enlace.');
        if (response.status === 429) throw Error('El sitio recibió muchas consultas. Esperá un momento y volvé a intentar.');
        throw Error('El sitio no pudo entregar el archivo. Intentá de nuevo más tarde.');
      }
      return response;
    }
    throw Error('El enlace tiene demasiados desvíos. Probá con el enlace original del modelo.');
  }
  async _json(url, options) {
    const response = await this._request(url, options); const reader = response.body.getReader(); const chunks = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 16 * 1024 ** 2) throw Error('La lista es demasiado grande. Buscá un modelo más específico.'); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('El sitio devolvió una respuesta que no podemos leer. Intentá de nuevo.'); }
  }
  async search(query = '') {
    const url = new URL(HF + '/api/models'); url.searchParams.set('filter', 'gguf'); url.searchParams.set('search', String(query).trim().slice(0, 180)); url.searchParams.set('sort', 'downloads'); url.searchParams.set('direction', '-1'); url.searchParams.set('limit', '30');
    const data = await this._json(url.href);
    return (Array.isArray(data) ? data : []).filter(m => REPO.test(m.id)).map(m => ({ id: m.id, downloads: Number(m.downloads) || 0, likes: Number(m.likes) || 0 }));
  }
  async getFiles(repo) {
    validateRepo(repo); const data = await this._json(`${HF}/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?blobs=true`);
    return { repo, files: (data.siblings || []).filter(f => typeof f.rfilename === 'string' && compatibleName(f.rfilename)).map(f => ({ name: f.rfilename, size: Number(f.size || f.lfs?.size) || 0, url: modelURL(repo, f.rfilename), ...(f.lfs?.sha256 && /^[\da-f]{64}$/i.test(f.lfs.sha256) ? { sha256: f.lfs.sha256 } : {}) })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  async resolve(value, { signal } = {}) {
    const url = allowedURL(String(value).trim(), 'model', true);
    const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { throw Error('El enlace tiene un nombre de archivo inválido.'); } });
    if (parts.length < 2) throw Error('Pegá el enlace completo a un modelo o a su archivo GGUF.');
    const repo = validateRepo(parts.slice(0, 2).join('/'));
    if (['blob', 'resolve'].includes(parts[2]) && parts.length >= 5) {
      const file = parts.slice(4).join('/');
      if (!compatibleName(file)) throw Error('Elegí un archivo .gguf de una sola pieza, que no sea un archivo mmproj.');
      const clean = `${HF}/${repo}/resolve/${encodeURIComponent(parts[3])}/${parts.slice(4).map(encodeURIComponent).join('/')}?download=true`;
      const response = await this._request(clean, { method: 'HEAD', initial: true, signal });
      const etag = (response.headers.get('x-linked-etag') || response.headers.get('etag') || '').replace(/^"|"$/g, '');
      return { repo, url: clean, name: safeName(parts[parts.length - 1]), size: Number(response.headers.get('x-linked-size') || response.headers.get('content-length')) || 0, ...(/^[\da-f]{64}$/i.test(etag) ? { sha256: etag } : {}) };
    }
    if (parts.length === 2 || parts[2] === 'tree') return this.getFiles(repo);
    throw Error('Pegá el enlace a la página del modelo o al archivo .gguf de Hugging Face.');
  }
  async _downloadFile(url, target, { kind = 'model', signal, name, expectedSize = 0, maxSize = MAX_MODEL, sha256 } = {}) {
    const response = await this._request(url, { kind, signal, initial: true });
    const contentSize = Number(response.headers.get('content-length')) || 0;
    const total = contentSize || expectedSize || 0;
    if (total > maxSize) { await response.body?.cancel().catch(() => {}); throw Error('El archivo es demasiado grande para esta descarga.'); }
    const handle = await fsp.open(target, 'wx'); const reader = response.body.getReader(); const hash = crypto.createHash('sha256');
    let received = 0, lastEvent = 0;
    try {
      this.emit({ type: 'download', name, received, total, status: 'downloading' });
      while (true) {
        checkAbort(signal);
        let idleTimer;
        const stalled = new Promise((_, reject) => { idleTimer = setTimeout(() => { reader.cancel().catch(() => {}); reject(Error('La descarga dejó de avanzar. Revisá tu conexión y volvé a intentar.')); }, 60000); });
        let packet; try { packet = await Promise.race([reader.read(), stalled]); } finally { clearTimeout(idleTimer); }
        const { done, value } = packet; if (done) break;
        received += value.length; if (received > maxSize) throw Error('El archivo supera el tamaño permitido.');
        let offset = 0;
        while (offset < value.length) { const { bytesWritten } = await handle.write(value, offset, value.length - offset); if (!bytesWritten) throw Error('No se pudo guardar el archivo. Revisá el espacio libre en el disco.'); offset += bytesWritten; }
        hash.update(value);
        if (Date.now() - lastEvent > 180) { lastEvent = Date.now(); this.emit({ type: 'download', name, received, total, status: 'downloading' }); }
      }
      checkAbort(signal);
      if ((contentSize && contentSize !== received) || (expectedSize && expectedSize !== received)) throw Error('La descarga quedó incompleta. Volvé a intentarlo.');
      const digest = hash.digest('hex');
      if (sha256 && digest.toLowerCase() !== sha256.toLowerCase()) throw Error('La descarga no coincide con el archivo original. Se descartó para que puedas volver a intentarlo.');
      return { received, total: total || received, digest };
    } finally { await reader.cancel().catch(() => {}); await handle.close(); }
  }
  async download(data = {}) {
    if (this._disposed) throw Error('El motor se cerró. Volvé a abrir la app.');
    if (this._downloadTask || this._download) throw Error('Ya hay una descarga en curso. Esperá a que termine o cancelala.');
    const task = this._downloadModel(data); this._downloadTask = task;
    try { return await task; } finally { if (this._downloadTask === task) this._downloadTask = null; }
  }
  async _downloadModel(data) {
    if (this._download) throw Error('Ya hay una descarga en curso. Esperá a que termine o cancelala.');
    allowedURL(data.url, 'model', true);
    const controller = new AbortController(); this._download = controller; let name = 'Modelo';
    const part = path.join(this.dataDir, 'models', crypto.randomUUID() + '.part');
    try {
      const info = await this.resolve(data.url, { signal: controller.signal });
      checkAbort(controller.signal);
      if (info.files) throw Error('Elegí un archivo GGUF de la lista para descargar.');
      name = safeName(info.name);
      const result = await this._downloadFile(info.url, part, { signal: controller.signal, name, expectedSize: info.size || number(data.size, 0, 0, MAX_MODEL), sha256: /^[\da-f]{64}$/i.test(data.sha256 || '') ? data.sha256 : info.sha256 });
      const destination = path.join(this.dataDir, 'models', crypto.randomUUID() + '-' + name);
      // Validate with its final extension before making it visible to the library.
      await fsp.rename(part, destination);
      try { await validateGGUF(destination); }
      catch (error) { await fsp.unlink(destination).catch(() => {}); throw error; }
      this.models.push({ id: crypto.randomUUID(), name, path: destination, size: result.received, sourceUrl: info.url });
      if (!this.activeId) this.activeId = this.models[this.models.length - 1].id;
      await this._save(); this.emit({ type: 'download', name, ...result, status: 'done' }); return this._modelsChanged();
    } catch (error) {
      await fsp.unlink(part).catch(() => {});
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      this.emit({ type: 'download', name, received: 0, total: 0, status: cancelled ? 'cancelled' : 'error', text: cancelled ? 'La descarga se canceló. Podés volver a intentarlo.' : error.message });
      if (cancelled) throw abortError(); throw error;
    } finally { if (this._download === controller) this._download = null; }
  }
  cancelDownload() { this._download?.abort(); return { cancelled: !!this._download }; }
  async _inspectRuntime(file, info = {}) {
    const resolved = path.resolve(file); const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat?.isFile() || !/llama.*server(?:\.exe)?$/i.test(path.basename(resolved))) throw Error('Elegí el programa llama-server.exe del motor llama.cpp.');
    let output;
    try { output = await run(resolved, ['--version'], { cwd: path.dirname(resolved) }); }
    catch (error) { await this._log(error.message); throw Error('El motor no pudo abrirse. Probá prepararlo de nuevo o elegí otra copia de llama-server.exe.'); }
    const version = output.match(/version:\s*([^\r\n]+)/i)?.[1]?.trim() || output.split(/\r?\n/).find(l => l.trim())?.slice(0, 160) || 'llama.cpp';
    this.runtimePath = resolved; this.runtimeInfo = { ...info, version };
    if (['cpu', 'vulkan'].includes(info.variant) || info.verified) {
      const variant = info.variant || (info.cpuOnly === false ? 'vulkan' : 'cpu');
      this.runtimeInfo.variant = variant; this._runtimes[variant] = { path: resolved, info: { ...this.runtimeInfo } };
    }
    return this.status();
  }
  async setRuntime(file) {
    return this._change(async () => {
      await this.unload(); await this._inspectRuntime(file, { cpuOnly: !/vulkan|cuda/i.test(file), verified: false });
      await this._save(); return this._runtimeChanged();
    });
  }
  _runtimeAsset(releases, variant) {
    if (!['cpu', 'vulkan'].includes(variant)) throw Error('Elegí el motor de procesador o el de aceleración gráfica.');
    const pattern = new RegExp('^llama-.*-bin-win-' + variant + '-x64\\.zip$', 'i');
    for (const release of releases) { const asset = release.assets?.find(item => pattern.test(item.name)); if (asset) return { asset, release }; }
    throw Error('No encontramos el motor para Windows. Volvé a intentar más tarde.');
  }
  async installRuntime({ variant = 'cpu' } = {}) {
    return this._change(() => this._installRuntime(variant));
  }
  async _installRuntime(variant) {
    if (!['cpu', 'vulkan'].includes(variant)) throw Error('Elegí el motor de procesador o el de aceleración gráfica.');
    if (this._generating) throw Error('Primero detené la respuesta para cambiar el motor.');
    if (this.runtimePath && (this.runtimeInfo.cpuOnly === false ? 'vulkan' : 'cpu') === variant) return this.status();
    const cached = this._runtimes[variant];
    if (cached) {
      try { await this.unload(); await this._inspectRuntime(cached.path, cached.info); await this._save(); return this._runtimeChanged(); }
      catch { delete this._runtimes[variant]; }
    }
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('La preparación automática necesita Windows de 64 bits. Podés elegir tu propio llama-server.');
    if (this._download) throw Error('Esperá a que termine la descarga actual o cancelala.');
    if (this._disposed) throw abortError();
    const previous = { path: this.runtimePath, info: { ...this.runtimeInfo } }; const controller = new AbortController(); this._download = controller;
    const runtimeRoot = path.join(this.dataDir, 'runtime'); await fsp.mkdir(runtimeRoot, { recursive: true });
    const id = crypto.randomUUID(); const zip = path.join(runtimeRoot, id + '.part'), stage = path.join(runtimeRoot, 'install-' + id); let installed = false;
    const name = variant === 'vulkan' ? 'Aceleración gráfica' : 'Motor local';
    try {
      const releases = await this._json('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8', { kind: 'runtime', signal: controller.signal });
      const { asset, release } = this._runtimeAsset(releases, variant);
      if (!asset.browser_download_url.startsWith('https://github.com/ggml-org/llama.cpp/releases/download/')) throw Error('No se pudo verificar la fuente del motor.');
      const hash = asset.digest?.match(/^sha256:([\da-f]{64})$/i)?.[1];
      const result = await this._downloadFile(asset.browser_download_url, zip, { kind: 'runtime', signal: controller.signal, name, expectedSize: Number(asset.size) || 0, maxSize: 250 * 1024 ** 2, sha256: hash });
      checkAbort(controller.signal); await fsp.mkdir(stage);
      const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $root=[IO.Path]::GetFullPath($env:ORBITA_DEST)+[IO.Path]::DirectorySeparatorChar; $archive=[IO.Compression.ZipFile]::OpenRead($env:ORBITA_ZIP); try { $total=0L; if($archive.Entries.Count -gt 5000){throw 'Archive too large'}; foreach($entry in $archive.Entries){$full=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$entry.FullName)); if(-not $full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid archive path'}; $total+=$entry.Length; if($total -gt 2147483648){throw 'Archive too large'}} } finally {$archive.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory($env:ORBITA_ZIP,$env:ORBITA_DEST)";
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ORBITA_ZIP: zip, ORBITA_DEST: stage } });
      checkAbort(controller.signal);
      const findServer = async dir => { for (const entry of await fsp.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isFile() && entry.name.toLowerCase() === 'llama-server.exe') return full; if (entry.isDirectory()) { const found = await findServer(full); if (found) return found; } } return null; };
      const binary = await findServer(stage); if (!binary) throw Error('La descarga no incluyó el motor esperado. Volvé a intentarlo.');
      await this.unload();
      await this._inspectRuntime(binary, { release: release.tag_name, variant, cpuOnly: variant === 'cpu', verified: !!hash, sha256: result.digest, source: asset.browser_download_url });
      const finalDir = path.join(runtimeRoot, safeName(release.tag_name) + '-' + variant + '-' + id.slice(0, 8));
      const relative = path.relative(stage, binary); await fsp.rename(stage, finalDir); this.runtimePath = path.join(finalDir, relative); installed = true;
      this._runtimes[variant] = { path: this.runtimePath, info: { ...this.runtimeInfo } };
      await this._save(); this.emit({ type: 'download', name, received: result.received, total: result.total, status: 'done' }); return this._runtimeChanged();
    } catch (error) {
      if (!installed) { this.runtimePath = previous.path; this.runtimeInfo = previous.info; if (this._runtimes[variant]?.path.startsWith(stage + path.sep)) delete this._runtimes[variant]; }
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      this.emit({ type: 'download', name, received: 0, total: 0, status: cancelled ? 'cancelled' : 'error', text: cancelled ? 'La preparación se canceló. Podés volver a intentarlo.' : error.message });
      if (cancelled) throw abortError(); throw error;
    } finally {
      await fsp.unlink(zip).catch(() => {});
      // stage is generated exclusively inside runtimeRoot; never derived from remote paths.
      if (!installed) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (this._download === controller) this._download = null;
    }
  }
  async _ensureServer(signal) {
    if (!this.runtimePath) throw Error('Prepará el motor local en Modelos antes de empezar. Solo hace falta una vez.');
    const model = this.models.find(m => m.id === this.activeId); if (!model) throw Error('Agregá y elegí un modelo para empezar.');
    await validateGGUF(model.path); checkAbort(signal);
    const settings = this.getSettings() || {};
    const threads = Math.round(number(settings.threads, 8, 1, 256)), context = Math.round(number(settings.context, 4096, 512, 131072));
    const requestedGPU = Math.round(number(settings.gpuLayers, 0, 0, 999)); const layers = this.runtimeInfo.cpuOnly !== false ? 0 : requestedGPU;
    const key = JSON.stringify([this.runtimePath, model.id, threads, context, layers]);
    if (this._server?.ready && this._server.key === key) return;
    await this.unload(); checkAbort(signal);
    this.emit({ type: 'status', text: requestedGPU && !layers ? 'Cargando con el procesador. Este motor usa CPU.' : 'Cargando el modelo…' });
    const port = await freePort(), token = crypto.randomBytes(32).toString('hex');
    const args = ['--model', model.path, '--host', '127.0.0.1', '--port', String(port), '--api-key', token, '--ctx-size', String(context), '--threads', String(threads), '--gpu-layers', String(layers), '--parallel', '1', '--no-webui', '--jinja'];
    const child = spawn(this.runtimePath, args, { windowsHide: true, cwd: path.dirname(this.runtimePath), stdio: ['ignore', 'pipe', 'pipe'] });
    const server = { child, key, token, endpoint: `http://127.0.0.1:${port}`, ready: false, exited: false, tail: '' }; this._server = server;
    const consume = data => { const text = data.toString(); server.tail = (server.tail + text).slice(-12000); this._log(text); };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', error => { server.exited = true; server.error = error; });
    child.once('exit', code => { server.exited = true; server.code = code; server.ready = false; });
    const start = Date.now();
    try {
      while (Date.now() - start < 240000) {
        checkAbort(signal);
        if (server.exited) { await this._log('El motor cerró al cargar: ' + server.tail); throw Error(/memory|alloc|out of/i.test(server.tail) ? 'El modelo necesita más memoria de la que está libre. Probá con uno más pequeño o bajá el contexto en Ajustes.' : 'El motor no pudo cargar este modelo. Probá otro archivo GGUF o prepará un motor más nuevo. El detalle quedó guardado en la carpeta de datos.'); }
        try {
          const response = await this._fetch(server.endpoint + '/health', { headers: { Authorization: 'Bearer ' + token }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
          await response.body?.cancel().catch(() => {});
          if (response.ok) { server.ready = true; this._runtimeChanged(); return; }
        } catch { checkAbort(signal); }
        await delay(350, signal);
      }
      throw Error('El modelo tardó demasiado en cargar. Probá con uno más pequeño o bajá el contexto en Ajustes.');
    } catch (error) { await this.unload(); throw error; }
  }
  async generate(messages, { signal, onDelta = () => {}, responseFormat } = {}) {
    if (this._disposed) throw Error('El motor se cerró. Volvé a abrir la app.');
    if (this._changing) throw Error('El modelo o el motor está cambiando. Esperá a que termine para enviar un mensaje.');
    if (this._generating) throw Error('Ya hay una respuesta en curso. Detenela antes de enviar otra.');
    checkAbort(signal); this._generating = true;
    const internalAbort = new AbortController(); this._generationAbort = internalAbort;
    signal = signal ? AbortSignal.any([signal, internalAbort.signal]) : internalAbort.signal;
    let reader;
    try {
      await this._ensureServer(signal); checkAbort(signal);
      const settings = this.getSettings() || {}, server = this._server;
      this.emit({ type: 'status', text: 'Pensando…' });
      let response;
      try { response = await this._fetch(server.endpoint + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + server.token }, signal, body: JSON.stringify({ messages, stream: true, temperature: number(settings.temperature, 0.3, 0, 2), max_tokens: Math.round(number(settings.maxTokens, 2048, 1, 32768)), cache_prompt: true, ...(responseFormat ? { response_format: responseFormat } : {}) }) }); }
      catch (error) { if (signal?.aborted) throw abortError(); throw Error('Se perdió la conexión con el motor local. Intentá de nuevo.'); }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 8000); await this._log('Respuesta del motor: ' + detail);
        throw Error(/context|token.*limit|exceed/i.test(detail) ? 'La conversación ya no entra en el contexto del modelo. Empezá una nueva o aumentá el contexto en Ajustes.' : 'El modelo no pudo responder. Intentá de nuevo o elegí otro modelo.');
      }
      if (!response.body) throw Error('El motor devolvió una respuesta vacía. Intentá de nuevo.');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '', full = '', doneEvent = false, finished = false;
      const parseEvent = frame => {
        const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!payload) return;
        if (payload.trim() === '[DONE]') { doneEvent = true; return; }
        let data; try { data = JSON.parse(payload); } catch { throw Error('El motor devolvió una respuesta incompleta. Intentá de nuevo.'); }
        if (data.error) throw Error('El modelo no pudo terminar la respuesta. Probá con un mensaje más corto.');
        if (data.choices?.[0]?.finish_reason) finished = true;
        const text = data.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) { full += text; onDelta(text); }
      };
      while (!doneEvent) {
        checkAbort(signal); const { done, value } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) { const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length); parseEvent(frame); if (doneEvent) break; }
        if (pending.length > 4 * 1024 ** 2) throw Error('El motor devolvió una respuesta demasiado grande. Detené el modelo y volvé a intentar.');
        if (done) { if (pending.trim() && !doneEvent) parseEvent(pending); break; }
      }
      checkAbort(signal);
      if (!doneEvent && !finished) throw Error('El motor se detuvo antes de terminar la respuesta. Intentá de nuevo.');
      if (!full.trim()) throw Error('El modelo no escribió una respuesta. Probá otro mensaje o aumentá la longitud de respuesta en Ajustes.');
      return full;
    } catch (error) { if (signal?.aborted || error.name === 'AbortError') throw abortError(); throw error; }
    finally { await reader?.cancel().catch(() => {}); this._generating = false; if (this._generationAbort === internalAbort) this._generationAbort = null; if (this.getSettings()?.keepLoaded === false) await this.unload(); }
  }
  async unload() {
    const server = this._server; this._server = null; if (!server) return;
    server.ready = false;
    if (!server.exited) await new Promise(resolve => { const timer = setTimeout(resolve, 3000); server.child.once('exit', () => { clearTimeout(timer); resolve(); }); server.child.kill(); });
  }
  async dispose() { this._disposed = true; this.cancelDownload(); this._generationAbort?.abort(); await this._changePromise?.catch(() => {}); await this._downloadTask?.catch(() => {}); await this.unload(); await this._saveQueue.catch(() => {}); }
}

module.exports = { ModelEngine };
