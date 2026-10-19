'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Backend, DEFAULT_SETTINGS, AGENT_RESPONSE_FORMAT } = require('../backend.cjs');

async function fixture(t, responses = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-backend-'));
  const dataDir = path.join(root, 'data'), project = path.join(root, 'project');
  await fs.mkdir(project); const events = [], requests = [], options = [];
  const engine = {
    models: [{ id: 'local-model', name: 'Modelo de prueba' }], activeId: 'local-model', status: () => ({ ready: true }),
    async generate(messages, opts) {
      const { signal, onDelta } = opts; requests.push(messages); options.push(opts);
      const next = responses.shift();
      if (typeof next === 'function') return next({ messages, signal, onDelta });
      const text = next ?? 'Listo.'; onDelta(text); return text;
    }
  };
  const backend = new Backend({ dataDir, engine, emit: event => events.push(event) });
  await backend.init();
  t.after(async () => { await backend.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, dataDir, events, requests, options, engine, backend, responses };
}
async function waitFor(predicate, milliseconds = 3000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('No llegó el evento esperado.');
}
const toolJSON = data => JSON.stringify(data);
async function approvedWrite(f, filename, content) {
  const offset = f.events.length;
  f.responses.push(toolJSON({ tool: 'write_file', path: filename, content }), toolJSON({ tool: 'reply', content: 'Guardado.' }));
  const pending = f.backend.sendMessage({ text: `Guardá ${filename}`, mode: 'agent' });
  const proposal = await waitFor(() => f.events.slice(offset).find(event => event.type === 'tool'));
  await f.backend.approveTool({ id: proposal.tool.id, approved: true });
  const result = await pending;
  return { ...result, tool: result.chat.messages.find(message => message.role === 'tool') };
}

test('settings, project and last chat survive restart; invalid settings never persist', async t => {
  const f = await fixture(t, ['Hola.']);
  assert.deepEqual(f.backend.settings, DEFAULT_SETTINGS);
  await f.backend.setProject(f.project);
  await f.backend.saveSettings({ settings: { theme: 'custom', accent: '#aabbcc', threads: 4, animations: false } });
  await assert.rejects(f.backend.saveSettings({ settings: { threads: -1 } }), /entre/);
  const result = await f.backend.sendMessage({ text: 'Ayudame', mode: 'chat' });
  const other = new Backend({ dataDir: f.dataDir, engine: f.engine });
  const restored = await other.init();
  assert.equal(restored.settings.accent, '#aabbcc'); assert.equal(restored.settings.threads, 4); assert.equal(restored.settings.animations, false);
  assert.equal(restored.project.path, await fs.realpath(f.project)); assert.equal(restored.lastChatId, result.chat.id);
  assert.equal((await other.getChat({ id: result.chat.id })).messages.at(-1).content, 'Hola.');
  await other.resetSettings(); assert.deepEqual(other.settings, DEFAULT_SETTINGS); assert.equal(other.chats.length, 1);
});

test('chat streams Spanish responses and never executes a JSON tool or a casual code block', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'bad.txt', content: 'bad' }), 'Ejemplo:\n```json\n{"tool":"write_file","path":"bad.txt","content":"bad"}\n```']);
  await f.backend.saveSettings({ settings: { language: 'es' } });
  await f.backend.setProject(f.project);
  await f.backend.sendMessage({ text: 'Mostrá un ejemplo', mode: 'chat' });
  await f.backend.sendMessage({ text: 'Mostrá un ejemplo', mode: 'agent' });
  assert.equal(f.events.filter(event => event.type === 'tool').length, 0);
  await assert.rejects(fs.stat(path.join(f.project, 'bad.txt')), { code: 'ENOENT' });
  assert.ok(f.events.some(event => event.type === 'delta')); assert.ok(f.requests[0][0].content.includes('español'));
});

