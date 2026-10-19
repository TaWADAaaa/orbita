'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Backend, DEFAULT_SETTINGS, validateSettings } = require('../backend.cjs');
const { ACCESS_LEVELS, permissionFor } = require('../access-policy.cjs');

const json = value => JSON.stringify(value);
async function fixture(t, level = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-access-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await fs.mkdir(project);
  const responses = [], events = [], prompts = [], calls = [];
  const terminals = {
    list: () => [],
    execute: async (command, opts) => { calls.push({ tool: 'run_command', command, ...opts }); return 'Código de salida: 0\nprueba'; },
    start: async opts => { calls.push({ tool: 'start_command', ...opts }); return { id: 'terminal-test', status: 'running' }; },
    get: async args => { calls.push({ tool: 'read_terminal', ...args }); return { id: args.id, cwd: await fs.realpath(project), output: 'salida de consola' }; },
    input: async args => { calls.push({ tool: 'send_terminal', ...args }); return { sent: true }; },
    stop: async args => { calls.push({ tool: 'stop_terminal', ...args }); return { stopped: true }; },
    dispose: async () => {}
  };
  const web = {
    search: async args => { calls.push({ tool: 'web_search', ...args }); return { query: args.query, results: [{ title: 'prueba', url: 'https://example.com' }] }; },
    fetchPage: async args => { calls.push({ tool: 'read_url', ...args }); return { url: args.url, title: 'Ejemplo', text: 'Página real de prueba', truncated: false }; }
  };
  const engine = { activeId: 'test', models: [], status: () => ({ ready: true }), async generate(messages, options) {
    prompts.push(messages); const response = responses.shift() || json({ tool: 'reply', content: 'Listo.' }); options.onDelta(response); return response;
  } };
  const backend = new Backend({ dataDir, engine, terminals, web, emit: event => events.push(event) });
  await backend.init(); await backend.setProject(project);
  await backend.saveSettings({ settings: { accessLevel: level, maxSteps: 50 } });
  t.after(async () => { await backend.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, dataDir, responses, events, prompts, calls, backend, engine };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('No llegó la acción esperada.');
}

test('seven levels have the requested names and strict settings default to restricted', () => {
  assert.equal(DEFAULT_SETTINGS.accessLevel, 1);
  assert.deepEqual(ACCESS_LEVELS.map(item => item.name), ['Restricted', 'Read files', 'Create files', 'Edit files', 'Use the internet', 'Use the console', 'Full access']);
  for (const value of [0, 8, 3.5, null, true, 'full']) assert.throws(() => validateSettings({ accessLevel: value }));
  assert.equal(validateSettings({ accessLevel: '7' }).accessLevel, 7);
  assert.throws(() => permissionFor('invented', { level: 7 }));
});

for (let level = 1; level <= 7; level++) test(`level ${level}: every real tool follows central approval policy`, async t => {
  const f = await fixture(t, level);
  await fs.writeFile(path.join(f.project, 'existing.txt'), 'original');
  await fs.writeFile(path.join(f.project, 'remove.txt'), 'borrar');
  const actions = [
    [{ tool: 'list_files', path: '.' }, 2],
    [{ tool: 'read_file', path: 'existing.txt' }, 2],
    [{ tool: 'search', path: '.', query: 'original' }, 2],
    [{ tool: 'write_file', path: 'new.txt', content: 'nuevo' }, 3],
    [{ tool: 'write_file', path: 'existing.txt', content: 'editado' }, 4],
    [{ tool: 'make_directory', path: 'empty/nested' }, 3],
    [{ tool: 'web_search', query: 'ejemplo' }, 5],
    [{ tool: 'read_url', url: 'https://example.com' }, 5],
    [{ tool: 'run_command', command: 'echo prueba' }, 6],
    [{ tool: 'start_command', command: 'echo servidor' }, 6],
    [{ tool: 'read_terminal', id: 'terminal-test' }, 6],
    [{ tool: 'send_terminal', id: 'terminal-test', text: 'hola\n' }, 6],
    [{ tool: 'stop_terminal', id: 'terminal-test' }, 6],
    [{ tool: 'delete_file', path: 'remove.txt' }, 7]
  ];
  f.responses.push(...actions.map(([action]) => json(action)), json({ tool: 'reply', content: 'Terminado.' }));
  const seen = [];
  const emit = f.backend.emit;
  f.backend.emit = event => {
    emit(event);
    if (event.type === 'tool') {
      seen.push(event.tool);
      if (event.tool.approvalRequired) setImmediate(() => f.backend.approveTool({ id: event.tool.id, approved: true }));
    }
  };
  const result = await f.backend.sendMessage({ mode: 'agent', text: 'Usá las herramientas de prueba.' });
  assert.equal(seen.length, actions.length);
  for (let index = 0; index < actions.length; index++) {
    const [action, required] = actions[index], proposal = seen[index];
    assert.equal(proposal.data.tool, action.tool);
    assert.equal(proposal.accessLevel, level);
    assert.equal(proposal.requiredLevel, required);
    assert.equal(proposal.approvalRequired, level < required, action.tool);
    assert.equal(proposal.status, level < required ? undefined : 'En curso…', action.tool);
    assert.equal(proposal.authorization, level < required ? 'user' : 'level');
  }
  assert.ok(result.chat.messages.filter(item => item.role === 'tool').every(item => item.status === 'Listo'));
  assert.match(result.chat.messages.find(item => item.data?.tool === 'run_command').result, /Proceso terminado; esta es la salida final/);
  assert.match(result.chat.messages.find(item => item.data?.tool === 'run_command').result, /Código de salida: 0\nprueba/);
  assert.equal(await fs.readFile(path.join(f.project, 'new.txt'), 'utf8'), 'nuevo');
  assert.equal(await fs.readFile(path.join(f.project, 'existing.txt'), 'utf8'), 'editado');
  await assert.rejects(fs.stat(path.join(f.project, 'remove.txt')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(f.project, 'empty/nested'))).isDirectory());
  assert.equal(f.calls.length, 9);
  assert.equal(f.calls.find(item => item.tool === 'run_command').cwd, await fs.realpath(f.project));
  assert.ok(f.calls.find(item => item.tool === 'run_command').signal instanceof AbortSignal);
  assert.equal(f.calls.find(item => item.tool === 'start_command').signal, undefined);
  assert.ok(f.prompts.at(-1).some(item => item.content.includes('Página real de prueba')));
  assert.ok(f.events.some(item => item.type === 'filesChanged' && item.kind === 'deleted'));
  assert.equal(f.events.filter(item => item.type === 'webResult').length, 2);
  assert.ok(f.events.some(item => item.type === 'webResult' && item.data.results?.[0].url === 'https://example.com'));
  assert.ok(f.events.some(item => item.type === 'webResult' && item.data.text === 'Página real de prueba'));
  assert.ok((await f.backend.listProjectFiles({ includeDirectories: true })).some(item => item.path === 'empty/nested' && item.directory));
  assert.ok(!(await f.backend.listProjectFiles()).some(item => item.directory));
});

