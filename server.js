'use strict';
// Four online server. No dependencies: static files + JSON API + Server-Sent Events.
//   POST /api/create {name}              -> {ok, code, token}
//   POST /api/join   {code, name}        -> {ok, code, token}
//   POST /api/act    {code, token, t, ...} actions: start, play, pass, recycle, skip, restart, leave
//   GET  /api/events?code=&token=        -> SSE stream of personalized room state
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const core = require('./public/game-core.js');
const bot = require('./bot.js');
const botpool = require('./botpool.js');
const guard = require('./guard.js');

const PUBLIC = path.join(__dirname, 'public');
// Extra hosts a future ad network needs, space separated (see GOING_LIVE.md): CSP_SCRIPT, CSP_IMG, CSP_CONNECT, CSP_FRAME.
const cspList = (name) => (process.env[name] || '').split(/\s+/).filter(Boolean);
const SEC_HEADERS = guard.buildHeaders(PUBLIC, { script: cspList('CSP_SCRIPT'), img: cspList('CSP_IMG'), connect: cspList('CSP_CONNECT'), frame: cspList('CSP_FRAME') });
// Number of reverse proxies in front of this server (Render = 1, Cloudflare + Render = 2). Unset = auto-detect.
const TRUST_PROXY = process.env.TRUST_PROXY;
const limiter = new guard.RateLimiter();
// Tests set FOUR_DISABLE_LIMITS=1 so they can create hundreds of rooms from one address.
const limitsOff = () => process.env.FOUR_DISABLE_LIMITS === '1';
// Abuse limits. Windows are in the names. "Per IP" is per client address (an IPv6 /64 counts as one).
const LIM = {
  reqPerMin: 900, // every request, static files included
  createPer10m: 15, // new rooms
  botRoomsPer10m: 8, // new rooms with computer players (these cost CPU)
  joinPer10m: 40,
  failPer10m: 20, // wrong room codes / bad tokens: stops guessing the 4-letter codes
  actPerMin: 240, // game actions per IP
  actPerMinToken: 90, // game actions per player
  roomsPerIp: 6, // rooms alive at once
  botRoomsPerIp: 3,
  maxBotRooms: 100, // all computer-player rooms together
  streamsPerIp: 30, // open live connections
  streamsPerPlayer: 3,
  maxStreams: 4000,
};
const stats = { limited: 0, streams: 0 };
const ipStreams = new Map();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const MAX_PLAYERS = 4;
const MAX_ROOMS = 500;
const LOBBY_GRACE_MS = 60 * 1000;
const NEVER_JOINED_MS = 5 * 60 * 1000; // lobby nobody is connected to
const EMPTY_ROOM_MS = 30 * 60 * 1000; // game with everybody disconnected
const LOBBY_IDLE_MS = 30 * 60 * 1000; // lobby with people connected but nothing happening
const IDLE_ROOM_MS = 2 * 60 * 60 * 1000; // game with no action at all
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const rooms = new Map();

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

const cleanName = guard.cleanName;
const newPlayer = (name) => ({ name, token: crypto.randomBytes(16).toString('hex'), streams: new Set(), dropTimer: null });
const isConnected = (p) => !!p.bot || p.streams.size > 0; // computer players are always "online"
const humans = (room) => room.players.filter((p) => !p.bot);
const BOT_NAMES = ['Robo', 'Pixel', 'Dot', 'Beep'];
const cleanLevel = (l) => (bot.LEVELS.includes(l) ? l : 'normal');

function newBot(room, level) {
  const free = BOT_NAMES.filter((n) => !room.players.some((p) => p.name === n));
  const p = newPlayer(free[0] || 'Computer');
  p.bot = true;
  p.level = cleanLevel(level);
  return p;
}

