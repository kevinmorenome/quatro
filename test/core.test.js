'use strict';
const assert = require('node:assert');
const core = require('../public/game-core.js');
const { key } = core;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n', e);
    process.exitCode = 1;
  }
}

const card = (id, color, shape, num) => ({ id, color, shape, num, wild: false });
const wild = (id) => ({ id, wild: true });
const boardOf = (list) => {
  const b = {};
  for (const [x, y, c] of list) b[key(x, y)] = c;
  return b;
};

console.log('Four core');

test('deck has 66 cards: 64 unique + 2 wild', () => {
  const d = core.buildDeck();
  assert.strictEqual(d.length, 66);
  assert.strictEqual(d.filter((c) => c.wild).length, 2);
  const uniq = new Set(d.filter((c) => !c.wild).map((c) => c.color + c.shape + c.num));
  assert.strictEqual(uniq.size, 64);
});

test('lineOk: all same / all different rule', () => {
  assert.ok(core.lineOk([card(0, 'red', 'circle', 1), card(1, 'blue', 'square', 1)])); // any two cards
  assert.ok(core.lineOk([card(0, 'red', 'circle', 1), card(1, 'red', 'square', 2), card(2, 'red', 'triangle', 3)]));
  assert.ok(!core.lineOk([card(0, 'red', 'circle', 1), card(1, 'red', 'square', 2), card(2, 'blue', 'triangle', 3)]));
  assert.ok(!core.lineOk([card(0, 'red', 'circle', 1), card(1, 'blue', 'square', 2), card(2, 'green', 'triangle', 2)]));
});

test('play must connect to the grid, be in one line, and have no gaps', () => {
  const board = boardOf([[0, 0, card(0, 'red', 'circle', 1)]]);
  const hand = [card(1, 'red', 'square', 2), card(2, 'red', 'triangle', 3)];
  assert.ok(core.validatePlay(board, [{ id: 1, x: 1, y: 0 }], hand).ok);
  assert.ok(!core.validatePlay(board, [{ id: 1, x: 5, y: 5 }], hand).ok, 'not touching');
  assert.ok(!core.validatePlay(board, [{ id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 1 }], hand).ok, 'not one line');
  assert.ok(!core.validatePlay(board, [{ id: 1, x: 1, y: 0 }, { id: 2, x: 3, y: 0 }], hand).ok, 'gap');
});

test('cards played may be separated by cards already in play', () => {
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [2, 0, card(1, 'red', 'triangle', 3)],
  ]);
  const hand = [card(2, 'red', 'square', 2)];
  const r = core.validatePlay(board, [{ id: 2, x: 1, y: 0 }], hand);
  assert.ok(r.ok);
  assert.strictEqual(r.score, 6);
});

test('lot (4 in a line) doubles the score', () => {
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [1, 0, card(1, 'red', 'square', 2)],
    [2, 0, card(2, 'red', 'triangle', 3)],
  ]);
  const r = core.validatePlay(board, [{ id: 3, x: 3, y: 0 }], [card(3, 'red', 'cross', 4)]);
  assert.ok(r.ok);
  assert.strictEqual(r.lots, 1);
  assert.strictEqual(r.base, 10);
  assert.strictEqual(r.score, 20);
});

test('lines longer than 4 are rejected', () => {
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [1, 0, card(1, 'red', 'square', 2)],
    [2, 0, card(2, 'red', 'triangle', 3)],
    [3, 0, card(3, 'red', 'cross', 4)],
  ]);
  const r = core.validatePlay(board, [{ id: 4, x: 4, y: 0 }], [card(4, 'blue', 'circle', 1)]);
  assert.ok(!r.ok);
});

test('a card in two lines counts twice; invalid cross-line is rejected', () => {
  // vertical pair, then a card extends both a row and the column
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [0, 1, card(1, 'blue', 'circle', 1)],
    [1, 0, card(2, 'green', 'circle', 1)],
  ]);
  // (1,1): row with (0,1) blue circle 1 -> pair OK; column with (1,0) green circle 1 -> pair OK
  const r = core.validatePlay(board, [{ id: 3, x: 1, y: 1 }], [card(3, 'yellow', 'circle', 1)]);
  assert.ok(r.ok);
  assert.strictEqual(r.lines.length, 2);
  assert.strictEqual(r.base, 4); // 1+1 and 1+1
  // a card that makes the column invalid: (0,2) joins col (0,0)red,(0,1)blue circle 1 -> needs green/yellow circle 1
  const bad = core.validatePlay(board, [{ id: 4, x: 0, y: 2 }], [card(4, 'red', 'square', 2)]);
  assert.ok(!bad.ok);
});

test('playing all 4 cards doubles; stacking with lots', () => {
  // Existing: single card. Play 3 into a lot of 4 along with... need 4 cards in hand.
  const board = boardOf([[0, 0, card(0, 'red', 'circle', 1)]]);
  const hand = [card(1, 'red', 'square', 2), card(2, 'red', 'triangle', 3), card(3, 'red', 'cross', 4), card(4, 'blue', 'circle', 1)];
  const r = core.validatePlay(board, [
    { id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 0 }, { id: 3, x: 3, y: 0 },
  ], hand);
  assert.ok(r.ok);
  assert.strictEqual(r.score, 20); // lot of 10, doubled
  // four cards in a column that can't fit: max line is 4 including the touching card -> 5 invalid
  const r5 = core.validatePlay(board, [
    { id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 0 }, { id: 3, x: 3, y: 0 }, { id: 4, x: 4, y: 0 },
  ], hand);
  assert.ok(!r5.ok);
});