test('an active job keeps its permission snapshot when the saved level changes', async t => {
  const f = await fixture(t, 1);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'antes');
  f.responses.push(json({ tool: 'read_file', path: 'a.txt' }), json({ tool: 'write_file', path: 'a.txt', content: 'después' }));
  const pending = f.backend.sendMessage({ mode: 'agent', text: 'Leé y editá.' });
  const first = await waitFor(() => f.events.find(item => item.type === 'tool'));
  await f.backend.saveSettings({ settings: { accessLevel: 7 } });
  await f.backend.approveTool({ id: first.tool.id, approved: true });
  const second = await waitFor(() => f.events.find(item => item.type === 'tool' && item.tool.data.tool === 'write_file'));
  assert.equal(second.tool.accessLevel, 1); assert.equal(second.tool.approvalRequired, true);
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'antes');
  assert.match(f.prompts[1][0].content, /nivel 1\/7/);
  await f.backend.approveTool({ id: second.tool.id, approved: false }); await pending;
  assert.equal(f.backend.settings.accessLevel, 7);
  f.responses.push(json({ tool: 'write_file', path: 'next.txt', content: 'sí' }));
  await f.backend.sendMessage({ mode: 'agent', text: 'Otra tarea.' });
  assert.equal(f.events.filter(item => item.type === 'tool').at(-1).tool.accessLevel, 7);
});