function uniqueName(room, name) {
  let n = name;
  let i = 2;
  while (room.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = name.slice(0, 13) + ' ' + i++;
  return n;
}

// ---------- State views ----------

function viewFor(room, idx) {
  const g = room.game;
  const v = {
    code: room.code,
    phase: room.phase,
    you: idx,
    host: room.players.indexOf(room.host),
    players: room.players.map((p, i) => ({
      name: p.name,
      connected: isConnected(p),
      bot: !!p.bot,
      level: p.bot ? p.level : undefined,
      score: g ? g.scores[i] : 0,
      handCount: g ? g.hands[i].length : 0,
    })),
  };
  if (g) {
    v.turn = g.turn;
    v.drawCount = g.draw.length;
    v.board = Object.entries(g.board).map(([k, card]) => Object.assign(core.parseKey(k), { card }));
    v.hand = g.hands[idx];
    v.log = g.log.slice(-40);
    v.lastPlay = g.lastPlay;
    v.winners = g.winners;
  }
  return v;
}

// Write to a live stream; cut off clients that are not reading (their buffer would grow without bound).
function sseWrite(res, text) {
  if (res.destroyed || res.writableEnded) return;
  if (res.writableLength > 512 * 1024) return res.destroy();
  res.write(text);
}

function sseSend(res, view) {
  sseWrite(res, 'event: state\ndata: ' + JSON.stringify(view) + '\n\n');
}

function broadcast(room) {
  room.players.forEach((p, i) => {
    if (!p.streams.size) return;
    const view = viewFor(room, i);
    for (const res of p.streams) sseSend(res, view);
  });
}

// ---------- Room helpers ----------

function removeFromLobby(room, player) {
  clearTimeout(player.dropTimer);
  for (const res of player.streams) res.end();
  player.streams.clear();
  room.players = room.players.filter((p) => p !== player);
  if (humans(room).length === 0) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
    return;
  }
  if (room.host === player) room.host = humans(room)[0];
  broadcast(room);
}

// ---------- Computer players ----------

function scheduleBot(room) {
  clearTimeout(room.botTimer);
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const cur = room.players[g.turn];
  if (!cur || !cur.bot) return;
  if (!humans(room).some(isConnected)) return; // nobody watching: don't burn CPU
  room.botTimer = setTimeout(() => botTurn(room), 800 + Math.random() * 700);
  if (room.botTimer.unref) room.botTimer.unref();
}

async function botTurn(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing' || rooms.get(room.code) !== room || room.botThinking) return;
  const idx = g.turn;
  const me = room.players[idx];
  if (!me || !me.bot) return;
  room.botThinking = true;
  let move;
  try {
    move = await botpool.choose(g, idx, me.level); // thinks in a worker thread, never blocks other games
  } catch (e) {
    move = null;
  }
  room.botThinking = false;
  // The room may have ended or moved on while the bot was thinking.
  if (rooms.get(room.code) !== room || room.game !== g || g.phase !== 'playing' || g.turn !== idx) return scheduleBot(room);
  if (!move) move = { t: 'pass', tradeIds: [] };
  let r = move.t === 'play' ? core.applyPlay(g, idx, move.placements) : core.applyPass(g, idx, move.tradeIds);
  if (!r.ok) r = core.applyPass(g, idx, []); // safety net: never get stuck
  room.phase = g.phase;
  broadcast(room);
  scheduleBot(room);
}

function onDisconnect(room, player) {
  if (room.phase === 'lobby') {
    clearTimeout(player.dropTimer);
    player.dropTimer = setTimeout(() => {
      if (room.phase === 'lobby' && !isConnected(player) && room.players.includes(player)) removeFromLobby(room, player);
    }, LOBBY_GRACE_MS);
    player.dropTimer.unref && player.dropTimer.unref();
  }
  broadcast(room);
}

function findPlayer(code, token) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (!room) return {};
  const player = room.players.find((p) => typeof token === 'string' && p.token === token);
  return player ? { room, player } : {};
}

// ---------- HTTP helpers ----------

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(new Error('too big'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (rel.includes('\0') || !file.startsWith(PUBLIC + path.sep) || path.basename(file).startsWith('.')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  const notFound = () => {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('Not found');
  };
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound();
    const hit = staticCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return sendStatic(req, res, hit);
    fs.readFile(file, (err2, data) => {
      if (err2) return notFound();
      const ext = path.extname(file);
      const entry = {
        mtime: st.mtimeMs,
        data,
        ext,
        type: MIME[ext] || 'application/octet-stream',
        etag: '"' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + '"',
        enc: {},
      };
      staticCache.set(file, entry); // bounded: only files that exist inside public/
      sendStatic(req, res, entry);
    });
  });
}

