(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IotaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHAPES = ['circle', 'square', 'triangle', 'cross'];
  const COLORS = ['red', 'blue', 'green', 'yellow'];
  const NUMBERS = [1, 2, 3, 4];
  const HAND_SIZE = 4;
  const MAX_LINE = 4;

  const key = (x, y) => x + ',' + y;
  const parseKey = (k) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  };
  const err = (error) => ({ ok: false, error });

  function buildDeck() {
    const deck = [];
    let id = 0;
    for (const shape of SHAPES)
      for (const color of COLORS)
        for (const num of NUMBERS) deck.push({ id: id++, shape, color, num, wild: false });
    deck.push({ id: id++, wild: true });
    deck.push({ id: id++, wild: true });
    return deck;
  }

  const REAL_CARDS = buildDeck().filter((c) => !c.wild);

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // A line is valid when every property (shape, color, number) is all-same or all-different.
  function lineOk(cards) {
    const n = cards.length;
    if (n < 2) return true;
    if (n > MAX_LINE) return false;
    for (const prop of ['shape', 'color', 'num']) {
      const s = new Set(cards.map((c) => c[prop]));
      if (s.size !== 1 && s.size !== n) return false;
    }
    const distinct = new Set(cards.map((c) => c.shape + c.color + c.num));
    return distinct.size === n;
  }

  function runFrom(board, x, y, dx, dy) {
    const cells = [];
    while (board[key(x, y)]) {
      cells.push({ x, y, card: board[key(x, y)] });
      x += dx;
      y += dy;
    }
    return cells;
  }

  function runThrough(board, x, y, dx, dy) {
    while (board[key(x - dx, y - dy)]) {
      x -= dx;
      y -= dy;
    }
    return runFrom(board, x, y, dx, dy);
  }

  // All maximal runs of 2+ cards, horizontal and vertical.
  function allLines(board) {
    const lines = [];
    for (const k of Object.keys(board)) {
      const { x, y } = parseKey(k);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (board[key(x - dx, y - dy)]) continue; // not the start of a run
        const cells = runFrom(board, x, y, dx, dy);
        if (cells.length >= 2) lines.push({ dx, dy, cells });
      }
    }
    return lines;
  }

  // Is the whole board consistent? Wild cards may stand for any card, as long as
  // a single choice per wild satisfies every line it is part of.
  function checkBoard(board) {
    const lines = allLines(board);
    for (const l of lines) {
      if (l.cells.length > MAX_LINE) return { ok: false, reason: 'Lines can be at most 4 cards long.' };
    }
    const reason = 'Every line must be all the same or all different in color, shape and number.';
    const wildKeys = Object.keys(board).filter((k) => board[k].wild);
    const lineWilds = lines.map((l) => l.cells.filter((c) => c.card.wild).map((c) => key(c.x, c.y)));
    for (let i = 0; i < lines.length; i++) {
      if (lineWilds[i].length === 0 && !lineOk(lines[i].cells.map((c) => c.card))) return { ok: false, reason };
    }
    if (wildKeys.length === 0) return { ok: true };

    const assign = {};
    const resolve = (cell) => (cell.card.wild ? assign[key(cell.x, cell.y)] : cell.card);
    function search(d) {
      if (d === wildKeys.length) return true;
      const wk = wildKeys[d];
      for (const cand of REAL_CARDS) {
        assign[wk] = cand;
        let good = true;
        for (let i = 0; i < lines.length && good; i++) {
          const lw = lineWilds[i];
          if (!lw.includes(wk)) continue;
          if (lw.every((w) => w in assign)) good = lineOk(lines[i].cells.map(resolve));
        }
        if (good && search(d + 1)) return true;
      }
      delete assign[wk];
      return false;
    }
    return search(0) ? { ok: true } : { ok: false, reason };
  }

  const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // placements: [{id, x, y}] ; hand: array of card objects
  function validatePlay(board, placements, hand) {
    if (!Array.isArray(placements) || placements.length < 1) return err('Place at least one card.');
    if (placements.length > HAND_SIZE) return err('You can play at most 4 cards.');
    const handById = new Map(hand.map((c) => [c.id, c]));
    const usedIds = new Set();
    const usedCells = new Set();
    const cells = [];
    for (const p of placements) {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.id)) return err('Invalid move.');
      if (Math.abs(p.x) > 100 || Math.abs(p.y) > 100) return err('Invalid move.');
      const card = handById.get(p.id);
      if (!card) return err('That card is not in your hand.');
      if (usedIds.has(p.id)) return err('Invalid move.');
      const k = key(p.x, p.y);
      if (board[k] || usedCells.has(k)) return err('That space is already taken.');
      usedIds.add(p.id);
      usedCells.add(k);
      cells.push({ x: p.x, y: p.y, card });
    }

    const sameX = cells.every((c) => c.x === cells[0].x);
    const sameY = cells.every((c) => c.y === cells[0].y);
    if (!sameX && !sameY) return err('All cards must go in one straight row or column.');

    if (cells.length > 1) {
      const horizontal = sameY;
      const coords = cells.map((c) => (horizontal ? c.x : c.y));
      const min = Math.min(...coords);
      const max = Math.max(...coords);
      for (let v = min; v <= max; v++) {
        const x = horizontal ? v : cells[0].x;
        const y = horizontal ? cells[0].y : v;
        const k = key(x, y);
        if (!board[k] && !usedCells.has(k)) return err('A line cannot have gaps.');
      }
    }

    const touches = cells.some((c) => NEIGHBORS.some(([dx, dy]) => board[key(c.x + dx, c.y + dy)]));
    if (!touches) return err('At least one card must touch a card already in play.');

    const nb = Object.assign({}, board);
    for (const c of cells) nb[key(c.x, c.y)] = c.card;
    const chk = checkBoard(nb);
    if (!chk.ok) return err(chk.reason);

    // Scoring: every line created or extended this turn, each card counted once per line.
    const seen = new Set();
    const lines = [];
    let base = 0;
    let lots = 0;
    for (const c of cells) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const run = runThrough(nb, c.x, c.y, dx, dy);
        if (run.length < 2) continue;
        const id = dx + ':' + run[0].x + ',' + run[0].y;
        if (seen.has(id)) continue;
        seen.add(id);
        const value = run.reduce((s, r) => s + (r.card.wild ? 0 : r.card.num), 0);
        const lot = run.length === MAX_LINE;
        base += value;
        if (lot) lots++;
        lines.push({ cells: run.map((r) => ({ x: r.x, y: r.y })), value, lot });
      }
    }
    const allFour = cells.length === HAND_SIZE;
    const multiplier = Math.pow(2, lots) * (allFour ? 2 : 1);
    return { ok: true, board: nb, cells, lines, lots, allFour, base, multiplier, score: base * multiplier };
  }

  // Swap a wild card on the board for a regular card from your hand.
  function validateRecycle(board, x, y, card) {
    const cur = board[key(x, y)];
    if (!cur || !cur.wild) return err('That is not a wild card.');
    if (!card || card.wild) return err('Pick a regular card from your hand.');
    const nb = Object.assign({}, board);
    nb[key(x, y)] = card;
    const chk = checkBoard(nb);
    if (!chk.ok) return err('That card does not fit where the wild card is.');
    return { ok: true, board: nb };
  }

  // ---------- Game state ----------

  function createGame(playerCount, rng) {
    rng = rng || Math.random;
    const draw = shuffle(buildDeck(), rng);
    const hands = [];
    for (let i = 0; i < playerCount; i++) hands.push(draw.splice(0, HAND_SIZE));
    let starter = draw.shift();
    while (starter.wild) {
      draw.push(starter);
      starter = draw.shift();
    }
    const board = {};
    board[key(0, 0)] = starter;
    return {
      phase: 'playing',
      playerCount,
      board,
      draw,
      hands,
      scores: new Array(playerCount).fill(0),
      turn: Math.floor(rng() * playerCount),
      passesInRow: 0,
      log: [],
      lastPlay: null,
      winners: [],
    };
  }

  function finish(g, reason) {
    g.phase = 'finished';
    const max = Math.max(...g.scores);
    g.winners = g.scores.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
    g.log.push({ type: 'end', reason });
  }

  function checkTurn(g, p) {
    if (g.phase !== 'playing') return err('The game is over.');
    if (g.turn !== p) return err('It is not your turn.');
    return null;
  }

  function applyPlay(g, p, placements) {
    const bad = checkTurn(g, p);
    if (bad) return bad;
    const v = validatePlay(g.board, placements, g.hands[p]);
    if (!v.ok) return v;
    const ids = new Set(placements.map((pl) => pl.id));
    g.hands[p] = g.hands[p].filter((c) => !ids.has(c.id));
    g.board = v.board;
    while (g.hands[p].length < HAND_SIZE && g.draw.length) g.hands[p].push(g.draw.shift());
    // Pile is out and this player just played their last card: game ends, double points.
    const ending = g.hands[p].length === 0;
    const score = ending ? v.score * 2 : v.score;
    g.scores[p] += score;
    g.passesInRow = 0;
    g.lastPlay = { player: p, cells: v.cells.map((c) => ({ x: c.x, y: c.y })), score };
    g.log.push({ type: 'play', player: p, count: placements.length, score, lots: v.lots, allFour: v.allFour, final: ending });
    if (ending) finish(g, 'out');
    else g.turn = (p + 1) % g.playerCount;
    return { ok: true, score, ending };
  }

  function applyPass(g, p, tradeIds, opts) {
    const bad = checkTurn(g, p);
    if (bad) return bad;
    const hand = g.hands[p];
    const unique = [...new Set(Array.isArray(tradeIds) ? tradeIds : [])];
    if (unique.some((id) => !hand.some((c) => c.id === id))) return err('Invalid trade.');
    if (unique.length > g.draw.length) {
      return err(g.draw.length === 0 ? 'The draw pile is empty, so you can only pass.' : 'Only ' + g.draw.length + ' cards left in the draw pile.');
    }
    if (unique.length) {
      const out = hand.filter((c) => unique.includes(c.id));
      const keep = hand.filter((c) => !unique.includes(c.id));
      const incoming = g.draw.splice(0, out.length);
      g.hands[p] = keep.concat(incoming);
      g.draw.push(...out);
    }
    g.passesInRow++;
    g.log.push({ type: opts && opts.skip ? 'skip' : 'pass', player: p, traded: unique.length });
    if (g.draw.length === 0 && g.passesInRow >= g.playerCount) finish(g, 'stalemate');
    else g.turn = (p + 1) % g.playerCount;
    return { ok: true };
  }

  function applyRecycle(g, p, x, y, cardId) {
    const bad = checkTurn(g, p);
    if (bad) return bad;
    const card = g.hands[p].find((c) => c.id === cardId);
    const v = validateRecycle(g.board, x, y, card);
    if (!v.ok) return v;
    const wild = g.board[key(x, y)];
    g.board = v.board;
    g.hands[p] = g.hands[p].map((c) => (c.id === cardId ? wild : c));
    g.log.push({ type: 'recycle', player: p });
    return { ok: true };
  }

  return {
    SHAPES, COLORS, NUMBERS, HAND_SIZE, MAX_LINE,
    key, parseKey, buildDeck, shuffle, lineOk, checkBoard, allLines, runThrough,
    validatePlay, validateRecycle,
    createGame, applyPlay, applyPass, applyRecycle,
  };
});