test('chat and malformed JSON cannot bypass permission checks at full access', async t => {
  const f = await fixture(t, 7);
  f.responses.push(json({ tool: 'run_command', command: 'echo no' }));
  await f.backend.sendMessage({ mode: 'chat', text: 'Solo mostrar.' });
  assert.equal(f.calls.length, 0); assert.equal(f.events.filter(item => item.type === 'tool').length, 0);
  f.responses.push(json({ tool: 'write_file', path: 'bad.txt', content: 'no', accessLevel: 7 }));
  const malformed = await f.backend.sendMessage({ mode: 'agent', text: 'Acción alterada.' });
  assert.match(malformed.chat.messages.find(item => item.role === 'tool').result, /no válidos/);
  await assert.rejects(fs.stat(path.join(f.project, 'bad.txt')), { code: 'ENOENT' });
});

test('restricted reads and internet do nothing when denied', async t => {
  const f = await fixture(t, 1);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'contenido privado');
  for (const data of [{ tool: 'read_file', path: 'a.txt' }, { tool: 'web_search', query: 'prueba' }]) {
    const offset = f.events.length; f.responses.push(json(data));
    const pending = f.backend.sendMessage({ mode: 'agent', text: 'Probá.' });
    const event = await waitFor(() => f.events.slice(offset).find(item => item.type === 'tool'));
    assert.equal(event.tool.result, undefined);
    await f.backend.approveTool({ id: event.tool.id, approved: false });
    const result = await pending;
    assert.match(result.chat.messages.find(item => item.role === 'tool').result, /no aprobó/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.filter(item => item.type === 'webResult').length, 0);
});

test('deletion requires approval at level 6 and restores arbitrary regular-file bytes', async t => {
  const f = await fixture(t, 6), bytes = Buffer.from([0, 1, 2, 255, 10]);
  await fs.writeFile(path.join(f.project, 'binary.bin'), bytes);
  f.responses.push(json({ tool: 'delete_file', path: 'binary.bin' }));
  const pending = f.backend.sendMessage({ mode: 'agent', text: 'Borrá el archivo.' });
  const event = await waitFor(() => f.events.find(item => item.type === 'tool'));
  assert.equal(event.tool.approvalRequired, true);
  assert.deepEqual(await fs.readFile(path.join(f.project, 'binary.bin')), bytes);
  await f.backend.approveTool({ id: event.tool.id, approved: true }); const changed = await pending;
  const tool = changed.chat.messages.find(item => item.role === 'tool');
  await assert.rejects(fs.stat(path.join(f.project, 'binary.bin')), { code: 'ENOENT' });
  await f.backend.restoreChange({ chatId: changed.chat.id, toolId: tool.id });
  assert.deepEqual(await fs.readFile(path.join(f.project, 'binary.bin')), bytes);
});

test('deletion preserves edits made while approval waits and rejects folders or escapes', async t => {
  const f = await fixture(t, 1);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'original');
  f.responses.push(json({ tool: 'delete_file', path: 'a.txt' }));
  const pending = f.backend.sendMessage({ mode: 'agent', text: 'Borrá.' });
  const event = await waitFor(() => f.events.find(item => item.type === 'tool'));
  await fs.writeFile(path.join(f.project, 'a.txt'), 'cambio reciente');
  await f.backend.approveTool({ id: event.tool.id, approved: true }); const result = await pending;
  assert.match(result.chat.messages.find(item => item.role === 'tool').result, /cambió después/);
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'cambio reciente');
  await f.backend.saveSettings({ settings: { accessLevel: 7 } });
  await fs.mkdir(path.join(f.project, 'folder'));
  for (const relative of ['folder', '../outside', '.env']) {
    f.responses.push(json({ tool: 'delete_file', path: relative }));
    const denied = await f.backend.sendMessage({ mode: 'agent', text: 'Borrá.' });
    assert.equal(denied.chat.messages.find(item => item.role === 'tool').status, 'No se pudo completar.');
  }
  assert.ok((await fs.stat(path.join(f.project, 'folder'))).isDirectory());
});

test('undo deletion preserves a replacement file and rejects a new parent junction', async t => {
  const f = await fixture(t, 7);
  await fs.mkdir(path.join(f.project, 'folder')); await fs.writeFile(path.join(f.project, 'folder/a.txt'), 'original');
  f.responses.push(json({ tool: 'delete_file', path: 'folder/a.txt' }));
  const deleted = await f.backend.sendMessage({ mode: 'agent', text: 'Borrá.' }), tool = deleted.chat.messages.find(item => item.role === 'tool');
  await fs.writeFile(path.join(f.project, 'folder/a.txt'), 'nuevo');
  await assert.rejects(f.backend.restoreChange({ chatId: deleted.chat.id, toolId: tool.id }), /más recientes/);
  await fs.rm(path.join(f.project, 'folder/a.txt')); await fs.rename(path.join(f.project, 'folder'), path.join(f.project, 'old-folder'));
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.project, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.backend.restoreChange({ chatId: deleted.chat.id, toolId: tool.id }), /enlaces/);
  await assert.rejects(fs.stat(path.join(outside, 'a.txt')), { code: 'ENOENT' });
});

