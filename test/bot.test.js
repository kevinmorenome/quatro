'use strict';
const assert = require('assert');
const core = require('../public/game-core.js');
const bot = require('../bot.js');

function ok(name, fn) {
  fn();
  console.log('  ok  ' + name);
}

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Play a whole game with bots in every seat; every move goes through the real engine.
function playGame(levels, seed) {
  const rng = seededRng(seed);
  const g = core.createGame(levels.length, rng);
  const total = g.draw.length + g.hands.reduce((n, h) => n + h.length, 0) + Object.keys(g.board).length;
  let turns = 0;
  let slowest = 0;
  while (g.phase === 'playing') {
    assert(++turns < 400, 'game did not finish');
    const p = g.turn;
    const t0 = Date.now();
    const m = bot.chooseMove(g, p, levels[p], rng);
    slowest = Math.max(slowest, Date.now() - t0);
    const r = m.t === 'play' ? core.applyPlay(g, p, m.placements) : core.applyPass(g, p, m.tradeIds);
    assert(r.ok, 'bot made an illegal move: ' + (r.error || ''));
    assert(core.checkBoard(g.board).ok, 'board became inconsistent');
    const now = g.draw.length + g.hands.reduce((n, h) => n + h.length, 0) + Object.keys(g.board).length;
    assert.strictEqual(now, total, 'cards were lost or duplicated');
  }
  return { g, turns, slowest };
}

console.log('Four bot');

ok('bots only ever make legal moves (2, 3 and 4 players, mixed levels)', () => {
  for (let seed = 1; seed <= 3; seed++) {
    playGame(['hard', 'normal'], seed);
    playGame(['easy', 'normal', 'hard'], seed + 100);
    playGame(['hard', 'hard', 'easy', 'normal'], seed + 200);
  }
});

ok('a move is found quickly even on a big board (< 1.5 s)', () => {
  const { slowest } = playGame(['hard', 'hard'], 42);
  assert(slowest < 1500, 'slowest move took ' + slowest + ' ms');
});

ok('hard scores more than easy on average', () => {
  let hard = 0, easy = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { g } = playGame(['hard', 'easy'], 500 + seed);
    hard += g.scores[0];
    easy += g.scores[1];
  }
  assert(hard > easy, 'hard ' + hard + ' vs easy ' + easy);
});

ok('with no legal play the bot trades or passes instead of crashing', () => {
  const g = core.createGame(2, seededRng(7));
  g.board = { '0,0': { id: 900, shape: 'circle', color: 'red', num: 1, wild: false } };
  // every card here would break the all-same/all-different rule against that card as a pair? (pairs are always ok)
  // so force "no move" by emptying the hand: nothing to play, nothing to trade.
  g.hands[g.turn] = [];
  const m = bot.chooseMove(g, g.turn, 'hard');
  assert.strictEqual(m.t, 'pass');
  assert.deepStrictEqual(m.tradeIds, []);
});

console.log('bot tests passed');
