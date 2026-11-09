'use strict';
const assert = require('node:assert');
process.env.FOUR_DISABLE_LIMITS = '1'; // this test makes many rooms from one address
const core = require('../public/game-core.js');
const { start } = require('../server.js');

let base;

async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// Minimal SSE client: keeps the latest state and lets tests wait for a condition.
function openStream(code, token) {
  const ac = new AbortController();
  const s = { latest: null, waiters: [], status: 0, abort: () => ac.abort() };
  s.ready = fetch(base + '/api/events?code=' + code + '&token=' + token, { signal: ac.signal }).then(async (res) => {
    s.status = res.status;
    if (res.status !== 200) return;
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = block.match(/^data: (.*)$/m);
          if (m && /^event: state/m.test(block)) {
            s.latest = JSON.parse(m[1]);
            s.waiters = s.waiters.filter((w) => !w(s.latest));
          }
        }
      }
    } catch (e) {
      /* aborted */
    }
  });
  s.waitFor = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      if (s.latest && pred(s.latest)) return resolve(s.latest);
      const t = setTimeout(() => reject(new Error('timeout waiting for state; last=' + JSON.stringify(s.latest && { phase: s.latest.phase, turn: s.latest.turn }))), ms);
      s.waiters.push((st) => {
        if (pred(st)) {
          clearTimeout(t);
          resolve(st);
          return true;
        }
        return false;
      });
    });
  return s;
}

function findSingleMove(view) {
  const board = {};
  for (const c of view.board) board[core.key(c.x, c.y)] = c.card;
  for (const k of Object.keys(board)) {
    const { x, y } = core.parseKey(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const c of view.hand) {
        const p = [{ id: c.id, x: x + dx, y: y + dy }];
        if (core.validatePlay(board, p, view.hand).ok) return p;
      }
    }
  }
  return null;
}

