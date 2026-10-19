'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Backend, validateSettings } = require('../backend.cjs');
const { permissionFor } = require('../access-policy.cjs');
const { crc32 } = require('../project-zip.cjs');
const json = value => JSON.stringify(value);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-auto-')), events = [], responses = [], requests = [], opened = [];
  const engine = { activeId: 'test', models: [], status: () => ({}), async generate(messages, options) { requests.push({ messages, options }); const answer = responses.shift() || json({ tool: 'reply', content: 'Listo.' }); options.onDelta(answer); return answer; } };
  const backend = new Backend({ dataDir: path.join(root, 'data'), engine, emit: event => events.push(event), desktop: { openPath: async absolute => { opened.push(absolute); } } });
  await backend.init();
  t.after(async () => { await backend.dispose(); const resolved = await fs.realpath(root); assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir()))); await fs.rm(resolved, { force: true, recursive: true }); });
  return { root, backend, events, responses, requests, engine, opened };
}
async function waitFor(predicate) { const until = Date.now() + 4000; while (Date.now() < until) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Falta la propuesta.'); }
function zipEntries(bytes) {
  const result = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const crc = bytes.readUInt32LE(offset + 14), size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), dataAt = offset + 30 + nameLength + extraLength, data = bytes.subarray(dataAt, dataAt + size);
    assert.equal(crc32(data), crc); result.set(name, data); offset = dataAt + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50); assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50); return result;
}

test('automatic conversations work without a folder and do not create one', async t => {
  const f = await fixture(t); f.responses.push(json({ tool: 'reply', content: 'Hola, ¿cómo estás?' }));
  const result = await f.backend.sendMessage({ text: 'Hola' });
  assert.equal(result.chat.messages.at(-1).content, 'Hola, ¿cómo estás?'); assert.equal(f.backend.project, null); assert.equal(result.chat.projectPath, null);
  await assert.rejects(fs.stat(path.join(f.backend.dataDir, 'Projects')), { code: 'ENOENT' });
  assert.equal(f.requests[0].options.responseFormat.json_schema.strict, true); assert.equal(f.events.filter(e => e.type === 'tool').length, 0);
});

test('automatic coding creates actual files in a managed project and persists that context', async t => {
  const f = await fixture(t); await f.backend.saveSettings({ settings: { accessLevel: 3 } });
  f.responses.push(json({ tool: 'write_file', path: 'hola.py', content: 'print("hola")\n' }), json({ tool: 'reply', content: 'Guardado.' }));
  const result = await f.backend.sendMessage({ text: 'Creá hola.py' }), project = f.backend.project;
  assert.ok(project.managed); assert.ok(project.path.startsWith(path.join(f.backend.dataDir, 'Projects'))); assert.equal(result.chat.projectPath, project.path);
  assert.equal(await fs.readFile(path.join(project.path, 'hola.py'), 'utf8'), 'print("hola")\n');
  assert.ok(f.events.some(event => event.type === 'projectChanged' && event.project.path === project.path));
  assert.equal(result.chat.messages.find(m => m.role === 'tool').approvalRequired, false);
  const other = new Backend({ dataDir: f.backend.dataDir, engine: f.engine }); await other.init();
  assert.equal(other.project.path, project.path); await other.dispose();
});

