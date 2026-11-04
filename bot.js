'use strict';
// Computer opponent: enumerates every legal play for a hand and picks one by difficulty.
// Server-side only. Uses the same rules engine as the humans, so every move it returns is legal.
const core = require('./public/game-core.js');

const { key, parseKey, validatePlay } = core;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// All ordered selections of 1..4 cards from the hand.
function sequences(hand) {
  const out = [];
  const rec = (seq, used) => {
    if (seq.length) out.push(seq.slice());
    if (seq.length === core.HAND_SIZE) return;
    for (let i = 0; i < hand.length; i++) {
      if (used & (1 << i)) continue;
      seq.push(hand[i]);
      rec(seq, used | (1 << i));
      seq.pop();
    }
  };
  rec([], 0);
  return out;
}

// Every legal play as {placements, score, cards}. A legal play's cards, sorted along their line,
// always occupy consecutive EMPTY cells (existing cards may sit between them), so walking
// forward from each empty start cell covers them all.
function enumerateMoves(game, p) {
  const board = game.board;
  const hand = game.hands[p];
  const pts = Object.keys(board).map(parseKey);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of pts) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  }
  const touches = (x, y) => NEIGHBORS.some(([dx, dy]) => board[key(x + dx, y + dy)]);
  const seqs = sequences(hand);
  const moves = [];

  // Cheap pre-filter: a card dropped in a cell also joins the line crossing the play direction,
  // and no other card of the same play can be in that crossing line. So its validity depends only
  // on (card, cell, direction). Cached; runs containing wilds are left to the full check.
  const crossCache = new Map();
  const crossOk = (card, x, y, horizontal) => {
    const ck = card.id + ':' + x + ',' + y + ':' + (horizontal ? 'h' : 'v');
    let r = crossCache.get(ck);
    if (r !== undefined) return r;
    const dx = horizontal ? 0 : 1;
    const dy = horizontal ? 1 : 0;
    const before = [];
    for (let cx = x - dx, cy = y - dy; board[key(cx, cy)]; cx -= dx, cy -= dy) before.unshift(board[key(cx, cy)]);
    const after = [];
    for (let cx = x + dx, cy = y + dy; board[key(cx, cy)]; cx += dx, cy += dy) after.push(board[key(cx, cy)]);
    const run = before.concat([card], after);
    if (run.length < 2 || run.some((c) => c.wild)) r = true;
    else r = run.length <= core.MAX_LINE && core.lineOk(run);
    crossCache.set(ck, r);
    return r;
  };

  // Cheap pre-filter for the line being played along (existing cards + the new ones, as one run).
  const mainOk = (seq, used, horizontal) => {
    const dx = horizontal ? 1 : 0;
    const dy = horizontal ? 0 : 1;
    const placed = new Map();
    seq.forEach((card, i) => placed.set(key(used[i].x, used[i].y), card));
    const at = (x, y) => placed.get(key(x, y)) || board[key(x, y)];
    let x = used[0].x, y = used[0].y;
    while (at(x - dx, y - dy)) { x -= dx; y -= dy; }
    const run = [];
    for (let c = at(x, y); c; x += dx, y += dy, c = at(x, y)) run.push(c);
    if (run.some((c) => c.wild)) return true;
    return run.length <= core.MAX_LINE && core.lineOk(run);
  };

  const tryLine = (horizontal, fixed) => {
    const lo = (horizontal ? minX : minY) - core.HAND_SIZE;
    const hi = (horizontal ? maxX : maxY) + core.HAND_SIZE;
    for (let start = lo; start <= hi; start++) {
      const at = (v) => (horizontal ? [v, fixed] : [fixed, v]);
      const [sx, sy] = at(start);
      if (board[key(sx, sy)]) continue;
      // next 4 empty cells from start
      const cells = [];
      for (let v = start; cells.length < core.HAND_SIZE && v <= hi + core.HAND_SIZE; v++) {
        const [x, y] = at(v);
        if (!board[key(x, y)]) cells.push({ x, y });
      }
      for (const seq of seqs) {
        if (seq.length > cells.length) continue;
        const used = cells.slice(0, seq.length);
        if (!used.some((c) => touches(c.x, c.y))) continue;
        if (!seq.every((card, i) => crossOk(card, used[i].x, used[i].y, horizontal))) continue;
        if (!mainOk(seq, used, horizontal)) continue;
        const placements = seq.map((card, i) => ({ id: card.id, x: used[i].x, y: used[i].y }));
        const v = validatePlay(board, placements, hand);
        if (v.ok) moves.push({ placements, score: v.score, wilds: seq.filter((c) => c.wild).length });
      }
    }
  };

  for (let y = minY - 1; y <= maxY + 1; y++) tryLine(true, y);
  for (let x = minX - 1; x <= maxX + 1; x++) tryLine(false, x);
  return moves;
}

// What to do when no card can be played: swap out the non-wild cards (keep wilds), or just pass.
function passMove(game, p) {
  const room = game.draw.length;
  const ids = game.hands[p].filter((c) => !c.wild).map((c) => c.id).slice(0, room);
  return { t: 'pass', tradeIds: ids };
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// level: 'easy' (any legal move), 'normal' (one of the better moves), 'hard' (best move).
function chooseMove(game, p, level, rng) {
  rng = rng || Math.random;
  const moves = enumerateMoves(game, p);
  if (!moves.length) return passMove(game, p);

  if (level === 'easy') {
    const m = pick(moves, rng);
    return { t: 'play', placements: m.placements };
  }

  // Wilds are valuable, so the stronger levels hold them back unless they clearly help.
  const value = (m) => m.score - m.wilds * 4 + m.placements.length * 0.01;
  moves.sort((a, b) => value(b) - value(a));

  if (level === 'normal') {
    const top = moves.slice(0, Math.max(3, Math.ceil(moves.length * 0.25)));
    return { t: 'play', placements: pick(top, rng).placements };
  }
  const best = value(moves[0]);
  const ties = moves.filter((m) => value(m) === best);
  return { t: 'play', placements: pick(ties, rng).placements };
}

module.exports = { chooseMove, enumerateMoves, LEVELS: ['easy', 'normal', 'hard'] };