test('agent reads, searches, and sees tool results before continuing', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'list_files', path: '.' }), toolJSON({ tool: 'read_file', path: 'a.txt' }), toolJSON({ tool: 'search', query: 'mundo', path: '.' }), 'Encontré la línea.']);
  await f.backend.saveSettings({ settings: { accessLevel: 2 } });
  await fs.writeFile(path.join(f.project, 'a.txt'), 'Hola mundo\nsegunda línea'); await f.backend.setProject(f.project);
  const result = await f.backend.sendMessage({ text: 'Buscá mundo', mode: 'agent' });
  assert.equal(result.chat.messages.filter(message => message.role === 'tool').length, 3);
  assert.ok(f.requests[1].some(message => message.content.includes('a.txt (')));
  assert.ok(f.requests[2].some(message => message.content.includes('Hola mundo')));
  assert.ok(f.requests[3].some(message => message.content.includes('a.txt:1: Hola mundo')));
  assert.equal(result.chat.messages.at(-1).content, 'Encontré la línea.');
});

test('filesystem rejects traversal, private files, absolute paths, and directory junctions', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  await fs.writeFile(path.join(f.project, '.env'), 'TOKEN=private');
  await fs.writeFile(path.join(f.project, 'public.txt'), 'visible');
  await fs.mkdir(path.join(f.project, 'node_modules')); await fs.writeFile(path.join(f.project, 'node_modules', 'hidden.txt'), 'dependency');
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(f.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const filename of ['../outside/secret.txt', '.env', 'node_modules/hidden.txt', 'linked/secret.txt', path.join(outside, 'secret.txt'), 'a.txt:stream', 'CON', 'x/../public.txt']) {
    await assert.rejects(f.backend.readProjectFile({ path: filename }), undefined, filename);
  }
  assert.deepEqual((await f.backend.listProjectFiles()).map(file => file.path), ['public.txt']);
});

test('writes wait for approval and keep a recoverable original', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'a.txt', content: 'nuevo' }), 'Guardado.']);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'anterior'); await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Cambiá a.txt', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  assert.equal(proposal.tool.before, 'anterior'); assert.equal(proposal.tool.status, undefined);
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'anterior');
  await f.backend.approveTool({ id: proposal.tool.id, approved: true });
  const result = await pending;
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'nuevo');
  const backups = await fs.readdir(path.join(f.dataDir, 'backups'));
  assert.equal(await fs.readFile(path.join(f.dataDir, 'backups', backups[0], 'original.txt'), 'utf8'), 'anterior');
  assert.equal(result.chat.messages.find(message => message.role === 'tool').status, 'Listo');
});

test('denied writes do not touch files and cannot be approved a second time', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'nested/new.txt', content: 'nuevo' }), 'No lo guardé.']);
  await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Creá un archivo', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  await f.backend.approveTool({ id: proposal.tool.id, approved: false }); await pending;
  await assert.rejects(fs.stat(path.join(f.project, 'nested')), { code: 'ENOENT' });
  await assert.rejects(f.backend.approveTool({ id: proposal.tool.id, approved: true }), /ya no/);
  assert.ok(f.requests[1].some(message => message.content.includes('no aprobó')));
});

test('file changes between proposal and approval are preserved', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'a.txt', content: 'IA' }), 'Volvé a revisar.']);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'inicial'); await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Cambiá a.txt', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  await fs.writeFile(path.join(f.project, 'a.txt'), 'cambio del usuario');
  await f.backend.approveTool({ id: proposal.tool.id, approved: true }); const result = await pending;
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'cambio del usuario');
  assert.match(result.chat.messages.find(message => message.role === 'tool').result, /cambió después/);
});

test('a changed parent junction cannot redirect an approved write', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'nested/a.txt', content: 'IA' }), 'No pude guardar.']);
  await fs.mkdir(path.join(f.project, 'nested')); await fs.writeFile(path.join(f.project, 'nested/a.txt'), 'inicial'); await f.backend.setProject(f.project);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'a.txt'), 'afuera');
  const pending = f.backend.sendMessage({ text: 'Cambiá a.txt', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  await fs.rename(path.join(f.project, 'nested'), path.join(f.project, 'original-nested'));
  await fs.symlink(outside, path.join(f.project, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.backend.approveTool({ id: proposal.tool.id, approved: true }); await pending;
  assert.equal(await fs.readFile(path.join(outside, 'a.txt'), 'utf8'), 'afuera');
});

test('stop while awaiting approval cancels the proposal and persists its state', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'new.txt', content: 'no' })]);
  await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Creá un archivo', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  await f.backend.stop(); const result = await pending;
  assert.match(result.chat.messages.find(message => message.role === 'tool').status, /Cancelado/);
  await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
  await assert.rejects(f.backend.approveTool({ id: proposal.tool.id, approved: true }), /ya no/);
  const restored = new Backend({ dataDir: f.dataDir, engine: f.engine }); await restored.init();
  assert.match((await restored.getChat({ id: result.chat.id })).messages.find(message => message.role === 'tool').status, /Cancelado/);
});