test('automatic coding corrects code-only replies through model tools without executing Markdown', async t => {
  const f = await fixture(t); await f.backend.saveSettings({ settings: { accessLevel: 3 } });
  f.responses.push(json({ tool: 'reply', content: '```python\nprint("hola")\n```' }), json({ tool: 'write_file', path: 'hola.py', content: 'print("hola")\n' }), json({ tool: 'reply', content: 'Guardado.' }));
  const result = await f.backend.sendMessage({ text: 'Creá un script de Python que salude' });
  assert.equal(await fs.readFile(path.join(f.backend.project.path, 'hola.py'), 'utf8'), 'print("hola")\n');
  assert.equal(result.chat.messages.filter(m => m.role === 'assistant').length, 1); assert.ok(f.requests[1].messages.at(-1).content.includes('write_file'));
  assert.equal(f.events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Guardado.');
});

test('a new task after stop has a clear current request and canceled tools remain only historical context', async t => {
  const f = await fixture(t);
  f.responses.push(json({ tool: 'read_file', path: 'old-task.py' }));
  const first = f.backend.sendMessage({ text: 'Revisá old-task.py' });
  await waitFor(() => f.events.find(event => event.type === 'tool')); await f.backend.stop();
  const stopped = await first; assert.equal(stopped.stopped, true); assert.equal(stopped.failed, false);
  f.responses.push(json({ tool: 'reply', content: 'CONTINUADO' }));
  const second = await f.backend.sendMessage({ chatId: stopped.chat.id, text: 'Respondé solamente CONTINUADO, sin herramientas. La tarea anterior terminó.' });
  const context = f.requests.at(-1).messages, current = context.findLast(message => message.role === 'user');
  assert.match(current.content, /^TAREA ACTUAL DEL USUARIO/); assert.match(current.content, /Respondé solamente CONTINUADO/);
  const canceled = context.find(message => message.content.includes('old-task.py') && message.content.includes('Estado:'));
  assert.match(canceled.content, /HISTORIAL DE TAREA ANTERIOR/); assert.match(canceled.content, /Cancelado/);
  assert.match(context[0].content, /No retomar tareas|No repitas acciones anteriores canceladas/);
  assert.equal(second.chat.messages.at(-1).content, 'CONTINUADO'); assert.equal(second.stopped, false); assert.equal(second.failed, false);
  assert.equal(f.events.filter(event => event.type === 'tool').length, 1);
});

test('memories persist, can be edited/deleted, and never require a project', async t => {
  const f = await fixture(t); assert.deepEqual((await f.backend.init()).memories, []);
  const memories = await f.backend.saveMemory({ content: 'Prefiero ejemplos en Python.' }), id = memories[0].id;
  await f.backend.saveMemory({ id, content: 'Prefiero ejemplos cortos en Python.' });
  const other = new Backend({ dataDir: f.backend.dataDir, engine: f.engine }); const restored = await other.init();
  assert.equal(restored.memories[0].content, 'Prefiero ejemplos cortos en Python.'); assert.equal(other.project, null);
  assert.match(other._context({ messages: [{ role: 'user', content: 'Explicá variables' }] }, 'auto')[0].content, /Prefiero ejemplos cortos/);
  await other.deleteMemory({ id }); assert.deepEqual(other.listMemories(), []); await other.dispose();
  await assert.rejects(f.backend.saveMemory({ content: 'api_key=topsecret' }), /contraseñas/);
  await assert.rejects(f.backend.saveMemory({ content: 'x'.repeat(2001) }), /2.000/);
});

test('AI memories use the same levels: ask at restricted, create from 3, delete from 7', async t => {
  const f = await fixture(t); await f.backend.saveSettings({ settings: { accessLevel: 1 } });
  f.responses.push(json({ tool: 'remember', content: 'Prefiero Python.' }), json({ tool: 'reply', content: 'Recordado.' }));
  const task = f.backend.sendMessage({ text: 'Recordá que prefiero Python' });
  const proposal = await waitFor(() => f.events.find(event => event.type === 'tool'));
  assert.equal(proposal.tool.approvalRequired, true); assert.deepEqual(f.backend.memories, []);
  await f.backend.approveTool({ id: proposal.tool.id, approved: true }); await task;
  assert.equal(f.backend.memories[0].content, 'Prefiero Python.'); assert.equal(f.backend.project, null);
  const id = f.backend.memories[0].id, offset = f.events.length;
  f.responses.push(json({ tool: 'forget', id }), json({ tool: 'reply', content: 'No lo olvidé.' }));
  const denied = f.backend.sendMessage({ text: 'Olvidá esa preferencia' }); const forget = await waitFor(() => f.events.slice(offset).find(e => e.type === 'tool'));
  await f.backend.approveTool({ id: forget.tool.id, approved: false }); await denied; assert.equal(f.backend.memories.length, 1);
  await f.backend.saveSettings({ settings: { accessLevel: 7 } });
  f.responses.push(json({ tool: 'forget', id }), json({ tool: 'reply', content: 'Olvidado.' }));
  const deleted = await f.backend.sendMessage({ text: 'Olvidá esa preferencia' });
  assert.equal(deleted.chat.messages.find(message => message.role === 'tool').approvalRequired, false); assert.equal(f.backend.memories.length, 0);
  await f.backend.saveSettings({ settings: { accessLevel: 3 } });
  f.responses.push(json({ tool: 'remember', content: 'Prefiero JavaScript.' }), json({ tool: 'reply', content: 'Recordado.' }));
  const created = await f.backend.sendMessage({ text: 'Recordá que prefiero JavaScript' }), tool = created.chat.messages.find(message => message.role === 'tool');
  assert.equal(tool.approvalRequired, false); assert.equal(tool.requiredLevel, 3); assert.equal(f.backend.memories[0].content, 'Prefiero JavaScript.');
});

test('ZIP exports project bytes, empty directories and Unicode, omitting private/dependency files', async t => {
  const f = await fixture(t), project = path.join(f.root, 'project'); await fs.mkdir(project); await f.backend.setProject(project);
  await fs.writeFile(path.join(project, 'ñ.txt'), 'Hola ñ'); await fs.writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 255])); await fs.mkdir(path.join(project, 'vacío'));
  await fs.writeFile(path.join(project, '.env'), 'PRIVATE'); await fs.mkdir(path.join(project, 'node_modules')); await fs.writeFile(path.join(project, 'node_modules', 'skip.js'), 'DEPENDENCY');
  const exported = await f.backend.packProject({ path: 'proyecto.zip' }), bytes = await fs.readFile(exported.absolutePath), entries = zipEntries(bytes);
  assert.equal(exported.files, 2); assert.equal(entries.get('ñ.txt').toString(), 'Hola ñ'); assert.deepEqual(entries.get('binary.bin'), Buffer.from([0, 1, 255])); assert.ok(entries.has('vacío/'));
  assert.ok(!entries.has('.env')); assert.ok(!entries.has('proyecto.zip')); assert.ok(![...entries.keys()].some(name => name.includes('node_modules')));
  const again = await f.backend.packProject({ path: 'proyecto.zip' }); assert.deepEqual(await fs.readFile(again.absolutePath), bytes);
  await assert.rejects(f.backend.packProject({ path: '../outside.zip' }), /ruta/);
});

