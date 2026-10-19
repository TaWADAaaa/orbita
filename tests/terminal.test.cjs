'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TerminalManager } = require('../terminal.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = source => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`;
async function waitFor(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(20); }
  throw new Error('La consola no respondió a tiempo.');
}
async function fixture(t, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orbita-terminal-'));
  const events = [];
  const manager = new TerminalManager({ ...options, emit: event => events.push(event) });
  t.after(async () => { await manager.dispose(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { manager, cwd, events };
}

test('starts immediately, streams stdout and stderr, and uses the selected folder', async t => {
  const { manager, cwd, events } = await fixture(t);
  const before = Date.now();
  const session = await manager.start({ command: command("console.log('inicio'); console.error('aviso'); console.log(process.cwd()); setTimeout(()=>console.log('fin'),700)"), cwd, origin: 'user', title: 'Mi consola' });
  assert.ok(Date.now() - before < 600, 'start must not wait for command completion');
  assert.equal(session.status, 'running');
  assert.equal(session.title, 'Mi consola');
  await waitFor(() => manager.get({ id: session.id }).output.includes('inicio'));
  assert.equal(manager.get(session.id).status, 'running');
  assert.ok(events.some(event => event.action === 'data' && event.text.includes('inicio')));
  await waitFor(() => manager.get(session.id).status === 'exited');
  const completed = manager.get(session.id);
  assert.match(completed.output, /aviso/);
  assert.match(completed.output, /fin/);
  assert.ok(completed.output.includes(await fs.realpath(cwd)));
  assert.equal(completed.exitCode, 0);
  assert.equal(events.filter(event => event.action === 'start').length, 1);
  assert.equal(events.filter(event => event.action === 'exit').length, 1);
  assert.equal(events.filter(event => event.action === 'data').map(event => event.text).join(''), completed.output);
});

test('stdin reaches a running command and an unknown session cannot be controlled', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.start({ command: command("console.log('listo'); process.stdin.setEncoding('utf8'); process.stdin.once('data',text=>{console.log('recibido:'+text.trim()); process.exit(0)})"), cwd, origin: 'ai' });
  await waitFor(() => manager.get(session.id).output.includes('listo'));
  await manager.input({ id: session.id, text: 'hola consola\n' });
  await waitFor(() => manager.get(session.id).status === 'exited');
  assert.match(manager.get(session.id).output, /recibido:hola consola/);
  await assert.rejects(manager.input({ id: session.id, text: 'más\n' }), /terminó/);
  await assert.rejects(manager.stop({ id: '123' }), /no está disponible/);
  await assert.rejects(manager.input({ id: '123', text: 'hola' }), /no está disponible/);
});

test('execute returns nonzero exit and visible stderr in the same session history', async t => {
  const { manager, cwd } = await fixture(t);
  const result = await manager.execute(command("console.log('salida'); console.error('falló'); process.exit(7)"), { cwd, origin: 'ai' });
  assert.match(result, /^Código de salida: 7/);
  assert.match(result, /salida/);
  assert.match(result, /falló/);
  const [session] = manager.list();
  assert.equal(session.origin, 'ai');
  assert.equal(session.status, 'exited');
  assert.equal(session.exitCode, 7);
  if (process.platform === 'win32') assert.match(await manager.execute('exit /b 9', { cwd }), /^Código de salida: 9/);
});

test('UTF-8 and ANSI sequences split across chunks are decoded without visual controls', async t => {
  const { manager, cwd } = await fixture(t);
  const source = "const b=Buffer.from('á🙂'); process.stdout.write(Buffer.from([27,91])); setTimeout(()=>{process.stdout.write('31m');process.stdout.write(b.subarray(0,3)); setTimeout(()=>{process.stdout.write(b.subarray(3));process.stdout.write('\\x1b[0m\\nsegunda\\n');},30)},30)";
  const result = await manager.execute(command(source), { cwd });
  assert.match(result, /á🙂\nsegunda\n/);
  assert.doesNotMatch(result, /\x1b|31m|�/);
});

test('stop and abort kill managed child processes, including their descendants', async t => {
  const { manager, cwd } = await fixture(t);
  const marker = path.join(cwd, 'orphan.txt');
  const nested = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1200);setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:'ignore'});console.log('árbol listo');setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const pending = manager.execute(command(parent), { cwd, signal: controller.signal });
  // Observe the rejection immediately so no unhandled rejection can race the test.
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitFor(() => manager.list()[0]?.output.includes('árbol listo'));
  controller.abort();
  await rejected;
  assert.equal(manager.list()[0].status, 'stopped');
  await delay(1400);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  const second = await manager.start({ command: command('setInterval(()=>{},1000)'), cwd, origin: 'user' });
  assert.equal((await manager.stop({ id: second.id })).status, 'stopped');
});

test('background sessions accept explicit cancellation and survive unrelated completed commands', async t => {
  const { manager, cwd } = await fixture(t);
  const controller = new AbortController();
  const background = await manager.start(command("console.log('servicio');setInterval(()=>{},1000)"), { cwd, origin: 'ai', signal: controller.signal });
  await manager.execute(command("console.log('otra tarea')"), { cwd });
  assert.equal(manager.read(background.id).status, 'running');
  controller.abort();
  await waitFor(() => manager.get(background.id).status === 'stopped');
});

test('execute stops the managed process at its 60-second deadline', async t => {
  const { manager, cwd } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = manager.execute(command('setInterval(()=>{},1000)'), { cwd });
    const rejected = assert.rejects(pending, /superó 60 segundos/);
    // Let real filesystem/spawn work settle while keeping the deadline clock
    // controlled. This tests the timeout with a real child, without a 1m wait.
    while (!manager.list().length) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(60000);
    await rejected;
    assert.equal(manager.list()[0].status, 'stopped');
  } finally { t.mock.timers.reset(); }
});

test('limits simultaneous sessions and keeps only the latest 24 snapshots', async t => {
  const { manager, cwd } = await fixture(t);
  const sessions = await Promise.all(Array.from({ length: 8 }, () => manager.start({ command: command('setInterval(()=>{},1000)'), cwd, origin: 'user' })));
  await assert.rejects(manager.start({ command: 'echo novena', cwd }), /8 consolas/);
  await Promise.all(sessions.map(session => manager.stop(session.id)));
  for (let index = 0; index < 25; index++) await manager.execute(command(`console.log(${index})`), { cwd });
  assert.equal(manager.list().length, 24);
  assert.equal(manager.list().filter(session => session.status === 'running').length, 0);
  assert.match(manager.list().at(-1).output, /24/);
  assert.throws(() => manager.get(sessions[0].id), /no está disponible/);
});

test('caps saved output at a valid UTF-8 boundary and keeps the end', async t => {
  const { manager, cwd } = await fixture(t, { maxOutput: 1024 });
  await manager.execute(command("process.stdout.write('🙂'.repeat(10000)+'\\nFINAL\\n')"), { cwd });
  const session = manager.list()[0];
  assert.ok(Buffer.byteLength(session.output, 'utf8') <= 1024);
  assert.ok(session.truncated);
  assert.match(session.output, /FINAL\n$/);
  assert.doesNotMatch(session.output, /�/);
});

test('validates commands and directories; dispose waits for every managed process', async t => {
  const { manager, cwd } = await fixture(t);
  await assert.rejects(manager.start({ command: '', cwd }), /comando/);
  await assert.rejects(manager.start({ command: 'x'.repeat(8193), cwd }), /comando/);
  await assert.rejects(manager.start({ command: 'echo\0hi', cwd }), /comando/);
  await assert.rejects(manager.start({ command: 'echo hi', cwd: path.join(cwd, 'missing') }), /no existe/);
  await fs.writeFile(path.join(cwd, 'file'), 'x');
  await assert.rejects(manager.start({ command: 'echo hi', cwd: path.join(cwd, 'file') }), /carpeta/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.execute('echo hi', { cwd, signal: controller.signal }), { name: 'AbortError' });
  await Promise.all(Array.from({ length: 3 }, () => manager.start({ command: command('setInterval(()=>{},1000)'), cwd })));
  await manager.dispose();
  assert.ok(manager.list().every(session => session.status === 'stopped'));
  await assert.rejects(manager.start({ command: 'echo hi', cwd }), /cerradas/);
});