test('stop returns even if the model ignores AbortSignal', async t => {
  const f = await fixture(t, [() => new Promise(() => {})]);
  const pending = f.backend.sendMessage({ text: 'Esperá', mode: 'chat' }); await waitFor(() => f.requests.length);
  await f.backend.stop(); const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(Error('No canceló')), 1000))]);
  assert.equal(result.chat.messages.at(-1).content, 'Respuesta detenida.');
});

test('real commands require approval and stop kills their process tree', async t => {
  const command = `"${process.execPath}" -e "setTimeout(()=>require('fs').writeFileSync('should-not-exist.txt','bad'),1400);setInterval(()=>{},1000)"`;
  const f = await fixture(t, [toolJSON({ tool: 'run_command', command })]); await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Ejecutá', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  assert.equal(f.backend.job.process, null);
  await f.backend.approveTool({ id: proposal.tool.id, approved: true }); await waitFor(() => f.backend.terminals?.list().some(item => item.status === 'running'));
  await f.backend.stop(); await pending; await new Promise(resolve => setTimeout(resolve, 1600));
  await assert.rejects(fs.stat(path.join(f.project, 'should-not-exist.txt')), { code: 'ENOENT' });
});

test('project contexts cannot mix and file reads are bounded', async t => {
  const f = await fixture(t, ['Hola.']); await f.backend.setProject(f.project);
  await fs.writeFile(path.join(f.project, 'big.txt'), 'x'.repeat(200000));
  const read = await f.backend.readProjectFile({ path: 'big.txt' }); assert.ok(read.content.length < 132000); assert.match(read.content, /Vista parcial/);
  const first = await f.backend.sendMessage({ text: 'Proyecto uno', mode: 'chat' });
  const other = path.join(f.root, 'other'); await fs.mkdir(other); await f.backend.setProject(other);
  await assert.rejects(f.backend.sendMessage({ chatId: first.chat.id, text: 'Proyecto dos', mode: 'agent' }), /otra carpeta/);
});

test('init is idempotent during a pending task and reports the live busy state', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'write_file', path: 'new.txt', content: 'pending' })]); await f.backend.setProject(f.project);
  const pending = f.backend.sendMessage({ text: 'Creá', mode: 'agent' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  assert.equal(f.backend.busy, true);
  const live = await f.backend.init(); assert.equal(live.chats.length, 1);
  assert.equal(f.backend.chats[0].messages.find(message => message.role === 'tool').status, undefined);
  assert.ok(f.backend.pending.has(proposal.tool.id));
  await f.backend.dispose(); await pending; assert.equal(f.backend.busy, false);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'chats.json'), 'utf8'));
  assert.match(persisted[0].messages.find(message => message.role === 'tool').status, /Cancelado/);
});

test('partial streamed text is preserved when stopped', async t => {
  const f = await fixture(t, [({ onDelta }) => { onDelta('Parte de la respuesta'); return new Promise(() => {}); }]);
  const pending = f.backend.sendMessage({ text: 'Explicá', mode: 'chat' });
  await waitFor(() => f.events.some(event => event.type === 'delta'));
  await f.backend.stop(); const result = await pending;
  assert.equal(result.chat.messages.at(-1).content, 'Parte de la respuesta\n\nRespuesta detenida.');
});

test('bounded model context retains the user request and omits duplicated write contents', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  await f.backend.saveSettings({ settings: { context: 2048, instructions: 'preferencia '.repeat(1000) } });
  const messages = [
    { role: 'user', content: 'NECESITO revisar el archivo a.txt' },
    { role: 'tool', data: { tool: 'write_file', path: 'a.txt', content: 'NO-DUPLICAR'.repeat(1000) }, result: 'Cambio guardado.' },
    { role: 'tool', data: { tool: 'read_file', path: 'a.txt' }, result: 'texto '.repeat(30000) }
  ];
  const context = f.backend._context({ messages }, 'agent'); const text = context.map(message => message.content).join('\n');
  assert.ok(text.length < 4400); assert.ok(text.includes('NECESITO')); assert.ok(!text.includes('NO-DUPLICAR'));
  assert.ok(context[0].content.includes('write_file'));
});

