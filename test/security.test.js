'use strict';
// Abuse-protection tests against the real server with the limits ON.
// Different "visitors" are simulated with X-Forwarded-For (the server trusts one proxy hop from loopback by default).
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const guard = require('../guard.js');
const { start } = require('../server.js');

delete process.env.FOUR_DISABLE_LIMITS;
let base;
let ipSeq = 0;
const newIp = () => '203.0.113.' + ++ipSeq;

async function req(method, p, { ip, body, headers, raw } = {}) {
  const h = Object.assign({ 'X-Forwarded-For': ip || newIp() }, headers);
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  const text = await r.text();
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* not json */
  }
  return { status: r.status, headers: r.headers, json, text };
}
const post = (p, body, o) => req('POST', p, Object.assign({ body }, o));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('security headers on pages and API, CSP allows exactly the inline theme script', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no unsafe-inline for scripts');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inline.length >= 1);
  for (const m of inline) assert.ok(csp.includes("'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'"), 'inline script hash in CSP');
  const a = await post('/api/create', { name: 'x' });
  assert.ok(a.headers.get('content-security-policy'));
  const https = await req('GET', '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.ok(https.headers.get('strict-transport-security'));
});

test('static files: gzip, ETag/304, dotfiles and traversal refused', async () => {
  const r = await req('GET', '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-encoding'), 'gzip');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const again = await req('GET', '/app.js', { headers: { 'If-None-Match': etag } });
  assert.strictEqual(again.status, 304);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%00', '/.git/config', '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
    const x = await req('GET', p);
    assert.ok([400, 403, 404].includes(x.status), p + ' -> ' + x.status);
    assert.ok(!/require\(|root:/.test(x.text), p + ' leaked content');
  }
});