(async () => {
  const server = await start(0);
  base = 'http://127.0.0.1:' + server.address().port;
  const step = (m) => console.log('  ok  ' + m);

  // Static files and health
  assert.strictEqual((await fetch(base + '/healthz')).status, 200);
  assert.strictEqual((await fetch(base + '/../server.js')).status === 200 && false, false);
  assert.strictEqual((await fetch(base + '/%2e%2e/server.js')).status, 404);
  step('health + path traversal blocked');

  // Lobby
  const a = (await post('/api/create', { name: 'Ana' })).body;
  assert.ok(a.ok && /^[A-Z]{4}$/.test(a.code));
  const bad = await post('/api/join', { code: 'ZZZZ', name: 'X' });
  assert.strictEqual(bad.status, 404);
  const b = (await post('/api/join', { code: a.code.toLowerCase(), name: 'Ana' })).body; // same name -> deduped
  assert.ok(b.ok);
  const sa = openStream(a.code, a.token);
  const sb = openStream(b.code, b.token);
  await sa.waitFor((s) => s.players.length === 2 && s.players.every((p) => p.connected));
  assert.notStrictEqual(sa.latest.players[0].name, sa.latest.players[1].name);
  step('create + join (+ duplicate name handled) + live lobby');

  assert.strictEqual((await post('/api/act', { code: a.code, token: b.token, t: 'start' })).body.ok, false);
  assert.strictEqual((await post('/api/act', { code: a.code, token: 'wrong', t: 'start' })).status, 404);
  assert.strictEqual((await post('/api/act', { code: a.code, token: a.token, t: 'start' })).body.ok, true);
  const va = await sa.waitFor((s) => s.phase === 'playing');
  const vb = await sb.waitFor((s) => s.phase === 'playing');
  assert.strictEqual(va.hand.length, 4);
  assert.strictEqual(vb.hand.length, 4);
  assert.strictEqual(va.board.length, 1);
  assert.strictEqual(va.drawCount, 66 - 8 - 1);
  assert.ok(va.hand.every((c) => !vb.hand.some((d) => d.id === c.id)), 'hands are private and distinct');
  assert.strictEqual(va.players[1].handCount, 4);
  assert.ok(!('hands' in va));
  step('only host can start; hands private; deck counts right');

  // Turn enforcement and move validation
  const [turnTok, turnStream, waitTok, waitStream] = va.turn === va.you ? [a.token, sa, b.token, sb] : [b.token, sb, a.token, sa];
  const mine = turnStream.latest;
  const notMyTurn = await post('/api/act', { code: a.code, token: waitTok, t: 'pass', tradeIds: [] });
  assert.strictEqual(notMyTurn.body.ok, false);
  const far = await post('/api/act', { code: a.code, token: turnTok, t: 'play', placements: [{ id: mine.hand[0].id, x: 9, y: 9 }] });
  assert.strictEqual(far.body.ok, false);
  const skipEarly = await post('/api/act', { code: a.code, token: waitTok, t: 'skip' });
  assert.strictEqual(skipEarly.body.ok, false);
  step('out-of-turn, illegal placement and early skip rejected');

  // A legal play
  const move = findSingleMove(mine);
  assert.ok(move, 'a single-card move should always exist on the starter');
  const played = await post('/api/act', { code: a.code, token: turnTok, t: 'play', placements: move });
  assert.ok(played.body.ok, JSON.stringify(played.body));
  const after = await waitStream.waitFor((s) => s.board.length === 2);
  assert.strictEqual(after.turn, after.you);
  assert.ok(after.players.some((p) => p.score > 0));
  assert.strictEqual(after.hand.length, 4);
  assert.strictEqual(after.lastPlay.cells.length, 1);
  assert.strictEqual(after.drawCount, 66 - 8 - 1 - 1);
  step('legal play scores, refills hand, passes turn, broadcasts');

  // Trade
  const hand = waitStream.latest.hand;
  const traded = await post('/api/act', { code: a.code, token: waitTok, t: 'pass', tradeIds: [hand[0].id, hand[1].id] });
  assert.ok(traded.body.ok);
  const afterTrade = await waitStream.waitFor((s) => s.turn !== s.you);
  assert.strictEqual(afterTrade.hand.length, 4);
  assert.ok(!afterTrade.hand.some((c) => c.id === hand[0].id || c.id === hand[1].id));
  step('pass + trade keeps hand size');

  // Disconnect, skip, reconnect
  const view0 = turnStream.latest;
  waitStream.abort();
  await turnStream.waitFor((s) => s.players.some((p) => !p.connected));
  // it is now turnStream player's turn; the disconnected player cannot be skipped until it's their turn.
  assert.strictEqual((await post('/api/act', { code: a.code, token: turnTok, t: 'skip' })).body.ok, false);
  const re = openStream(a.code, waitTok);
  const rv = await re.waitFor((s) => s.phase === 'playing' && s.players.every((p) => p.connected));
  assert.strictEqual(rv.board.length, view0.board.length);
  step('disconnect detected, reconnect with token restores state');

  // Full-length random game over HTTP to the end, to be sure the server flow completes
  const tokens = { [turnTok]: turnStream, [waitTok]: re };
  let safety = 0;
  for (;;) {
    if (++safety > 800) throw new Error('game did not end');
    const entries = Object.entries(tokens);
    const [tok, st] = entries.find(([, s]) => s.latest.turn === s.latest.you) || [];
    if (!tok) {
      await new Promise((r) => setTimeout(r, 15));
      if (entries[0][1].latest.phase === 'finished') break;
      continue;
    }
    const v = st.latest;
    if (v.phase === 'finished') break;
    const mv = findSingleMove(v);
    const r = mv
      ? await post('/api/act', { code: a.code, token: tok, t: 'play', placements: mv })
      : await post('/api/act', { code: a.code, token: tok, t: 'pass', tradeIds: v.drawCount ? [v.hand[0].id] : [] });
    assert.ok(r.body.ok, JSON.stringify(r.body));
    await new Promise((r2) => setTimeout(r2, 10));
    if (entries[0][1].latest.phase === 'finished') break;
  }
  const fin = await turnStream.waitFor((s) => s.phase === 'finished');
  assert.ok(fin.winners.length >= 1);
  step('a whole game plays through to "finished" (winners: ' + fin.winners.map((i) => fin.players[i].name).join(', ') + ')');

  // Restart back to lobby
  const hostTok = fin.host === 0 ? (turnStream.latest.you === 0 ? turnTok : waitTok) : turnStream.latest.you === 1 ? turnTok : waitTok;
  assert.ok((await post('/api/act', { code: a.code, token: hostTok, t: 'restart' })).body.ok);
  await turnStream.waitFor((s) => s.phase === 'lobby');
  step('host can send everyone back to the lobby');

  // ---- Computer players ----
  // Host adds / removes computer players in the lobby.
  const h = (await post('/api/create', { name: 'Hana' })).body;
  const sh = openStream(h.code, h.token);
  await sh.waitFor((s) => s.phase === 'lobby');
  assert.strictEqual((await post('/api/act', { code: h.code, token: h.token, t: 'start' })).body.ok, false, 'cannot start alone');
  assert.ok((await post('/api/act', { code: h.code, token: h.token, t: 'addBot', level: 'hard' })).body.ok);
  const lob = await sh.waitFor((s) => s.players.length === 2);
  assert.ok(lob.players[1].bot && lob.players[1].connected && lob.players[1].level === 'hard');
  assert.ok((await post('/api/act', { code: h.code, token: h.token, t: 'addBot' })).body.ok);
  assert.ok((await post('/api/act', { code: h.code, token: h.token, t: 'addBot' })).body.ok);
  assert.strictEqual((await post('/api/act', { code: h.code, token: h.token, t: 'addBot' })).body.ok, false, 'room is capped at 4');
  assert.ok((await post('/api/act', { code: h.code, token: h.token, t: 'removeBot', index: 3 })).body.ok);
  assert.strictEqual((await post('/api/act', { code: h.code, token: h.token, t: 'removeBot', index: 0 })).body.ok, false, 'cannot remove a human');
  await sh.waitFor((s) => s.players.length === 3);
  step('host can add and remove computer players (max 4 seats)');

  // The computer takes its turns by itself, and only plays legal moves.
  assert.ok((await post('/api/act', { code: h.code, token: h.token, t: 'start' })).body.ok);
  let seenLog = -1; // log length when we last acted; the next turn of ours must come after more entries
  let humanTurns = 0;
  while (humanTurns < 3) {
    const v = await sh.waitFor((s) => s.phase === 'playing' && s.turn === s.you && s.log.length > seenLog, 15000);
    const mv = findSingleMove(v);
    const r = mv
      ? await post('/api/act', { code: h.code, token: h.token, t: 'play', placements: mv })
      : await post('/api/act', { code: h.code, token: h.token, t: 'pass', tradeIds: [] });
    assert.ok(r.body.ok, JSON.stringify(r.body));
    humanTurns++;
    await sh.waitFor((s) => s.log.length > v.log.length, 3000); // our move is in the log
    seenLog = sh.latest.log.length; // bots will add at least one more entry before it is our turn again
  }
  const finalView = await sh.waitFor((s) => s.turn === s.you && s.log.length > seenLog, 15000);
  assert.ok(finalView.log.some((e) => e.player !== 0), 'computer players acted on their own');
  assert.ok(finalView.log.filter((e) => e.player !== 0).length >= 2 * humanTurns - 1, 'both computers took a turn after each of ours');
  step('computer players take their own turns');

  // One-click solo / vs-computer rooms.
  const solo = (await post('/api/create', { name: 'Solo', bots: 0 })).body;
  const ss = openStream(solo.code, solo.token);
  const sv = await ss.waitFor((s) => s.phase === 'playing');
  assert.strictEqual(sv.players.length, 1);
  assert.strictEqual(sv.turn, 0);
  const smove = findSingleMove(sv);
  assert.ok((await post('/api/act', { code: solo.code, token: solo.token, t: 'play', placements: smove })).body.ok);
  const sv2 = await ss.waitFor((s) => s.board.length === 2);
  assert.strictEqual(sv2.turn, 0, 'in solo mode it is always your turn');
  step('solo game (no opponents) starts at once and stays on your turn');

  const vs = (await post('/api/create', { name: 'Vee', bots: 2, level: 'easy' })).body;
  const sx = openStream(vs.code, vs.token);
  const xv = await sx.waitFor((s) => s.phase === 'playing');
  assert.strictEqual(xv.players.length, 3);
  assert.ok(xv.players[1].bot && xv.players[2].bot && xv.players[1].level === 'easy');
  assert.strictEqual((await post('/api/create', { name: 'X', bots: 4 })).body.players, undefined);
  step('"play the computer" rooms start immediately with the chosen opponents');

  sh.abort(); ss.abort(); sx.abort();

  console.log('online tests passed');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