test('normal and compact prompts explain exact root paths and completed versus persistent commands', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  const normal = f.backend._system('agent').content;
  const compact = f.backend._context({ messages: [{ role: 'user', content: 'Usá nuevo.txt sin cambiar la ruta.' }] }, 'agent', { ...f.backend.settings, context: 2048, instructions: 'preferencia '.repeat(1000) })[0].content;
  assert.ok(normal.includes('Cada respuesta completa')); assert.ok(compact.includes('Un JSON sin Markdown'));
  for (const prompt of [normal, compact]) {
    assert.match(prompt, /[Rr]aíz/); assert.ok(prompt.includes('nuevo.txt'));
    assert.ok(prompt.includes(`${f.backend.project.name}/nuevo.txt`));
    assert.match(prompt, /no existe/); assert.match(prompt, /list_files/); assert.match(prompt, /recort/);
    assert.match(prompt, /run_command/); assert.match(prompt, /salida FINAL/);
    assert.match(prompt, /NO (?:uses )?read_terminal/); assert.match(prompt, /stop_terminal/);
    assert.match(prompt, /Solo start_command/); assert.match(prompt, /ESE id exacto/);
    assert.match(prompt, /[Nn]unca invent/); assert.ok(prompt.includes('"1"'));
    assert.match(prompt, /cmd\.exe/); assert.match(prompt, /nivel 1\/7/);
  }
});

test('agent requests the strict action schema and renders structured reply as plain text', async t => {
  const f = await fixture(t, [toolJSON({ tool: 'reply', content: 'La respuesta para vos.' }), 'Charla común.']); await f.backend.setProject(f.project);
  const result = await f.backend.sendMessage({ text: 'Explicá', mode: 'agent' });
  assert.deepEqual(f.options[0].responseFormat, AGENT_RESPONSE_FORMAT);
  assert.equal(AGENT_RESPONSE_FORMAT.type, 'json_schema'); assert.equal(AGENT_RESPONSE_FORMAT.json_schema.strict, true);
  const schemas = AGENT_RESPONSE_FORMAT.json_schema.schema.oneOf;
  assert.deepEqual(schemas.map(schema => schema.properties.tool.const), ['reply', 'list_files', 'read_file', 'search', 'write_file', 'make_directory', 'delete_file', 'open_file', 'pack_project', 'remember', 'forget', 'web_search', 'read_url', 'run_command', 'start_command', 'read_terminal', 'send_terminal', 'stop_terminal']);
  for (const schema of schemas) { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties)); }
  assert.equal(result.chat.messages.at(-1).content, 'La respuesta para vos.');
  assert.equal(f.events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'La respuesta para vos.');
  assert.equal(f.events.filter(event => event.type === 'tool').length, 0);
  await f.backend.sendMessage({ text: 'Charlemos', mode: 'chat' }); assert.equal(f.options[1].responseFormat, undefined);
});

test('structured reply containing a tool example remains text and is never executed', async t => {
  const example = toolJSON({ tool: 'write_file', path: 'example.txt', content: 'example' });
  const f = await fixture(t, [toolJSON({ tool: 'reply', content: example })]); await f.backend.setProject(f.project);
  const result = await f.backend.sendMessage({ text: 'Mostrá un ejemplo', mode: 'agent' });
  assert.equal(result.chat.messages.at(-1).content, example);
  assert.equal(f.events.filter(event => event.type === 'tool').length, 0);
  await assert.rejects(fs.stat(path.join(f.project, 'example.txt')), { code: 'ENOENT' });
});

test('a fenced JSON action is not executable even in agent mode', async t => {
  const fenced = '```json\n' + toolJSON({ tool: 'write_file', path: 'example.txt', content: 'example' }) + '\n```';
  const f = await fixture(t, [fenced]); await f.backend.setProject(f.project);
  const result = await f.backend.sendMessage({ text: 'Mostrá un ejemplo', mode: 'agent' });
  assert.equal(result.chat.messages.at(-1).content, fenced);
  assert.equal(f.events.filter(event => event.type === 'tool').length, 0);
  await assert.rejects(fs.stat(path.join(f.project, 'example.txt')), { code: 'ENOENT' });
});

