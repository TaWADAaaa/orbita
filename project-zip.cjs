'use strict';

// A small standard ZIP writer (stored entries). No installed command, network or
// executable is needed to export a project. Entries are supplied by safe readers.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let value = i; for (let j = 0; j < 8; j++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; crcTable[i] = value >>> 0; }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
const stopped = signal => { if (signal?.aborted) throw Object.assign(new Error('Empaquetado detenido.'), { name: 'AbortError' }); };

async function createProjectZip({ entries, resolve, signal, limit = 128 * 1024 * 1024 }) {
  if (!Array.isArray(entries) || entries.length > 5000) throw new Error('Hay demasiados archivos para un ZIP. Elegí una carpeta más pequeña.');
  const local = [], central = []; let offset = 0, total = 0, count = 0;
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    stopped(signal);
    if (typeof entry.path !== 'string' || !entry.path || /(?:^|\/)\.\.(?:\/|$)|^[\\/]|[\x00-\x1f:]/.test(entry.path)) throw new Error('Un archivo tiene un nombre que no se puede empaquetar.');
    const name = Buffer.from(entry.path.replace(/\\/g, '/') + (entry.directory ? '/' : ''), 'utf8');
    if (name.length > 65535) throw new Error('Un nombre de archivo es demasiado largo para ZIP.');
    let bytes = Buffer.alloc(0);
    if (!entry.directory) {
      const info = await resolve(entry.path), handle = await fs.open(info.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || total + stat.size > limit) throw new Error('El proyecto es demasiado grande para este ZIP. El límite es 128 MB y 64 MB por archivo.');
        bytes = Buffer.alloc(stat.size); let position = 0;
        while (position < bytes.length) { stopped(signal); const { bytesRead } = await handle.read(bytes, position, Math.min(1024 * 1024, bytes.length - position), position); if (!bytesRead) throw new Error('Un archivo cambió mientras armábamos el ZIP. Probá otra vez.'); position += bytesRead; }
        const after = await handle.stat(), current = await fs.lstat((await resolve(entry.path)).absolute);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || stat.ino !== current.ino || stat.size !== current.size || stat.mtimeMs !== current.mtimeMs) throw new Error('Un archivo cambió mientras armábamos el ZIP. Probá otra vez.');
      } finally { await handle.close(); }
    } else await resolve(entry.path);
    const crc = crc32(bytes), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(entry.directory ? 0x10 : 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(directory, name); offset += header.length + name.length + bytes.length; total += bytes.length; count++;
  }
  stopped(signal); const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...local, centralBytes, end]), files: entries.filter(entry => !entry.directory).length };
}

module.exports = { createProjectZip, crc32 };
