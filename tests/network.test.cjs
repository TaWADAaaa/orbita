'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NetworkTools } = require('../network.cjs');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const page = (body = '<html><title>Una página</title><body>Hola</body></html>', options = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });
const setup = (fetchImpl, lookup = publicLookup) => new NetworkTools({ fetchImpl, lookup });

test('reads a public page, removes visual noise, decodes entities and keeps a plain title', async () => {
  const network = setup(async () => page('<html><head><title>Guía &amp; prueba &#x1F30E;</title><style>secret</style></head><body><nav>Menú molesto</nav><main><h1>Creaci&oacute;n</h1><p>Uno&nbsp;&lt;dos&gt; &#241; &quot;tres&quot;.</p><script>leerClaves()</script><footer>Pie molesto</footer></main></body></html>'));
  const result = await network.fetchPage({ url: 'https://example.com/article#section' });
  assert.equal(result.url, 'https://example.com/article');
  assert.equal(result.title, 'Guía & prueba 🌎');
  assert.equal(result.text, 'Creación\nUno <dos> ñ "tres".');
  assert.equal(result.truncated, false);
});

test('plain text is preserved and long readable content is marked truncated', async () => {
  const network = setup(async () => new Response('a'.repeat(49000), { headers: { 'content-type': 'text/plain' } }));
  const result = await network.fetchPage({ url: 'https://example.com/' });
  assert.equal(result.text.length, 48000); assert.equal(result.truncated, true); assert.equal(result.title, 'example.com');
});

test('blocks local, private, metadata, reserved, unsupported schemes and credentials before fetching', async () => {
  let fetched = 0;
  const network = setup(async () => { fetched++; return page(); });
  const urls = [
    'file:///c:/Windows/win.ini', 'ftp://example.com/', 'https://user:password@example.com/', 'https://example.com:8080/',
    'http://localhost/', 'http://host.local/', 'http://metadata.google.internal/', 'http://0/', 'http://127.1/', 'http://0x7f000001/',
    'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://100.100.100.200/', 'http://168.63.129.16/', 'http://192.0.2.1/', 'http://198.18.1.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
    'http://[ff02::1]/', 'http://[2001:db8::1]/', 'http://[2001::1]/', 'http://[2002:7f00:1::]/', 'http://[3fff::1]/'
  ];
  for (const url of urls) await assert.rejects(network.fetchPage({ url }), /Solo páginas públicas de internet/, url);
  assert.equal(fetched, 0);
});

test('validates all DNS records, including mixed private IPv6, and rejects empty DNS results', async () => {
  for (const addresses of [[], [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }], [{ address: '127.0.0.1', family: 4 }], [{ address: '2001:db8::1', family: 6 }]]) {
    const network = setup(async () => assert.fail('Must not fetch private DNS destination'), async () => addresses);
    await assert.rejects(network.fetchPage({ url: 'https://example.com/' }), /Solo páginas públicas/);
  }
});

test('allows public IPv4 and IPv6 literals without another DNS lookup', async () => {
  const calls = [];
  const network = setup(async (url, options) => { calls.push(url); assert.equal(options.redirect, 'manual'); return page(); }, async () => assert.fail('A literal must not need DNS'));
  await network.fetchPage({ url: 'https://93.184.216.34/' });
  await network.fetchPage({ url: 'https://[2606:4700:4700::1111]/' });
  assert.equal(calls.length, 2);
});

test('revalidates redirect destinations and refuses redirects into the local network', async () => {
  for (const location of ['http://127.0.0.1/private', 'http://[::ffff:192.168.1.1]/', 'http://host.internal/private', 'https://evil.example/']) {
    let fetched = 0;
    const network = setup(async () => { fetched++; return new Response(null, { status: 302, headers: { location } }); }, async hostname => hostname === 'evil.example' ? [{ address: '10.0.0.1', family: 4 }] : publicLookup());
    await assert.rejects(network.fetchPage({ url: 'https://example.com/' }), /Solo páginas públicas/);
    assert.equal(fetched, 1);
  }
});

