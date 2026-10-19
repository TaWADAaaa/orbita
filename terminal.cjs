'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const MAX_RUNNING = 8;
const MAX_SESSIONS = 24;
const MAX_OUTPUT = 256 * 1024;
const COMMAND_TIMEOUT = 60000;
const abortError = () => Object.assign(new Error('Comando detenido.'), { name: 'AbortError' });

// Each stream has its own decoder, so a UTF-8 character or terminal escape may
// safely arrive in several chunks. The GUI is plain text, not an ANSI terminal.
class PlainOutput {
  constructor() { this.decoder = new StringDecoder('utf8'); this.state = 'text'; }
  write(chunk, end = false) {
    const decoded = end ? this.decoder.end() : this.decoder.write(chunk);
    let text = '';
    for (const char of decoded) {
      const code = char.codePointAt(0);
      if (this.state === 'text') {
        if (char === '\x1b') this.state = 'escape';
        else if (char === '\u009b') this.state = 'csi';
        else if (char === '\u009d') this.state = 'osc';
        else if (['\u0090', '\u0098', '\u009e', '\u009f'].includes(char)) this.state = 'string';
        else if (char === '\n' || char === '\r' || char === '\t' || (code >= 32 && code !== 127 && (code < 128 || code > 159))) text += char;
      } else if (this.state === 'escape') {
        if (char === '[') this.state = 'csi';
        else if (char === ']') this.state = 'osc';
        else if (['P', 'X', '^', '_'].includes(char)) this.state = 'string';
        else if (code >= 32 && code <= 47) this.state = 'intermediate';
        else this.state = 'text';
      } else if (this.state === 'intermediate' || this.state === 'csi') {
        if (char === '\n' || char === '\r') { text += char; this.state = 'text'; }
        else if ((this.state === 'csi' && code >= 64 && code <= 126) || (this.state === 'intermediate' && code >= 48 && code <= 126)) this.state = 'text';
      } else if (this.state === 'osc' || this.state === 'string') {
        if (char === '\x07' || char === '\u009c') this.state = 'text';
        else if (char === '\x1b') this.state = this.state === 'osc' ? 'oscEscape' : 'stringEscape';
      } else if (this.state === 'oscEscape' || this.state === 'stringEscape') {
        this.state = char === '\\' ? 'text' : this.state === 'oscEscape' ? 'osc' : 'string';
      }
    }
    return text;
  }
}

class TerminalManager {
  constructor({ emit = () => {}, maxOutput = MAX_OUTPUT, env } = {}) {
    if (typeof emit !== 'function') throw new Error('La consola necesita un receptor de eventos válido.');
    this.emit = emit;
    this.env = { ...process.env, ...(env || {}) };
    this.maxOutput = Number.isFinite(maxOutput) ? Math.max(1024, Math.min(MAX_OUTPUT, Math.floor(maxOutput))) : MAX_OUTPUT;
    this.sessions = new Map();
    this.disposed = false;
    this.disposePromise = null;
  }

  _emit(event) { try { this.emit(event); } catch {} }
  _snapshot(session) {
    const { id, title, command, cwd, origin, status, output, exitCode, createdAt, truncated } = session;
    return { id, title, command, cwd, origin, status, output, exitCode, createdAt, truncated };
  }
  _session(value) {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string' || !this.sessions.has(id)) throw new Error('Esa consola ya no está disponible.');
    return this.sessions.get(id);
  }
  _append(session, text) {
    if (!text) return;
    let output = session.output + text;
    const bytes = Buffer.from(output, 'utf8');
    if (bytes.length > this.maxOutput) {
      let offset = bytes.length - this.maxOutput;
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      output = bytes.subarray(offset).toString('utf8');
      session.truncated = true;
    }
    session.output = output;
    this._emit({ type: 'terminal', action: 'data', id: session.id, text });
  }

