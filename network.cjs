'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const BODY_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 48000;
const TIMEOUT = 15000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PUBLIC_MESSAGE = 'Solo páginas públicas de internet. No se pueden abrir direcciones de tu PC o de tu red.';
const problem = (message, code) => Object.assign(new Error(message), { code });
const publicError = () => problem(PUBLIC_MESSAGE, 'NETWORK_PUBLIC_ONLY');
const abortError = () => Object.assign(new Error('Consulta de internet detenida.'), { name: 'AbortError' });
const checkAbort = signal => { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(); };

function abortable(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function ipv6Number(address) {
  let value = address.toLowerCase();
  if (value.includes('%')) return null;
  if (value.includes('.')) {
    const index = value.lastIndexOf(':'), parts = value.slice(index + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = value.slice(0, index + 1) + ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const count = 8 - left.length - right.length;
  if (count < 0 || (halves.length === 1 && count !== 0) || (halves.length === 2 && count < 1)) return null;
  const words = [...left, ...Array(count).fill('0'), ...right];
  if (words.some(word => !/^[a-f0-9]{1,4}$/.test(word))) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(parseInt(word, 16)), 0n);
}

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || address === '168.63.129.16' ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const number = ipv6Number(address);
    if (number === null || (number >> 125n) !== 1n) return false; // Only global unicast 2000::/3.
    if ((number >> 96n) === 0x20010db8n || (number >> 105n) === (0x20010000000000000000000000000000n >> 105n)) return false;
    if ((number >> 112n) === 0x2002n || (number >> 108n) === 0x3fff0n) return false; // 6to4 and documentation addresses.
    return true;
  }
  return false;
}

function publicUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) throw problem('Pegá un enlace completo, por ejemplo https://example.com.', 'NETWORK_URL');
  let url;
  try { url = new URL(input.trim()); } catch { throw problem('Ese enlace no es válido. Usá una dirección que empiece con http:// o https://.', 'NETWORK_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw publicError();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/.test(hostname) || hostname.includes('%')) throw publicError();
  if (net.isIP(hostname) && !publicAddress(hostname)) throw publicError();
  url.hash = '';
  return { url, hostname };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  auml: 'ä', ouml: 'ö', Auml: 'Ä', Ouml: 'Ö', szlig: 'ß', ccedil: 'ç', Ccedil: 'Ç', deg: '°', times: '×', divide: '÷',
  plusmn: '±', ne: '≠', le: '≤', ge: '≥', larr: '←', rarr: '→', uarr: '↑', darr: '↓', zwj: '', zwnj: '', shy: ''
};
function entities(text) {
  return String(text).replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? match;
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
  });
}
function plainText(html) {
  return entities(String(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|nav|footer|header|aside|form|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>|<\/(?:p|div|section|article|main|h[1-6]|li|tr|pre|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\t\f\v \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function tagValue(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(xml);
  return match ? match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1') : '';
}
function resultUrl(value, base) {
  try {
    let url = new URL(entities(value), base);
    if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.has('uddg')) url = new URL(url.searchParams.get('uddg'));
    return publicUrl(url.href).url.href;
  } catch { return null; }
}
function rssResults(xml) {
  const results = [];
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const url = resultUrl(tagValue(item[1], 'link'));
    const title = plainText(tagValue(item[1], 'title'));
    if (url && title && !results.some(result => result.url === url)) results.push({ title: title.slice(0, 300), url, snippet: plainText(tagValue(item[1], 'description')).slice(0, 1000) });
    if (results.length >= 8) break;
  }
  return results;
}
function duckResults(html) {
  const results = [];
  const matches = [...html.matchAll(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*>[\s\S]*?<\/a\s*>/gi)];
  for (let index = 0; index < matches.length && results.length < 8; index++) {
    const match = matches[index], href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(match[0]);
    const url = resultUrl(href?.[2] || '', 'https://duckduckgo.com');
    const title = plainText(match[0]);
    const tail = html.slice(match.index + match[0].length, matches[index + 1]?.index ?? html.length);
    const snippet = /<(?:a|div|span)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div|span)\s*>/i.exec(tail);
    if (url && title && !results.some(result => result.url === url)) results.push({ title: title.slice(0, 300), url, snippet: plainText(snippet?.[1] || '').slice(0, 1000) });
  }
  return results;
}
function relevantResults(query, results) {
  const normalize = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const ignored = new Set(['the', 'and', 'for', 'with', 'que', 'como', 'para', 'con', 'las', 'los', 'una', 'unos', 'unas', 'del', 'por']);
  const terms = [...new Set(normalize(query).split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 3 && !ignored.has(term)))];
  if (!terms.length) return results.length > 0;
  return results.some(result => {
    const words = new Set(normalize(`${result.title} ${result.snippet} ${result.url.replace(/^https?:\/\//, '')}`).split(/[^\p{L}\p{N}]+/u));
    return terms.filter(term => words.has(term)).length >= Math.min(terms.length > 2 ? 2 : 1, terms.length);
  });
}