test('allows relative redirects, resolves DNS again and limits redirect chains', async () => {
  let fetched = 0, lookedUp = 0;
  const network = setup(async url => { fetched++; return url.endsWith('/next') ? page() : new Response(null, { status: 301, headers: { location: '/next' } }); }, async () => { lookedUp++; return publicLookup(); });
  const result = await network.fetchPage({ url: 'https://example.com/' });
  assert.equal(result.url, 'https://example.com/next'); assert.equal(fetched, 2); assert.equal(lookedUp, 2);
  const loop = setup(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
  await assert.rejects(loop.fetchPage({ url: 'https://example.com/' }), /demasiadas páginas/);
});

test('search parses RSS, safely encodes the query and deduplicates public results', async () => {
  let requested;
  const network = setup(async url => {
    requested = new URL(url);
    return new Response('<rss><channel><item><title><![CDATA[Node &amp; HTTP]]></title><link>https://nodejs.org/api/http.html?a=1&amp;b=2</link><description><![CDATA[<b>Guía</b> &#241;]]></description></item><item><title>Duplicado</title><link>https://nodejs.org/api/http.html?a=1&amp;b=2</link></item><item><title>Local</title><link>http://127.0.0.1/</link></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } });
  });
  const result = await network.search({ query: '  Node HTTP & "docs"  ' });
  assert.equal(requested.hostname, 'www.bing.com'); assert.equal(requested.searchParams.get('format'), 'rss'); assert.equal(requested.searchParams.get('q'), 'Node HTTP & "docs"');
  assert.equal(result.query, 'Node HTTP & "docs"');
  assert.deepEqual(result.results, [{ title: 'Node & HTTP', url: 'https://nodejs.org/api/http.html?a=1&b=2', snippet: 'Guía ñ' }]);
});

test('falls back to DuckDuckGo for empty or failed RSS and unwraps result links', async () => {
  for (const failed of [false, true]) {
    const network = setup(async url => {
      if (new URL(url).hostname === 'www.bing.com') { if (failed) throw Error('Bing down'); return new Response('<rss/>', { headers: { 'content-type': 'application/xml' } }); }
      return page('<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F">Node <b>docs</b></a><a class="result__snippet">Documentaci&oacute;n &amp; ayuda.</a></div>');
    });
    const result = await network.search({ query: 'Node docs' });
    assert.deepEqual(result.results, [{ title: 'Node docs', url: 'https://nodejs.org/api/', snippet: 'Documentación & ayuda.' }]);
  }
});

test('falls back when the primary search returns results unrelated to the question', async () => {
  const calls = [];
  const network = setup(async url => {
    calls.push(new URL(url).hostname);
    if (calls.length === 1) return new Response('<rss><item><title>Official Twitch</title><link>https://twitch.tv/</link><description>Streams</description></item></rss>', { headers: { 'content-type': 'application/xml' } });
    return page('<a class="result__a" href="https://nodejs.org/api/">Node.js documentation</a><div class="result__snippet">Official HTTP reference</div>');
  });
  const result = await network.search({ query: 'Node.js official documentation HTTP' });
  assert.equal(result.results[0].url, 'https://nodejs.org/api/'); assert.deepEqual(calls, ['www.bing.com', 'html.duckduckgo.com']);
});

test('rejects missing/long queries, binary downloads, large headers and oversized streaming bodies', async () => {
  const network = setup(async () => assert.fail('Should validate query first'));
  await assert.rejects(network.search({ query: '' }), /qué querés buscar/);
  await assert.rejects(network.search({ query: 'a'.repeat(401) }), /400/);
  await assert.rejects(setup(async () => new Response('binary', { headers: { 'content-type': 'application/pdf' } })).fetchPage({ url: 'https://example.com/' }), /archivo/);
  await assert.rejects(setup(async () => page('small', { headers: { 'content-length': '3000000' } })).fetchPage({ url: 'https://example.com/' }), /demasiado grande/);
  await assert.rejects(setup(async () => page('a'.repeat(2 * 1024 * 1024 + 1))).fetchPage({ url: 'https://example.com/' }), /demasiado grande/);
});

test('aborts an outstanding DNS lookup and does not start a network request', async () => {
  const controller = new AbortController();
  const network = setup(async () => assert.fail('Should not fetch'), () => new Promise(() => {}));
  const result = network.fetchPage({ url: 'https://example.com/', signal: controller.signal });
  controller.abort(); await assert.rejects(result, error => error.name === 'AbortError');
});

test('aborts while waiting for page bytes and cancels the response reader', async () => {
  const controller = new AbortController(); let cancelled = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const network = setup(async () => new Response(new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/plain' } }));
  const result = network.fetchPage({ url: 'https://example.com/', signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(result, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test('has an overall timeout even when a transport ignores its abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const network = setup(async () => new Promise(() => {}));
  const result = network.fetchPage({ url: 'https://example.com/' });
  for (let index = 0; index < 8; index++) await Promise.resolve();
  t.mock.timers.tick(15001);
  await assert.rejects(result, /tardó demasiado/);
});

test('an already stopped query never consults DNS or the internet', async () => {
  const signal = AbortSignal.abort();
  const network = setup(async () => assert.fail('Should not fetch'), async () => assert.fail('Should not resolve'));
  await assert.rejects(network.fetchPage({ url: 'https://example.com/', signal }), error => error.name === 'AbortError');
});

test('native transport pins the checked DNS address and decodes gzip and Brotli', async t => {
  const https = require('node:https'), zlib = require('node:zlib');
  const { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
  const pending = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(url.hostname, 'example.com'); assert.equal(options.agent, false);
    assert.equal(options.autoSelectFamily, false); assert.equal(options.family, 4);
    options.lookup('example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const { encoding, content } = pending.shift(), response = new PassThrough();
      response.statusCode = 200; response.headers = { 'content-type': 'text/html', 'content-encoding': encoding };
      callback(response);
      response.end(encoding === 'br' ? zlib.brotliCompressSync(content) : zlib.gzipSync(content));
    });
    return request;
  });
  const network = new NetworkTools({ lookup: publicLookup });
  for (const encoding of ['gzip', 'br']) {
    pending.push({ encoding, content: '<title>Comprimida</title><main>Texto leído</main>' });
    const result = await network.fetchPage({ url: 'https://example.com/' });
    assert.equal(result.title, 'Comprimida'); assert.match(result.text, /Texto leído/);
  }
  pending.push({ encoding: 'gzip', content: 'a'.repeat(2 * 1024 * 1024 + 1) });
  await assert.rejects(network.fetchPage({ url: 'https://example.com/' }), /demasiado grande/);
});