test('POST must be JSON, same-origin and small', async () => {
  const host = base.replace('http://', '');
  assert.strictEqual((await post('/api/create', { name: 'a' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await post('/api/create', { name: 'a' }, { headers: { Origin: 'http://' + host } })).status, 200);
  assert.strictEqual((await req('POST', '/api/create', { raw: '{"name":"a"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.strictEqual((await req('POST', '/api/create', { raw: '{"name":"' + 'a'.repeat(5000) + '"}', headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.strictEqual((await req('POST', '/api/create', { raw: '{not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.strictEqual((await req('POST', '/api/create', { raw: '[1,2]', headers: { 'Content-Type': 'application/json' } })).status, 200); // array treated as empty body
});

test('malformed and hostile input never crashes the server', async () => {
  const ip = newIp();
  const { json: made } = await post('/api/create', { name: 'Fuzz', bots: 0 }, { ip });
  const { code, token } = made;
  const junk = [
    { t: 'play', placements: 'x' }, { t: 'play', placements: [null, 1, 'a', [], {}] },
    { t: 'play', placements: [{ id: 1e999, x: NaN, y: {} }] }, { t: 'play', placements: [{ id: 1, x: 1e12, y: -1e12 }] },
    { t: 'play', placements: new Array(500).fill({ id: 1, x: 0, y: 1 }) },
    { t: 'pass', tradeIds: 'abc' }, { t: 'pass', tradeIds: [{}, null, '1', -1, 1e99] }, { t: 'pass', tradeIds: new Array(300).fill(2) },
    { t: 'recycle', x: {}, y: [], cardId: null }, { t: 'recycle', x: '__proto__', y: 'constructor', cardId: 'x' },
    { t: 'removeBot', index: '__proto__' }, { t: 'addBot', level: { toString: 1 } }, { t: ['play'] }, { t: '__proto__' }, { t: 42 },
    { __proto__: null, code, token, t: 'skip' }, { t: 'leave' + '\0' },
  ];
  for (const j of junk) {
    const r = await post('/api/act', Object.assign({ code, token }, j), { ip });
    assert.ok([200, 413, 429].includes(r.status), JSON.stringify(j).slice(0, 60) + ' -> ' + r.status);
  }
  for (const j of [{ name: {} , bots: 'x'}, { name: [1], bots: -1 }, { name: 'a', bots: 99, level: 5 }, { code: {}, name: 1 }, { code: ['A'] }]) {
    const r = await post(j.code ? '/api/join' : '/api/create', j, { ip: newIp() });
    assert.ok([200, 404, 429].includes(r.status), JSON.stringify(j) + ' -> ' + r.status);
  }
  assert.strictEqual((await req('GET', '/healthz')).status, 200);
  assert.strictEqual((await req('GET', '/api/events?code=' + 'A'.repeat(5000))).status, 404);
});

test('names: control, zero-width and bidi characters removed; length by characters', async () => {
  assert.strictEqual(guard.cleanName('a‮b​c\u0000d', 'x'), 'a b c d');
  assert.strictEqual(guard.cleanName('​‮', 'fallback'), 'fallback');
  assert.strictEqual(Array.from(guard.cleanName('😀'.repeat(40), 'x')).length, 16);
  assert.ok(!/[\ud800-\udbff]$/.test(guard.cleanName('😀'.repeat(40), 'x')), 'no cut surrogate pair');
});

test('guessing room codes is blocked after a few misses', async () => {
  const ip = newIp();
  let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const r = await post('/api/join', { code: 'ZZZ' + 'ABCDEFGHJKLMNPQRSTUVWXYZ'[i % 24], name: 'g' }, { ip });
    if (r.status === 429) blocked++;
    else assert.strictEqual(r.status, 404);
  }
  assert.ok(blocked >= 15, 'blocked ' + blocked);
  // the same address cannot use a real code any more, but another address can
  const host = (await post('/api/create', { name: 'Host' })).json;
  assert.strictEqual((await post('/api/join', { code: host.code, name: 'n' }, { ip })).status, 429);
  assert.strictEqual((await post('/api/join', { code: host.code, name: 'n' })).status, 200);
});

test('one address can only keep a few rooms; computer-player rooms are limited harder', async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await post('/api/create', { name: 'r' + i }, { ip })).status);
  assert.deepStrictEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.strictEqual(statuses[6], 429);
  const ip2 = newIp();
  const bots = [];
  for (let i = 0; i < 5; i++) bots.push((await post('/api/create', { name: 'b' + i, bots: 2, level: 'easy' }, { ip: ip2 })).status);
  assert.deepStrictEqual(bots.slice(0, 3), [200, 200, 200]);
  assert.strictEqual(bots[3], 503);
});

test('action spam from one player is throttled', async () => {
  const ip = newIp();
  const { json: m } = await post('/api/create', { name: 'Spam' }, { ip });
  let limited = 0;
  for (let i = 0; i < 130; i++) {
    const r = await post('/api/act', { code: m.code, token: m.token, t: 'skip' }, { ip });
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 30, 'limited ' + limited);
});

test('live connections are capped per player and per address', async () => {
  const ip = newIp();
  const { json: m } = await post('/api/create', { name: 'Many' }, { ip });
  const opened = [];
  const open = async (code, token) => {
    const ac = new AbortController();
    const r = await fetch(base + '/api/events?code=' + code + '&token=' + token, { signal: ac.signal, headers: { 'X-Forwarded-For': ip } });
    opened.push(ac);
    return r.status;
  };
  // same player: older tabs get closed, never more than 3 alive (all 6 opens succeed)
  for (let i = 0; i < 6; i++) assert.strictEqual(await open(m.code, m.token), 200);
  // many different players from one address: capped at 30 streams
  let denied = 0;
  for (let i = 0; i < 40; i++) {
    const c = (await post('/api/create', { name: 'p' + i }, { ip: newIp() })).json;
    const st = await open2(c.code, c.token, ip);
    if (st === 429) denied++;
  }
  async function open2(code, token, ipx) {
    const ac = new AbortController();
    const r = await fetch(base + '/api/events?code=' + code + '&token=' + token, { signal: ac.signal, headers: { 'X-Forwarded-For': ipx } });
    opened.push(ac);
    return r.status;
  }
  assert.ok(denied >= 10, 'denied ' + denied);
  opened.forEach((a) => a.abort());
});

test('slow or oversized headers are cut off', async () => {
  const huge = await new Promise((resolve) => {
    const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\nX-A: ' + 'a'.repeat(20000) + '\r\n\r\n'));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });
  assert.ok(/^HTTP\/1\.1 (400|431)/.test(huge) || huge === '', 'oversized header refused: ' + huge.slice(0, 40));
  assert.strictEqual((await req('GET', '/healthz')).status, 200);
});

test('client IP: forged X-Forwarded-For entries are ignored when more hops are trusted', () => {
  const mk = (xff, remote) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  assert.strictEqual(guard.clientIp(mk('1.1.1.1, 2.2.2.2', '10.0.0.5'), '1'), '2.2.2.2');
  assert.strictEqual(guard.clientIp(mk('9.9.9.9, 1.1.1.1, 2.2.2.2', '10.0.0.5'), '2'), '1.1.1.1');
  assert.strictEqual(guard.clientIp(mk('9.9.9.9', '8.8.8.8'), undefined), '8.8.8.8', 'public socket + auto: header ignored');
  assert.strictEqual(guard.clientIp(mk('9.9.9.9', '10.1.2.3'), undefined), '9.9.9.9', 'private socket + auto: trust proxy');
  assert.strictEqual(guard.clientIp(mk('', '::ffff:8.8.4.4'), '0'), '8.8.4.4');
  assert.strictEqual(guard.clientIp(mk('', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '0'), '2001:db8:1:2');
});

test('rate limiter windows reset and memory stays bounded', () => {
  const l = new guard.RateLimiter(100);
  assert.ok(l.hit('a', 2, 1000, 0));
  assert.ok(l.hit('a', 2, 1000, 1));
  assert.ok(!l.hit('a', 2, 1000, 2));
  assert.ok(l.hit('a', 2, 1000, 1001));
  for (let i = 0; i < 1000; i++) l.hit('k' + i, 1, 1e9, 5);
  assert.ok(l.map.size <= 100);
});

(async () => {
  const server = await start(0);
  base = 'http://127.0.0.1:' + server.address().port;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
    }
  }
  console.log(failed ? failed + ' security test(s) failed' : 'security tests passed');
  process.exit(failed ? 1 : 0);
})();
