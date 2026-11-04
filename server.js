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
const crypto = require('crypto');
const core = require('./public/game-core.js');
const bot = require('./bot.js');

const PUBLIC = path.join(__dirname, 'public');
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
const EMPTY_ROOM_MS = 30 * 60 * 1000;
const IDLE_ROOM_MS = 6 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const rooms = new Map();

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

const cleanName = (n, fallback) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || fallback;
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

function sseSend(res, view) {
  res.write('event: state\ndata: ' + JSON.stringify(view) + '\n\n');
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

function botTurn(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing' || rooms.get(room.code) !== room) return;
  const idx = g.turn;
  const me = room.players[idx];
  if (!me || !me.bot) return;
  let move;
  try {
    move = bot.chooseMove(g, idx, me.level);
  } catch (e) {
    move = { t: 'pass', tradeIds: [] };
  }
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
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- API ----------

function handleEvents(req, res, url) {
  const { room, player } = findPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
  if (!player) return json(res, 404, { ok: false, error: 'Room not found.' });
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
    player.streams.delete(res);
    if (!player.streams.size && rooms.get(room.code) === room && room.players.includes(player)) onDisconnect(room, player);
  });
}

function handleApi(pathname, body, res) {
  if (pathname === '/api/create') {
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { ok: false, error: 'Server is busy, try again later.' });
    const player = newPlayer(cleanName(body.name, 'Player 1'));
    const room = { code: makeCode(), players: [player], host: player, phase: 'lobby', game: null, lastActive: Date.now() };
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
    const room = rooms.get(String(body.code || '').toUpperCase().trim());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found. Check the code.' });
    if (room.phase !== 'lobby') return json(res, 409, { ok: false, error: 'That game has already started.' });
    if (room.players.length >= MAX_PLAYERS) return json(res, 409, { ok: false, error: 'That room is full (4 players max).' });
    const player = newPlayer(uniqueName(room, cleanName(body.name, 'Player ' + (room.players.length + 1))));
    room.players.push(player);
    room.lastActive = Date.now();
    broadcast(room);
    return json(res, 200, { ok: true, code: room.code, token: player.token });
  }

  if (pathname === '/api/act') {
    const { room, player } = findPlayer(body.code, body.token);
    if (!player) return json(res, 404, { ok: false, error: 'Room not found.' });
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200);
      return res.end('ok');
    }
    if (req.method === 'GET' && url.pathname === '/api/state-check') {
      const { player } = findPlayer(url.searchParams.get('code'), url.searchParams.get('token'));
      return json(res, player ? 200 : 404, { ok: !!player });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);
      return handleApi(url.pathname, body && typeof body === 'object' ? body : {}, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { ok: false, error: 'Bad request.' });
  }
});

// Keep SSE connections alive through proxies; clean up abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = humans(room).some(isConnected);
    for (const p of room.players) for (const s of p.streams) s.write(': ping\n\n');
    if ((!anyConnected && now - room.lastActive > EMPTY_ROOM_MS) || now - room.lastActive > IDLE_ROOM_MS) {
      for (const p of room.players) for (const s of p.streams) s.end();
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 20000).unref();

function start(port) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (require.main === module) {
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