test('manual editor saves use compare-and-swap and retain a backup without AI permission', async t => {
  const f = await fixture(t, 1);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'original');
  const original = await f.backend.readProjectFile({ path: 'a.txt' });
  assert.match(original.hash, /^[a-f0-9]{64}$/); assert.equal(original.truncated, false);
  const saved = await f.backend.saveProjectFile({ path: 'a.txt', content: 'nuevo', expectedHash: original.hash });
  assert.match(saved.hash, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'backups', saved.backupId, 'original.txt'), 'utf8'), 'original');
  await assert.rejects(f.backend.saveProjectFile({ path: 'a.txt', content: 'obsoleto', expectedHash: original.hash }), /cambió mientras/);
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'nuevo');
  assert.ok(f.events.some(item => item.type === 'filesChanged' && item.path === 'a.txt'));
});

test('failed web requests never publish a page or search event', async t => {
  const f = await fixture(t, 5);
  f.backend.web.search = async () => { throw Error('No se pudo buscar.'); };
  f.backend.web.fetchPage = async () => { throw Error('No se pudo leer.'); };
  f.responses.push(json({ tool: 'web_search', query: 'prueba' }), json({ tool: 'read_url', url: 'https://example.com' }));
  const result = await f.backend.sendMessage({ mode: 'agent', text: 'Buscá y leé.' });
  assert.equal(f.events.filter(item => item.type === 'webResult').length, 0);
  assert.ok(result.chat.messages.filter(item => item.role === 'tool').every(item => item.status === 'No se pudo completar.'));
});

test('AI cannot inspect, write to, or stop a console from another project', async t => {
  const f = await fixture(t, 7);
  f.backend.terminals.get = async args => ({ id: args.id, cwd: f.root, output: 'other project output' });
  for (const data of [{ tool: 'read_terminal', id: 'foreign' }, { tool: 'send_terminal', id: 'foreign', text: 'echo no' }, { tool: 'stop_terminal', id: 'foreign' }]) {
    f.responses.push(json(data));
    const result = await f.backend.sendMessage({ mode: 'agent', text: 'Usá la consola.' });
    const tool = result.chat.messages.find(item => item.role === 'tool');
    assert.equal(tool.status, 'No se pudo completar.'); assert.match(tool.result, /otra carpeta/);
    assert.ok(!tool.result.includes('other project output'));
  }
  assert.equal(f.calls.length, 0);
});

test('stop while a background console is being created still stops that console', async t => {
  const f = await fixture(t, 6);
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  f.backend.terminals.start = async () => { started(); await paused; return { id: 'slow-console', status: 'running' }; };
  f.responses.push(json({ tool: 'start_command', command: 'echo server' }));
  const pending = f.backend.sendMessage({ mode: 'agent', text: 'Iniciá.' });
  await ready; await f.backend.stop(); release(); await pending;
  assert.ok(f.calls.some(item => item.tool === 'stop_terminal' && item.id === 'slow-console'));
});

test('background consoles survive a completed task and stop cancels consoles started by the active job', async t => {
  const f = await fixture(t, 6);
  f.responses.push(json({ tool: 'start_command', command: 'echo server' }));
  await f.backend.sendMessage({ mode: 'agent', text: 'Iniciá el servidor.' });
  assert.equal(f.calls.filter(item => item.tool === 'stop_terminal').length, 0);
  f.responses.push(json({ tool: 'start_command', command: 'echo another server' }));
  f.engine.generate = async (messages, options) => {
    const response = f.responses.shift();
    if (response) return response;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('stop'), { name: 'AbortError' })), { once: true }));
  };
  const pending = f.backend.sendMessage({ mode: 'agent', text: 'Otra tarea.' });
  await waitFor(() => f.calls.filter(item => item.tool === 'start_command').length === 2);
  await f.backend.stop(); await pending;
  assert.ok(f.calls.some(item => item.tool === 'stop_terminal' && item.id === 'terminal-test'));
});
