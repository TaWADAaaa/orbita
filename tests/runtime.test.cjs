'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ModelEngine } = require('../runtime.cjs');

function gguf() { const data = Buffer.alloc(2048); data.write('GGUF'); data.writeUInt32LE(3, 4); data.writeBigUInt64LE(1n, 8); data.writeBigUInt64LE(1n, 16); return data; }
async function setup(t, settings = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-runtime-test-'));
  const events = [], engine = new ModelEngine({ dataDir: dir, emit: e => events.push(e), getSettings: () => settings }); await engine.init();
  t.after(async () => { await engine.dispose(); const target = path.resolve(dir), root = path.resolve(os.tmpdir()) + path.sep; if (!target.startsWith(root) || !path.basename(target).startsWith('orbita-runtime-test-')) throw Error('Unexpected test cleanup path'); await fs.rm(target, { recursive: true, force: true }); });
  return { dir, engine, events };
}
test('library persists a valid GGUF, deduplicates imports, and removing preserves the file', async t => {
  const { dir, engine, events } = await setup(t); const file = path.join(dir, 'coding.gguf'); await fs.writeFile(file, gguf());
  const imported = await engine.importLocal(file); assert.equal(imported.models.length, 1); assert.equal(imported.activeModel, imported.models[0].id);
  await engine.importLocal(file); assert.equal(engine.models.length, 1); assert.equal(events.at(-1).type, 'models');
  const reloaded = new ModelEngine({ dataDir: dir }); await reloaded.init(); assert.equal(reloaded.activeId, engine.activeId); assert.equal(reloaded.models[0].size, 2048); await reloaded.dispose();
  await engine.remove(engine.activeId); assert.equal(engine.models.length, 0); assert.equal(engine.activeId, null); assert.equal((await fs.stat(file)).size, 2048);
});
test('rejects renamed HTML, short files, unsupported header versions and split models', async t => {
  const { dir, engine } = await setup(t);
  const invalid = [ ['page.gguf', Buffer.alloc(2048, 60)], ['tiny.gguf', Buffer.from('GGUF')], ['part-00001-of-00002.gguf', gguf()], ['old.gguf', gguf()] ]; invalid[3][1].writeUInt32LE(0, 4);
  for (const [name, bytes] of invalid) { const file = path.join(dir, name); await fs.writeFile(file, bytes); await assert.rejects(engine.importLocal(file), /GGUF|gguf/); }
  assert.equal(engine.models.length, 0);
});
test('startup ignores disappeared or invalid model files', async t => {
  const { dir, engine } = await setup(t); const file = path.join(dir, 'gone.gguf'); await fs.writeFile(file, gguf()); await engine.importLocal(file); await fs.unlink(file);
  const loaded = new ModelEngine({ dataDir: dir }); await loaded.init(); assert.equal(loaded.models.length, 0); assert.equal(loaded.activeId, null); await loaded.dispose();
});
test('public catalog excludes split and auxiliary projector files', async t => {
  const { engine } = await setup(t); engine._fetch = async () => Response.json({ siblings: [ { rfilename: 'model-Q4_K_M.gguf', lfs: { size: 42, sha256: 'a'.repeat(64) } }, { rfilename: 'part-00001-of-00002.gguf' }, { rfilename: 'mmproj-model.gguf' }, { rfilename: 'config.json' } ] });
  const files = await engine.getFiles('author/model'); assert.equal(files.files.length, 1); assert.equal(files.files[0].size, 42); assert.match(files.files[0].url, /^https:\/\/huggingface.co\/author\/model\/resolve\/main\//); assert.equal(files.files[0].sha256, 'a'.repeat(64));
});
test('rejects non-Hugging Face URLs, credentials, HTTP and unsafe redirect destinations', async t => {
  const { engine } = await setup(t); let calls = 0; engine._fetch = async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); };
  for (const url of ['http://huggingface.co/a/b', 'https://example.com/a/b', 'https://huggingface.co.evil.test/a/b', 'https://a:b@huggingface.co/a/b', 'https://huggingface.co:444/a/b']) await assert.rejects(engine.resolve(url));
  assert.equal(calls, 0); await assert.rejects(engine.resolve('https://huggingface.co/a/b/resolve/main/model.gguf'), /HTTPS|Hugging Face/); assert.equal(calls, 1);
});
test('downloads verified GGUF and cleans incomplete or hash-mismatched files', async t => {
  const { dir, engine, events } = await setup(t); const bytes = gguf(), url = 'https://huggingface.co/a/b/resolve/main/model.gguf';
  engine._fetch = async (value, options) => options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': bytes.length } }) : new Response(bytes, { headers: { 'content-length': bytes.length } });
  const { createHash } = require('node:crypto'); const sha = createHash('sha256').update(bytes).digest('hex');
  await engine.download({ url, sha256: sha }); assert.equal(engine.models.length, 1); assert.equal(events.findLast(e => e.type === 'download').status, 'done');
  await assert.rejects(engine.download({ url, sha256: '0'.repeat(64) }), /no coincide/); assert.equal(engine.models.length, 1);
  assert.equal((await fs.readdir(path.join(dir, 'models'))).filter(f => f.endsWith('.part')).length, 0);
});
test('reserves the download before resolving and cancellation leaves no temporary file', async t => {
  const { dir, engine, events } = await setup(t); const url = 'https://huggingface.co/a/b/resolve/main/model.gguf';
  let release; const head = new Promise(resolve => { release = resolve; }); engine.resolve = async () => { await head; return { url, name: 'model.gguf', size: 2048 }; };
  const first = engine.download({ url }); await assert.rejects(engine.download({ url }), /descarga en curso/); engine.cancelDownload(); release(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(engine.models.length, 0); assert.equal((await fs.readdir(path.join(dir, 'models'))).length, 0); assert.equal(events.findLast(e => e.type === 'download').status, 'cancelled');
});
test('cancelling after bytes arrive closes the partial file and never imports it', async t => {
  const { dir, engine } = await setup(t); const bytes = gguf(), events = [], url = 'https://huggingface.co/a/b/resolve/main/model.gguf';
  engine._fetch = async (value, options) => options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': bytes.length } }) : new Response(bytes, { headers: { 'content-length': bytes.length } });
  engine.emit = event => { events.push(event); if (event.type === 'download' && event.status === 'downloading' && event.received > 0) engine.cancelDownload(); };
  await assert.rejects(engine.download({ url }), { name: 'AbortError' }); assert.equal(engine.models.length, 0); assert.equal((await fs.readdir(path.join(dir, 'models'))).length, 0); assert.equal(events.at(-1).status, 'cancelled');
});
test('a downloaded non-GGUF is discarded even when its length and checksum match', async t => {
  const { dir, engine } = await setup(t); const bytes = Buffer.alloc(2048, 60), url = 'https://huggingface.co/a/b/resolve/main/model.gguf';
  engine._fetch = async (value, options) => options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': bytes.length } }) : new Response(bytes, { headers: { 'content-length': bytes.length } });
  await assert.rejects(engine.download({ url }), /no parece un modelo GGUF/); assert.equal(engine.models.length, 0); assert.equal((await fs.readdir(path.join(dir, 'models'))).length, 0);
});
test('SSE preserves split UTF-8, CRLF frames, ignored comments and full completion', async t => {
  const { engine } = await setup(t); engine._ensureServer = async () => { engine._server = { endpoint: 'http://127.0.0.1:9999', token: 'private' }; };
  const source = ': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"Hola 👋"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" señor"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(source); const deltas = []; let request;
  engine._fetch = async (url, options) => { request = options; return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } })); };
  const result = await engine.generate([{ role: 'user', content: 'Hola' }], { onDelta: text => deltas.push(text) }); assert.equal(result, 'Hola 👋 señor'); assert.equal(deltas.join(''), result); assert.equal(request.headers.Authorization, 'Bearer private'); assert.equal(JSON.parse(request.body).stream, true); engine._server = null;
});
test('SSE truncated stream reports a real error instead of inventing a completion', async t => {
  const { engine } = await setup(t); engine._ensureServer = async () => { engine._server = { endpoint: 'http://127.0.0.1:9999', token: 'private' }; };
  engine._fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Parcial"}}]}\n\n');
  await assert.rejects(engine.generate([]), /antes de terminar/); engine._server = null;
});
test('aborted generation exits cleanly and cannot start a second concurrent response', async t => {
  const { engine } = await setup(t); let release; const waiting = new Promise(resolve => { release = resolve; });
  engine._ensureServer = async () => { await waiting; }; const controller = new AbortController(); const first = engine.generate([], { signal: controller.signal });
  await assert.rejects(engine.generate([]), /respuesta en curso/); controller.abort(); release(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(engine._generating, false);
});
test('no installed engine returns a clear actionable error and no fake output', async t => {
  const { engine } = await setup(t); assert.equal(engine.status().ready, false); await assert.rejects(engine.generate([]), /Prepará el motor local/);
});
test('runtime assets match the requested CPU or Vulkan build, never CUDA or ARM', async t => {
  const { engine } = await setup(t);
  const releases = [{ tag_name: 'b1', assets: [{ name: 'llama-b1-bin-win-cuda-12.4-x64.zip' }, { name: 'llama-b1-bin-win-vulkan-arm64.zip' }] }, { tag_name: 'b0', assets: [{ name: 'llama-b0-bin-win-cpu-x64.zip' }, { name: 'llama-b0-bin-win-vulkan-x64.zip' }] }];
  assert.equal(engine._runtimeAsset(releases, 'cpu').asset.name, 'llama-b0-bin-win-cpu-x64.zip');
  assert.equal(engine._runtimeAsset(releases, 'vulkan').asset.name, 'llama-b0-bin-win-vulkan-x64.zip');
  assert.throws(() => engine._runtimeAsset(releases, 'cuda'), /Elegí el motor/);
  assert.throws(() => engine._runtimeAsset([], 'vulkan'), /No encontramos/);
});
test('agent response format is forwarded to the local server without changing the schema', async t => {
  const { engine } = await setup(t); let body;
  engine._ensureServer = async () => { engine._server = { endpoint: 'http://127.0.0.1:9999', token: 'private' }; };
  engine._fetch = async (url, options) => { body = JSON.parse(options.body); return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
  const responseFormat = { type: 'json_schema', json_schema: { name: 'action', strict: true, schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } } };
  await engine.generate([], { responseFormat }); assert.deepEqual(body.response_format, responseFormat); engine._server = null;
});
test('each model or runtime change locks before awaiting and excludes generation and other changes', async t => {
  for (const name of ['select', 'remove', 'setRuntime', 'installRuntime']) await t.test(name, async t => {
    const { engine } = await setup(t); let release, starts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    engine.models = [{ id: 'a' }, { id: 'b' }]; engine.activeId = 'a';
    engine.unload = async () => { await gate; }; engine._inspectRuntime = async () => engine.status();
    engine._installRuntime = async () => { await gate; return engine.status(); }; engine._ensureServer = async () => { starts++; };
    const mutation = name === 'select' ? engine.select('b') : name === 'remove' ? engine.remove('a') : name === 'setRuntime' ? engine.setRuntime('llama-server.exe') : engine.installRuntime({ variant: 'vulkan' });
    try {
      assert.equal(engine._changing, true);
      await assert.rejects(engine.generate([]), /está cambiando/);
      await assert.rejects(engine.remove('b'), /cambio.*en curso/);
      await assert.rejects(engine.installRuntime(), /cambio.*en curso/);
      assert.equal(starts, 0); assert.equal(engine._changing, true);
    } finally { release(); await mutation; }
    assert.equal(engine._changing, false);
  });
});
test('active generation rejects all changes until its cancellation finishes', async t => {
  const { engine } = await setup(t); let release;
  const gate = new Promise(resolve => { release = resolve; }); engine._ensureServer = async () => { await gate; };
  const controller = new AbortController(), generation = engine.generate([], { signal: controller.signal });
  try {
    for (const change of [() => engine.select('a'), () => engine.remove('a'), () => engine.setRuntime('llama-server.exe'), () => engine.installRuntime({ variant: 'vulkan' })]) await assert.rejects(change(), /detené la respuesta/);
    assert.equal(engine._changing, false); assert.equal(engine._generating, true);
  } finally { controller.abort(); release(); await assert.rejects(generation, { name: 'AbortError' }); }
  assert.equal(engine._generating, false);
});
test('failed changes release the lock and dispose cancels downloads but awaits their cleanup', async t => {
  const { engine } = await setup(t);
  await assert.rejects(engine.select('missing'), /ya no está/); assert.equal(engine._changing, false);
  let started, releaseCleanup, cancelled = false, disposed = false;
  const begin = new Promise(resolve => { started = resolve; }), cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  engine._installRuntime = async () => {
    const controller = new AbortController(); engine._download = controller;
    try { await new Promise(resolve => { controller.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); started(); }); await cleanup; }
    finally { engine._download = null; }
  };
  const mutation = engine.installRuntime({ variant: 'vulkan' }); await begin;
  const disposal = engine.dispose().then(() => { disposed = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true); assert.equal(disposed, false); assert.equal(engine._changing, true); }
  finally { releaseCleanup(); await mutation; await disposal; }
  assert.equal(engine._changing, false); await assert.rejects(engine.generate([]), /motor se cerró/);
});
test('dispose also awaits a model download cancellation before finishing', async t => {
  const { engine, events } = await setup(t); let started, releaseCleanup, disposed = false;
  const begin = new Promise(resolve => { started = resolve; }), cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const url = 'https://huggingface.co/a/b/resolve/main/model.gguf'; engine.resolve = async () => ({ url, name: 'model.gguf', size: 2048 });
  engine._downloadFile = async (source, target, { signal }) => { await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); started(); }); await cleanup; throw Object.assign(new Error('Se detuvo.'), { name: 'AbortError' }); };
  const download = engine.download({ url }); const cancelled = assert.rejects(download, { name: 'AbortError' }); await begin;
  const disposal = engine.dispose().then(() => { disposed = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false); }
  finally { releaseCleanup(); await cancelled; await disposal; }
  assert.equal(engine._downloadTask, null); assert.equal(events.at(-1).status, 'cancelled');
});