test('ZIP uses create/edit levels; opening an OS file waits below console level', async t => {
  const f = await fixture(t), project = path.join(f.root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'hello.txt'), 'hi'); await f.backend.setProject(project);
  assert.equal(permissionFor('pack_project', { level: 3, exists: false }).approvalRequired, false); assert.equal(permissionFor('pack_project', { level: 3, exists: true }).approvalRequired, true);
  await f.backend.saveSettings({ settings: { accessLevel: 3 } });
  f.responses.push(json({ tool: 'pack_project', path: 'export.zip' }), json({ tool: 'open_file', path: 'hello.txt' }), json({ tool: 'reply', content: 'Abierto.' }));
  const task = f.backend.sendMessage({ text: 'Empaquetá y abrí hello.txt' });
  const opening = await waitFor(() => f.events.find(e => e.type === 'tool' && e.tool.data.tool === 'open_file'));
  assert.equal(opening.tool.requiredLevel, 6); assert.equal(f.opened.length, 0); assert.ok((await fs.stat(path.join(project, 'export.zip'))).size > 0);
  await f.backend.approveTool({ id: opening.tool.id, approved: true }); await task; assert.deepEqual(f.opened, [path.join(project, 'hello.txt')]);
});

test('English setting affects normal and compact model prompts and is validated', async t => {
  const f = await fixture(t); assert.equal(validateSettings({ language: null }).language, null); assert.throws(() => validateSettings({ language: 'fr' }));
  await f.backend.saveSettings({ settings: { language: 'en', instructions: 'preference '.repeat(1000), context: 2048 } });
  assert.match(f.backend._system('auto').content, /English/); assert.match(f.backend._context({ messages: [{ role: 'user', content: 'Hello' }] }, 'auto')[0].content, /English/);
  const minimum = f.backend._context({ messages: [{ role: 'user', content: 'Please create hello.py with a greeting.' }] }, 'auto', { ...f.backend.settings, context: 512 });
  assert.ok(minimum.some(message => message.content.includes('Please create hello.py'))); assert.ok(minimum.reduce((sum, message) => sum + message.content.length + 16, 0) < 1100);
});