  // Windows commands deliberately use cmd.exe syntax, not PowerShell. Calling
  // code must check the user's access level before entering this service.
  async start(input, legacyOptions) {
    const options = typeof input === 'string' ? { ...legacyOptions, command: input } : input;
    const { command, cwd, origin = 'user', title, signal } = options || {};
    if (this.disposed) throw new Error('Las consolas ya están cerradas.');
    if (typeof command !== 'string' || !command.trim() || command.length > 8192 || command.includes('\0')) throw new Error('Escribí un comando de hasta 8.000 caracteres.');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new Error('Elegí una carpeta para abrir la consola.');
    if (!['user', 'ai'].includes(origin)) throw new Error('El origen del comando no es válido.');
    if (signal?.aborted) throw abortError();
    const directory = await fs.realpath(cwd).catch(() => { throw new Error('La carpeta de la consola ya no existe.'); });
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Elegí una carpeta para abrir la consola.');
    if (this.disposed) throw new Error('Las consolas ya están cerradas.');
    if (signal?.aborted) throw abortError();
    if ([...this.sessions.values()].filter(session => session.status === 'running').length >= MAX_RUNNING) throw new Error('Ya hay 8 consolas funcionando. Detené una para abrir otra.');
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].find(session => session.status !== 'running');
      if (!oldest) throw new Error('Cerrá una consola antes de abrir otra.');
      this.sessions.delete(oldest.id);
    }
    let resolveDone;
    const session = {
      id: crypto.randomUUID(), command, cwd: directory, origin,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 100) : command.trim().split(/\r?\n/)[0].slice(0, 70),
      createdAt: new Date().toISOString(), spawnedAt: Date.now(), status: 'running', output: '', exitCode: null, truncated: false,
      done: new Promise(resolve => { resolveDone = resolve; }), child: null, stopping: null, abort: null
    };
    const windows = process.platform === 'win32';
    const shell = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
    const child = spawn(windows ? `chcp 65001>nul & ${command}` : command, {
      shell, cwd: directory, windowsHide: true, detached: !windows,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    session.child = child;
    this.sessions.set(session.id, session);
    this._emit({ type: 'terminal', action: 'start', terminal: this._snapshot(session) });
    const stdout = new PlainOutput(), stderr = new PlainOutput();
    child.stdout.on('data', chunk => this._append(session, stdout.write(chunk)));
    child.stderr.on('data', chunk => this._append(session, stderr.write(chunk)));
    // A process may finish while an input write is pending. Avoid an unhandled
    // pipe error; input() reports the failure to the person who sent the text.
    child.stdin.on('error', () => {});
    child.once('error', error => this._append(session, `No pudimos abrir el comando: ${error.message}\n`));
    child.once('close', code => {
      this._append(session, stdout.write(null, true));
      this._append(session, stderr.write(null, true));
      session.exitCode = Number.isInteger(code) ? code : null;
      session.status = session.stopping ? 'stopped' : 'exited';
      if (signal && session.abort) signal.removeEventListener('abort', session.abort);
      session.child = null;
      this._emit({ type: 'terminal', action: 'exit', id: session.id, status: session.status, exitCode: session.exitCode, terminal: this._snapshot(session) });
      resolveDone(this._snapshot(session));
    });
    if (signal) {
      session.abort = () => { this.stop({ id: session.id }).catch(() => {}); };
      signal.addEventListener('abort', session.abort, { once: true });
      if (signal.aborted) session.abort();
    }
    return this._snapshot(session);
  }

  get(value) { return this._snapshot(this._session(value)); }
  read(id) { return this.get(id); }
  list() { return [...this.sessions.values()].map(session => this._snapshot(session)); }
  async input({ id, text } = {}) {
    const session = this._session({ id });
    if (typeof text !== 'string' || text.length > 65536) throw new Error('El texto para la consola es demasiado largo.');
    if (session.status !== 'running' || !session.child?.stdin.writable) throw new Error('Ese comando ya terminó. Abrí otro para escribir.');
    await new Promise((resolve, reject) => session.child.stdin.write(text, 'utf8', error => error ? reject(new Error('El comando ya no acepta texto.')) : resolve()));
    return this._snapshot(session);
  }
  send(id, text) { return this.input({ id, text }); }

  async _taskkill(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { killer.kill(); finish(); }, 5000);
      killer.once('error', finish); killer.once('close', finish);
    });
  }
  _windowsProcesses() {
    // A shell can launch a child between taskkill's tree enumeration and its
    // termination. Only if the output pipes remain open do we inspect that
    // managed tree again. Concurrent stops share this read-only OS inventory.
    if (this.inventoryPromise) return this.inventoryPromise;
    this.inventoryPromise = new Promise(resolve => {
      const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $rows=@(Get-CimInstance Win32_Process | ForEach-Object { @{id=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Compress";
      const inspector = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '', settled = false;
      const finish = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { const rows = JSON.parse(output); resolve(Array.isArray(rows) ? rows : []); } catch { resolve([]); }
      };
      const timer = setTimeout(() => { inspector.kill(); finish(); }, 5000);
      inspector.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk.toString('utf8'); });
      inspector.once('error', finish); inspector.once('close', finish);
    }).finally(() => { this.inventoryPromise = null; });
    return this.inventoryPromise;
  }
  async _kill(session) {
    const child = session.child;
    if (!child?.pid || !Number.isInteger(child.pid) || child.pid <= 0) return;
    if (process.platform === 'win32') {
      await this._taskkill(child.pid);
      if (session.status === 'running') { try { child.kill('SIGKILL'); } catch {} }
      let timer;
      const closed = await Promise.race([session.done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
      clearTimeout(timer);
      if (!closed) {
        const descendants = new Set([child.pid]);
        for (let attempt = 0; attempt < 3 && session.status === 'running'; attempt++) {
          const rows = await this._windowsProcesses();
          let changed;
          do {
            changed = false;
            for (const row of rows) if (Number.isInteger(row.id) && row.id > 0 && descendants.has(row.parent) && !descendants.has(row.id) && Date.parse(row.started) >= session.spawnedAt - 1000) { descendants.add(row.id); changed = true; }
          } while (changed);
          const survivors = rows.filter(row => descendants.has(row.id) && row.id !== child.pid && Date.parse(row.started) >= session.spawnedAt - 1000);
          if (!survivors.length) break;
          await Promise.all(survivors.map(row => this._taskkill(row.id)));
        }
      }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }
  }
  async stop(value) {
    const session = this._session(value);
    if (session.status !== 'running') return this._snapshot(session);
    if (!session.stopping) {
      // Mark stopping before attempting the kill so even a racing close event
      // has one clear, stable final state.
      session.stopping = Promise.resolve().then(async () => {
        await this._kill(session);
        await session.done;
        return this._snapshot(session);
      });
    }
    return session.stopping;
  }

  async execute(command, { cwd, signal, origin = 'ai' } = {}) {
    if (signal?.aborted) throw abortError();
    const terminal = await this.start({ command, cwd, origin });
    const session = this._session(terminal.id);
    let aborted = false, timedOut = false;
    const cancel = () => { aborted = true; this.stop(terminal.id).catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; this.stop(terminal.id).catch(() => {}); }, COMMAND_TIMEOUT);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await session.done;
      if (aborted) throw abortError();
      if (timedOut) throw new Error('El comando superó 60 segundos y lo detuvimos. Podés abrir una consola para dejarlo funcionando más tiempo.');
      return `Código de salida: ${result.exitCode ?? 'desconocido'}\n${result.output}${result.truncated ? '\n[Se muestra la parte más reciente de una salida muy larga.]' : ''}`;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  dispose() {
    if (!this.disposePromise) {
      this.disposed = true;
      this.disposePromise = Promise.all([...this.sessions.values()].filter(session => session.status === 'running').map(session => this.stop(session.id))).then(() => {});
    }
    return this.disposePromise;
  }
}

module.exports = { TerminalManager };