test('restoreChange restores an existing file and preserves the state before undo', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'original');
  const changed = await approvedWrite(f, 'a.txt', 'nuevo');
  assert.ok(changed.tool.backupId); assert.match(changed.tool.appliedHash, /^[a-f0-9]{64}$/);
  assert.ok(!changed.tool.result.includes(f.dataDir));
  const restored = await f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id });
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'original');
  const record = restored.chat.messages.find(message => message.role === 'tool');
  assert.equal(record.status, 'Cambio deshecho');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'backups', record.restoreBackupId, 'original.txt'), 'utf8'), 'nuevo');
  const reopened = new Backend({ dataDir: f.dataDir, engine: f.engine }); await reopened.init();
  assert.equal((await reopened.getChat({ id: changed.chat.id })).messages.find(message => message.role === 'tool').status, 'Cambio deshecho');
  await assert.rejects(f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id }), /ya se deshizo/);
});

test('restoreChange removes a new file and keeps its content in a recoverable backup', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  const changed = await approvedWrite(f, 'new.txt', 'contenido nuevo');
  const restored = await f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id });
  await assert.rejects(fs.stat(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
  const record = restored.chat.messages.find(message => message.role === 'tool');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'backups', record.restoreBackupId, 'original.txt'), 'utf8'), 'contenido nuevo');
});

test('restoreChange preserves edits made after the approved change', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  await fs.writeFile(path.join(f.project, 'a.txt'), 'original');
  const changed = await approvedWrite(f, 'a.txt', 'IA');
  await fs.writeFile(path.join(f.project, 'a.txt'), 'cambio reciente');
  await assert.rejects(f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id }), /más recientes/);
  assert.equal(await fs.readFile(path.join(f.project, 'a.txt'), 'utf8'), 'cambio reciente');
  assert.equal(f.backend.busy, false);
});

test('restoreChange blocks a replaced parent junction and a forged backup id', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  await fs.mkdir(path.join(f.project, 'nested')); await fs.writeFile(path.join(f.project, 'nested/a.txt'), 'original');
  const changed = await approvedWrite(f, 'nested/a.txt', 'IA');
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'a.txt'), 'IA');
  await fs.rename(path.join(f.project, 'nested'), path.join(f.project, 'original-nested'));
  await fs.symlink(outside, path.join(f.project, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id }), /enlaces/);
  assert.equal(await fs.readFile(path.join(outside, 'a.txt'), 'utf8'), 'IA');
  f.backend.chats.find(chat => chat.id === changed.chat.id).messages.find(message => message.id === changed.tool.id).backupId = '../outside';
  await assert.rejects(f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id }), /copia válida/);
});

test('restoreChange requires the original project', async t => {
  const f = await fixture(t); await f.backend.setProject(f.project);
  const changed = await approvedWrite(f, 'new.txt', 'IA'); await f.backend.clearProject();
  await assert.rejects(f.backend.restoreChange({ chatId: changed.chat.id, toolId: changed.tool.id }), /carpeta de esta conversación/);
  assert.equal(await fs.readFile(path.join(f.project, 'new.txt'), 'utf8'), 'IA');
});

test('clearProject persists and getChat activates a project only when requested', async t => {
  const f = await fixture(t, ['Sin carpeta.', 'Con carpeta.']);
  const without = await f.backend.sendMessage({ text: 'Charlemos', mode: 'chat' });
  await f.backend.setProject(f.project);
  const withProject = await f.backend.sendMessage({ text: 'Este proyecto', mode: 'chat' });
  await f.backend.getChat({ id: without.chat.id }); assert.equal(f.backend.project.path, await fs.realpath(f.project));
  await f.backend.getChat({ id: without.chat.id, activateProject: true }); assert.equal(f.backend.project, null);
  await f.backend.getChat({ id: withProject.chat.id, activateProject: true }); assert.equal(f.backend.project.path, await fs.realpath(f.project));
  assert.equal(await f.backend.clearProject(), null);
  const reopened = new Backend({ dataDir: f.dataDir, engine: f.engine }); assert.equal((await reopened.init()).project, null);
});