// Files are read once and kept in memory (compressed on first use), so serving them costs almost nothing.
const staticCache = new Map();
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
function sendStatic(req, res, e) {
  const long = e.ext === '.png' || e.ext === '.svg' || e.ext === '.ico';
  const headers = {
    'Content-Type': e.type,
    ETag: e.etag,
    'Cache-Control': long ? 'public, max-age=86400' : 'public, max-age=60, must-revalidate',
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === e.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let body = e.data;
  if (COMPRESSIBLE.has(e.ext) && e.data.length > 512) {
    const ae = String(req.headers['accept-encoding'] || '');
    const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
    if (enc) {
      if (!e.enc[enc]) e.enc[enc] = enc === 'br' ? zlib.brotliCompressSync(e.data) : zlib.gzipSync(e.data, { level: 9 });
      body = e.enc[enc];
      headers['Content-Encoding'] = enc;
    }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- API ----------

const tooMany = (res, msg) => {
  stats.limited++;
  return json(res, 429, { ok: false, error: msg || 'Too many requests. Please wait a moment.' });
};
// Wrong codes / tokens are counted per address; once over the limit the lookups stop answering.
function strike(ip) {
  return limiter.hit('fail:' + ip, LIM.failPer10m, 600000);
}
const struckOut = (ip) => {
  if (limitsOff()) return false;
  const e = limiter.map.get('fail:' + ip);
  return !!e && e.n > LIM.failPer10m && Date.now() - e.start < e.windowMs;
};

function handleEvents(req, res, url, ip) {
  if (struckOut(ip)) return tooMany(res);
  const { room, player } = findPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
  if (!player) {
    strike(ip);
    return json(res, 404, { ok: false, error: 'Room not found.' });
  }
  if (!limitsOff() && (stats.streams >= LIM.maxStreams || (ipStreams.get(ip) || 0) >= LIM.streamsPerIp)) return tooMany(res, 'Too many open connections.');
  while (player.streams.size >= LIM.streamsPerPlayer) {
    // Same player, too many tabs: drop the oldest.
    const old = player.streams.values().next().value;
    player.streams.delete(old);
    old.end();
  }
  stats.streams++;
  ipStreams.set(ip, (ipStreams.get(ip) || 0) + 1);
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  clearTimeout(player.dropTimer);
  player.streams.add(res);
  room.lastActive = Date.now();
  broadcast(room); // everyone sees the connection status change, and this stream gets its first state
  scheduleBot(room); // a human came back: let the computer keep playing
  req.on('close', () => {
    stats.streams--;
    const n = (ipStreams.get(ip) || 1) - 1;
    if (n > 0) ipStreams.set(ip, n);
    else ipStreams.delete(ip);
    player.streams.delete(res);
    if (!player.streams.size && rooms.get(room.code) === room && room.players.includes(player)) onDisconnect(room, player);
  });
}

const hasBots = (room) => room.players.some((p) => p.bot);
const botRoomCount = () => {
  let n = 0;
  for (const r of rooms.values()) if (hasBots(r)) n++;
  return n;
};
// Can this address have one more room with computer players? (they use CPU, so they are limited harder)
function botRoomAllowed(ip, room) {
  if (limitsOff()) return true;
  if (botRoomCount() >= LIM.maxBotRooms) return false;
  let mine = 0;
  for (const r of rooms.values()) if (r !== room && r.ownerIp === ip && hasBots(r)) mine++;
  return mine < LIM.botRoomsPerIp;
}

function handleApi(pathname, body, res, ip) {
  if (pathname === '/api/create') {
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { ok: false, error: 'Server is busy, try again later.' });
    const wantsBots = Number.isInteger(body.bots) && body.bots > 0 && body.bots < MAX_PLAYERS;
    if (!limitsOff()) {
      if (!limiter.hit('create:' + ip, LIM.createPer10m, 600000)) return tooMany(res, 'You are creating rooms too fast. Try again in a few minutes.');
      let mine = 0;
      for (const r of rooms.values()) if (r.ownerIp === ip) mine++;
      if (mine >= LIM.roomsPerIp) return tooMany(res, 'You already have several games open. Close one first.');
      if (wantsBots) {
        if (!limiter.hit('createbot:' + ip, LIM.botRoomsPer10m, 600000)) return tooMany(res, 'You are creating games too fast. Try again in a few minutes.');
        if (!botRoomAllowed(ip)) return json(res, 503, { ok: false, error: 'The computer players are busy right now. Try again soon, or play with friends.' });
      }
    }
    const player = newPlayer(cleanName(body.name, 'Player 1'));
    const room = { code: makeCode(), players: [player], host: player, phase: 'lobby', game: null, lastActive: Date.now(), ownerIp: ip };
    // Play against the computer (or alone): `bots` = number of computer opponents (0 = solo), game starts at once.
    if (Number.isInteger(body.bots) && body.bots >= 0 && body.bots < MAX_PLAYERS) {
      for (let i = 0; i < body.bots; i++) room.players.push(newBot(room, body.level));
      room.solo = body.bots === 0;
      room.game = core.createGame(room.players.length);
      room.phase = 'playing';
    }
    rooms.set(room.code, room);
    scheduleBot(room);
    return json(res, 200, { ok: true, code: room.code, token: player.token });
  }

  if (pathname === '/api/join') {
    if (struckOut(ip) || (!limitsOff() && !limiter.hit('join:' + ip, LIM.joinPer10m, 600000))) return tooMany(res);
    const room = rooms.get(String(body.code || '').toUpperCase().trim());
    if (!room) {
      strike(ip);
      return json(res, 404, { ok: false, error: 'Room not found. Check the code.' });
    }
    if (room.phase !== 'lobby') return json(res, 409, { ok: false, error: 'That game has already started.' });
    if (room.players.length >= MAX_PLAYERS) return json(res, 409, { ok: false, error: 'That room is full (4 players max).' });
    const player = newPlayer(uniqueName(room, cleanName(body.name, 'Player ' + (room.players.length + 1))));
    room.players.push(player);
    room.lastActive = Date.now();
    broadcast(room);
    return json(res, 200, { ok: true, code: room.code, token: player.token });
  }

  if (pathname === '/api/act') {
    if (struckOut(ip) || (!limitsOff() && !limiter.hit('act:' + ip, LIM.actPerMin, 60000))) return tooMany(res);
    const { room, player } = findPlayer(body.code, body.token);
    if (!player) {
      strike(ip);
      return json(res, 404, { ok: false, error: 'Room not found.' });
    }
    if (!limitsOff() && !limiter.hit('tok:' + player.token, LIM.actPerMinToken, 60000)) return tooMany(res);
    room.lastActive = Date.now();
    const idx = room.players.indexOf(player);
    const g = room.game;
    const fail = (error) => json(res, 200, { ok: false, error });
    const done = (r) => {
      if (r && r.ok === false) return fail(r.error);
      if (room.game) room.phase = room.game.phase;
      broadcast(room);
      scheduleBot(room);
      return json(res, 200, { ok: true });
    };

    switch (body.t) {
      case 'start':
        if (room.phase !== 'lobby') return fail('The game already started.');
        if (room.host !== player) return fail('Only the host can start the game.');
        if (room.players.length < 2) return fail('You need at least 2 players.');
        room.game = core.createGame(room.players.length);
        room.phase = 'playing';
        return done();
      case 'addBot':
        if (room.phase !== 'lobby') return fail('The game already started.');
        if (room.host !== player) return fail('Only the host can add a computer player.');
        if (room.players.length >= MAX_PLAYERS) return fail('The room is full.');
        if (!hasBots(room) && !botRoomAllowed(ip, room)) return fail('The computer players are busy right now. Try again soon.');
        room.players.push(newBot(room, body.level));
        return done();
      case 'removeBot': {
        if (room.phase !== 'lobby') return fail('The game already started.');
        if (room.host !== player) return fail('Only the host can remove a computer player.');
        const b = room.players[body.index];
        if (!b || !b.bot) return fail('That is not a computer player.');
        room.players = room.players.filter((p) => p !== b);
        return done();
      }
      case 'rematch': {
        if (room.phase !== 'finished') return fail('The game is not over.');
        if (room.host !== player) return fail('Only the host can start another game.');
        room.players = room.players.filter(isConnected);
        if (room.players.length < (room.solo ? 1 : 2)) return fail('Not enough players for another game.');
        room.game = core.createGame(room.players.length);
        room.phase = 'playing';
        return done();
      }
      case 'play':
        if (!g) return fail('The game has not started.');
        return done(core.applyPlay(g, idx, body.placements));
      case 'pass':
        if (!g) return fail('The game has not started.');
        return done(core.applyPass(g, idx, body.tradeIds));
      case 'recycle':
        if (!g) return fail('The game has not started.');
        return done(core.applyRecycle(g, idx, body.x, body.y, body.cardId));
      case 'skip': {
        if (!g || g.phase !== 'playing') return fail('Nothing to skip.');
        const cur = room.players[g.turn];
        if (cur === player || isConnected(cur)) return fail('That player is still connected.');
        return done(core.applyPass(g, g.turn, [], { skip: true }));
      }
      case 'restart': {
        if (room.phase !== 'finished') return fail('The game is not over.');
        if (room.host !== player && isConnected(room.host)) return fail('Only the host can do that.');
        room.players = room.players.filter(isConnected);
        room.host = room.players.includes(room.host) ? room.host : player;
        room.game = null;
        room.phase = 'lobby';
        return done();
      }
      case 'leave':
        if (room.phase === 'lobby') removeFromLobby(room, player);
        else {
          for (const s of player.streams) s.end();
        }
        return json(res, 200, { ok: true });
      default:
        return fail('Unknown action.');
    }
  }

  return json(res, 404, { ok: false, error: 'Not found.' });
}

const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  try {
    const ip = guard.clientIp(req, TRUST_PROXY);
    const url = new URL(req.url, 'http://localhost');
    if (process.env.LOG_IPS === '1' && url.pathname === '/api/create') console.log('[ip] seen=' + ip + ' socket=' + req.socket.remoteAddress + ' xff=' + (req.headers['x-forwarded-for'] || '-'));
    for (const k in SEC_HEADERS) res.setHeader(k, SEC_HEADERS[k]);
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // 6 months; add includeSubDomains/preload once sure
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200);
      return res.end('ok');
    }
    if (!limitsOff() && !limiter.hit('req:' + ip, LIM.reqPerMin, 60000)) return tooMany(res);
    if (req.method === 'GET' && url.pathname === '/api/state-check') {
      if (struckOut(ip)) return tooMany(res);
      const { player } = findPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!player) strike(ip);
      return json(res, player ? 200 : 404, { ok: !!player });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url, ip);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Only our own pages may call the API from a browser, and only with JSON (blocks cross-site form posts).
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch (e) {
          /* bad origin */
        }
        if (!ok) return json(res, 403, { ok: false, error: 'Forbidden.' });
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Send JSON.' });
      if (Number(req.headers['content-length']) > 4096) return json(res, 413, { ok: false, error: 'Too big.' });
      const body = await readJson(req);
      return handleApi(url.pathname, body && typeof body === 'object' && !Array.isArray(body) ? body : {}, res, ip);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { ok: false, error: 'Bad request.' });
  }
});