class NetworkTools {
  constructor({ fetchImpl, lookup = dns.lookup, emit } = {}) {
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.emit = emit; // The caller owns UI events; this service does not publish duplicate results.
  }

  async _operation(signal, work) {
    checkAbort(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(problem('La página tardó demasiado. Probá de nuevo en unos segundos.', 'NETWORK_TIMEOUT')), TIMEOUT);
    try { return await work(controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error.code?.startsWith('NETWORK_')) throw error;
      throw problem('No pudimos consultar esa página. Revisá la conexión a internet o probá otro enlace.', 'NETWORK_CONNECTION');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async _resolve(input, signal) {
    checkAbort(signal);
    const checked = publicUrl(input);
    if (net.isIP(checked.hostname)) return { ...checked, addresses: [{ address: checked.hostname, family: net.isIP(checked.hostname) }] };
    const addresses = await abortable(this.lookup(checked.hostname, { all: true, verbatim: true }), signal);
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(record => !publicAddress(record.address))) throw publicError();
    return { ...checked, addresses };
  }

  _nativeRequest(checked, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const selected = checked.addresses.find(record => record.family === 4) || checked.addresses[0];
      const request = (checked.url.protocol === 'https:' ? https : http).request(checked.url, {
        method: 'GET', agent: false, signal, family: selected.family, autoSelectFamily: false,
        maxHeaderSize: 32768,
        lookup: (_host, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
        },
        headers: { 'User-Agent': 'OrbitaLocal/0.1 (public page reader)', Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br' }
      }, response => {
        const header = name => response.headers[name.toLowerCase()];
        if (REDIRECTS.has(response.statusCode)) { response.destroy(); resolve({ status: response.statusCode, header, bytes: null }); return; }
        const length = Number(header('content-length'));
        if (length > BODY_LIMIT) { response.destroy(); reject(problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT')); return; }
        const encoding = String(header('content-encoding') || '').toLowerCase().trim();
        let decoder;
        if (encoding === 'br') decoder = zlib.createBrotliDecompress();
        else if (encoding === 'gzip' || encoding === 'x-gzip') decoder = zlib.createGunzip();
        else if (encoding === 'deflate') decoder = zlib.createInflate();
        else if (encoding && encoding !== 'identity') { response.destroy(); reject(problem('Esa página usa un formato que todavía no podemos leer.', 'NETWORK_FORMAT')); return; }
        let wireBytes = 0, decodedBytes = 0, finished = false;
        const chunks = [];
        const fail = error => { if (finished) return; finished = true; response.destroy(); decoder?.destroy(); request.destroy(); reject(error); };
        response.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > BODY_LIMIT) fail(problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT')); });
        response.on('error', fail);
        response.on('aborted', () => fail(problem('La página cortó la conexión antes de terminar. Probá de nuevo.', 'NETWORK_CONNECTION')));
        const stream = decoder ? response.pipe(decoder) : response;
        stream.on('error', fail);
        stream.on('data', chunk => {
          decodedBytes += chunk.length;
          if (decodedBytes > BODY_LIMIT) fail(problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT'));
          else chunks.push(chunk);
        });
        stream.on('end', () => { if (!finished) { finished = true; resolve({ status: response.statusCode, header, bytes: Buffer.concat(chunks) }); } });
      });
      request.on('error', reject);
      request.end();
    });
  }

  async _mockRequest(checked, signal) {
    const response = await abortable(this.fetchImpl(checked.url.href, { method: 'GET', redirect: 'manual', signal, headers: { Accept: 'text/html,application/rss+xml,application/xml,text/plain' } }), signal);
    const header = name => response.headers?.get?.(name) ?? response.headers?.[name.toLowerCase()];
    if (REDIRECTS.has(response.status)) { response.body?.cancel?.().catch?.(() => {}); return { status: response.status, header, bytes: null }; }
    if (Number(header('content-length')) > BODY_LIMIT) { response.body?.cancel?.().catch?.(() => {}); throw problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT'); }
    let size = 0;
    const chunks = [];
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await abortable(reader.read(), signal);
          if (done) break;
          const chunk = Buffer.from(value); size += chunk.length;
          if (size > BODY_LIMIT) throw problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT');
          chunks.push(chunk);
        }
      } finally { reader.cancel().catch(() => {}); }
    } else {
      const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal));
      if (bytes.length > BODY_LIMIT) throw problem('La página es demasiado grande. Probá un enlace a una página más corta.', 'NETWORK_LIMIT');
      chunks.push(bytes);
    }
    return { status: response.status, header, bytes: Buffer.concat(chunks) };
  }

  async _get(input, signal) {
    let current = input;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const checked = await this._resolve(current, signal);
      const response = await abortable(this.fetchImpl ? this._mockRequest(checked, signal) : this._nativeRequest(checked, signal), signal);
      if (REDIRECTS.has(response.status)) {
        if (redirects === 5) throw problem('Ese enlace pasa por demasiadas páginas. Probá con el enlace final.', 'NETWORK_REDIRECT');
        const location = response.header('location');
        if (!location) throw problem('Ese enlace no indica qué página abrir. Probá otro enlace.', 'NETWORK_REDIRECT');
        current = new URL(location, checked.url).href;
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw problem(`La página respondió con un error (${response.status}). Probá otro enlace.`, 'NETWORK_STATUS');
      const type = String(response.header('content-type') || '').toLowerCase();
      if (type && !/^(?:text\/|application\/(?:xhtml\+xml|(?:rss\+|atom\+)?xml|json)(?:;|$))/.test(type)) throw problem('Ese enlace es un archivo que no podemos leer como una página. Abrí una página con texto.', 'NETWORK_FORMAT');
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1] || 'utf-8';
      let source;
      try { source = new TextDecoder(charset).decode(response.bytes); } catch { source = response.bytes.toString('utf8'); }
      return { url: checked.url.href, source, type };
    }
    throw problem('No pudimos seguir ese enlace.', 'NETWORK_REDIRECT');
  }

  async fetchPage({ url, signal } = {}) {
    return this._operation(signal, async requestSignal => {
      const page = await this._get(url, requestSignal);
      const isMarkup = /html|xml/.test(page.type) || (!page.type && /^\s*(?:<!doctype|<html|<\?xml)/i.test(page.source));
      const title = isMarkup ? plainText(tagValue(page.source, 'title')).slice(0, 300) : '';
      const text = isMarkup ? plainText(page.source) : page.source.replace(/\r\n/g, '\n').trim();
      return { url: page.url, title: title || new URL(page.url).hostname, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
    });
  }

  async search({ query, signal } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw problem('Escribí qué querés buscar en internet.', 'NETWORK_QUERY');
    if (query.length > 400) throw problem('La búsqueda es demasiado larga. Usá hasta 400 caracteres.', 'NETWORK_QUERY');
    query = query.trim();
    return this._operation(signal, async requestSignal => {
      let firstError;
      try {
        const page = await this._get(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, requestSignal);
        const results = rssResults(page.source);
        if (results.length && relevantResults(query, results)) return { query, results };
      } catch (error) { checkAbort(requestSignal); firstError = error; }
      try {
        const page = await this._get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, requestSignal);
        const results = duckResults(page.source);
        if (results.length) return { query, results };
        throw problem('No encontramos resultados. Probá con otras palabras.', 'NETWORK_EMPTY');
      } catch (error) { checkAbort(requestSignal); throw firstError || error; }
    });
  }
}

module.exports = { NetworkTools };