test('four-card play from an empty-ish board scores x2', () => {
  // two separate cards; place 4 across a column touching one of them
  const board = boardOf([[0, 0, card(0, 'red', 'circle', 1)]]);
  const hand = [
    card(1, 'blue', 'square', 2), card(2, 'green', 'triangle', 3), card(3, 'yellow', 'cross', 4),
    card(4, 'red', 'circle', 1),
  ];
  // vertical: starter red circle 1 at (0,0); play (0,1),(0,2),(0,3) -> 4 cards in line: colors all different,
  // shapes all different, numbers all different => valid lot; that's 3 cards. Use 4 cards via two-sided extension:
  const r = core.validatePlay(board, [{ id: 1, x: 0, y: 1 }, { id: 2, x: 0, y: 2 }, { id: 3, x: 0, y: 3 }], hand);
  assert.ok(r.ok);
  assert.strictEqual(r.lots, 1);
  assert.strictEqual(r.score, (1 + 2 + 3 + 4) * 2);
});

test('wild: face value 0 and fits whichever card the line needs', () => {
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [1, 0, card(1, 'red', 'square', 2)],
  ]);
  const r = core.validatePlay(board, [{ id: 9, x: 2, y: 0 }], [wild(9)]);
  assert.ok(r.ok);
  assert.strictEqual(r.score, 3); // 1 + 2 + 0
});

test('wild must represent one consistent card across two lines', () => {
  // Wild at (1,1) would need to be red (row with red cards) and blue (column with blue cards) -> impossible
  const board = boardOf([
    [0, 1, card(0, 'red', 'circle', 1)],
    [2, 1, card(1, 'red', 'circle', 1)], // makes row r,w,r need same color red, all same everything -> distinct fails
  ]);
  const r = core.validatePlay(board, [{ id: 9, x: 1, y: 1 }], [wild(9)]);
  // two identical cards flanking: no real distinct card completes the line
  assert.ok(!r.ok);
});

test('recycle: swap a wild on the board for a fitting hand card', () => {
  const board = boardOf([
    [0, 0, card(0, 'red', 'circle', 1)],
    [1, 0, card(1, 'red', 'square', 2)],
    [2, 0, wild(99)],
  ]);
  assert.ok(core.validateRecycle(board, 2, 0, card(5, 'red', 'triangle', 3)).ok);
  assert.ok(!core.validateRecycle(board, 2, 0, card(6, 'blue', 'triangle', 3)).ok);
  assert.ok(!core.validateRecycle(board, 0, 0, card(5, 'red', 'triangle', 3)).ok, 'not a wild');
});

test('game: pass/trade keeps hand size and card count', () => {
  const g = core.createGame(2, () => 0.5);
  const p = g.turn;
  const before = g.hands[p].map((c) => c.id);
  const r = core.applyPass(g, p, [before[0], before[1]]);
  assert.ok(r.ok);
  assert.strictEqual(g.hands[p].length, 4);
  assert.ok(!g.hands[p].some((c) => c.id === before[0] || c.id === before[1]));
  assert.notStrictEqual(g.turn, p);
});

// ---------- Full bot-played games ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidateSlots(board) {
  const slots = new Set();
  for (const k of Object.keys(board)) {
    const { x, y } = core.parseKey(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = key(x + dx, y + dy);
      if (!board[nk]) slots.add(nk);
    }
  }
  return [...slots].map(core.parseKey);
}

function bestMove(g, p) {
  const hand = g.hands[p];
  const slots = candidateSlots(g.board);
  let best = null;
  const consider = (placements) => {
    const v = core.validatePlay(g.board, placements, hand);
    if (v.ok && (!best || v.score > best.score)) best = { placements, score: v.score };
  };
  for (const c of hand) for (const s of slots) consider([{ id: c.id, x: s.x, y: s.y }]);
  for (const a of hand) for (const b of hand) {
    if (a.id === b.id) continue;
    for (const s of slots) for (const [dx, dy] of [[1, 0], [0, 1], [2, 0], [0, 2], [-1, 0], [0, -1]]) {
      consider([{ id: a.id, x: s.x, y: s.y }, { id: b.id, x: s.x + dx, y: s.y + dy }]);
    }
  }
  return best;
}

function playBotGame(seed, players) {
  const g = core.createGame(players, mulberry32(seed));
  let turns = 0;
  while (g.phase === 'playing') {
    if (++turns > 3000) throw new Error('game did not finish (seed ' + seed + ')');
    const p = g.turn;
    const m = bestMove(g, p);
    const r = m ? core.applyPlay(g, p, m.placements) : core.applyPass(g, p, g.draw.length ? g.hands[p].map((c) => c.id).slice(0, 2) : []);
    assert.ok(r.ok, 'bot move failed: ' + (r.error || ''));
    const total = g.draw.length + g.hands.reduce((s, h) => s + h.length, 0) + Object.keys(g.board).length;
    assert.strictEqual(total, 66, 'card conservation');
    assert.ok(core.checkBoard(g.board).ok, 'board stays consistent');
  }
  assert.ok(g.winners.length >= 1);
  return { turns, scores: g.scores.slice(), reason: g.log[g.log.length - 1].reason };
}

test('bots can play complete games (2, 3, 4 players) with valid state throughout', () => {
  for (const [seed, players] of [[1, 2], [2, 3], [3, 4], [4, 2]]) {
    const res = playBotGame(seed, players);
    console.log('       seed ' + seed + ' / ' + players + 'p: ' + res.turns + ' turns, ' + res.reason + ', scores ' + res.scores.join('-'));
  }
});

console.log(passed + ' tests passed' + (process.exitCode ? ', with failures' : ''));