// Keep SSE connections alive through proxies; clean up abandoned rooms.
function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = humans(room).some(isConnected);
    for (const p of room.players) for (const s of p.streams) sseWrite(s, ': ping\n\n');
    const idle = now - room.lastActive;
    const dead =
      (room.phase === 'lobby' && !anyConnected && idle > NEVER_JOINED_MS) ||
      (room.phase === 'lobby' && idle > LOBBY_IDLE_MS) ||
      (!anyConnected && idle > EMPTY_ROOM_MS) ||
      idle > IDLE_ROOM_MS;
    if (dead) {
      for (const p of room.players) for (const s of p.streams) s.end();
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
  limiter.sweep(now);
}
setInterval(sweepRooms, 20000).unref();

// One line every 5 minutes: enough to watch load and cost without any monitoring service.
setInterval(() => {
  const mb = (n) => Math.round(n / 1048576);
  console.log(
    '[stats] rooms=' + rooms.size + ' botRooms=' + botRoomCount() + ' streams=' + stats.streams + ' botQueue=' + botpool.queued() +
      ' rss=' + mb(process.memoryUsage().rss) + 'MB loopP99=' + Math.round(loopDelay.percentile(99) / 1e6) + 'ms limited=' + stats.limited
  );
  loopDelay.reset();
  stats.limited = 0;
}, 5 * 60 * 1000).unref();

function start(port) {
  // Drop slow or stalled clients early (slowloris); SSE streams are unaffected because they are not request bodies.
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  server.maxConnections = LIM.maxStreams + 1500;
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

if (require.main === module) {
  // One bad request must never take every running game down with it.
  process.on('uncaughtException', (e) => console.error('[error] uncaught:', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => console.error('[error] unhandled rejection:', e && e.stack ? e.stack : e));
  process.on('SIGTERM', () => process.exit(0));
  const port = Number(process.env.PORT) || 3000;
  start(port).then(() => {
    console.log('Four is running:');
    console.log('  http://localhost:' + port);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  http://' + i.address + ':' + port + '   (same Wi-Fi)');
    }
  });
}

module.exports = { start, server };
