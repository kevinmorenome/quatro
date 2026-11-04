(() => {
  'use strict';
  const Core = window.IotaCore;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    session: null,
    es: null,
    st: null,
    selected: null,
    pending: new Map(), // cardId -> {x, y}
    trade: false,
    tradeSel: new Set(),
    hints: true,
    busy: false,
    lastPlaySig: '',
    needCenter: false,
  };

  // ---------- Card drawing ----------
  const FILL = { red: '#d93a2f', blue: '#2563d8', green: '#1f9d4c', yellow: '#f0b400' };
  const DARK = { red: '#8f1f17', blue: '#133c8f', green: '#0e6130', yellow: '#8a6500' };

  function shapeEl(shape) {
    switch (shape) {
      case 'circle': return '<circle cx="30" cy="31" r="15"/>';
      case 'square': return '<rect x="15" y="16" width="30" height="30" rx="3"/>';
      case 'triangle': return '<polygon points="30,14 46,47 14,47"/>';
      default: return '<path d="M25 15H35V26H46V36H35V47H25V36H14V26H25Z"/>';
    }
  }

  const WILD_SVG =
    '<svg viewBox="0 0 60 84" role="img" aria-label="wild card"><rect x="1.5" y="1.5" width="57" height="81" rx="7" fill="#fffaf0" stroke="#cfc6b0" stroke-width="1.5"/>' +
    '<g stroke-width="1.5" stroke-linejoin="round">' +
    '<circle cx="20" cy="24" r="8" fill="#d93a2f" stroke="#8f1f17"/>' +
    '<rect x="32" y="16" width="16" height="16" rx="2" fill="#2563d8" stroke="#133c8f"/>' +
    '<polygon points="20,40 28,56 12,56" fill="#1f9d4c" stroke="#0e6130"/>' +
    '<path d="M37 40H43V45H48V51H43V56H37V51H32V45H37Z" fill="#f0b400" stroke="#8a6500"/></g>' +
    '<text x="30" y="75" text-anchor="middle" font-size="13" font-weight="800" fill="#444" font-family="system-ui,sans-serif" letter-spacing="1">WILD</text></svg>';

  function cardSVG(card) {
    if (card.wild) return WILD_SVG;
    const f = FILL[card.color];
    const d = DARK[card.color];
    return (
      '<svg viewBox="0 0 60 84" role="img" aria-label="' + card.color + ' ' + card.shape + ' ' + card.num + '">' +
      '<rect x="1.5" y="1.5" width="57" height="81" rx="7" fill="#fffaf0" stroke="#cfc6b0" stroke-width="1.5"/>' +
      '<g fill="' + f + '" stroke="' + d + '" stroke-width="2" stroke-linejoin="round">' + shapeEl(card.shape) + '</g>' +
      '<text x="30" y="75" text-anchor="middle" font-size="22" font-weight="800" fill="' + d + '" font-family="system-ui,sans-serif">' + card.num + '</text></svg>'
    );
  }

  // ---------- Small helpers ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }
  const banner = (on) => $('banner').classList.toggle('hidden', !on);

  function show(name) {
    for (const id of ['home', 'lobby', 'game']) $(id).classList.toggle('hidden', id !== name);
    if (name !== 'game') $('overlay').classList.add('hidden');
  }

  function openRules() {
    const d = $('rules');
    if (d.showModal) d.showModal();
    else d.setAttribute('open', '');
  }

  async function api(path, body) {
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) {
      return { ok: false, error: 'Cannot reach the server.' };
    }
  }
  const act = (t, extra) => api('/api/act', Object.assign({ code: S.session.code, token: S.session.token, t }, extra));

  function saveSession(s) {
    S.session = s;
    try { localStorage.setItem('iota-session', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  function resetTurnUI() {
    S.selected = null;
    S.pending.clear();
    S.trade = false;
    S.tradeSel.clear();
  }

  function endSession(msg) {
    if (S.es) S.es.close();
    S.es = null;
    S.session = null;
    S.st = null;
    resetTurnUI();
    try { localStorage.removeItem('iota-session'); } catch (e) { /* ignore */ }
    history.replaceState(null, '', location.pathname);
    document.title = 'Iota';
    banner(false);
    show('home');
    $('herr').textContent = msg || '';
  }

  // ---------- Connection ----------
  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/events?code=' + encodeURIComponent(S.session.code) + '&token=' + encodeURIComponent(S.session.token));
    S.es = es;
    es.addEventListener('state', (e) => {
      banner(false);
      onState(JSON.parse(e.data));
    });
    es.onerror = async () => {
      if (S.unloading || S.es !== es) return; // page is closing/reloading, or a newer stream replaced this one
      if (es.readyState !== 2) return banner(true);
      // The browser gave up on the stream. Only forget the session if the server says it's gone;
      // otherwise (server restarting, flaky network) keep it and retry.
      banner(true);
      let gone = false;
      try {
        const r = await fetch('/api/state-check?code=' + encodeURIComponent(S.session.code) + '&token=' + encodeURIComponent(S.session.token));
        gone = r.status === 404;
      } catch (e) { /* offline: keep session */ }
      if (S.es !== es) return;
      if (gone) endSession('That game is no longer available.');
      else setTimeout(() => { if (S.session && S.es === es) connect(); }, 2000);
    };
  }

  async function enter(res) {
    if (!res.ok) {
      $('herr').textContent = res.error || 'Something went wrong.';
      return;
    }
    $('herr').textContent = '';
    saveSession({ code: res.code, token: res.token });
    history.replaceState(null, '', '?room=' + res.code);
    connect();
  }

  // ---------- State handling ----------
  const myTurn = (st) => st.phase === 'playing' && st.turn === st.you;
  const boardObj = (st) => {
    const b = {};
    for (const c of st.board) b[Core.key(c.x, c.y)] = c.card;
    return b;
  };

  function onState(st) {
    const prev = S.st;
    S.st = st;
    if (st.phase === 'lobby') {
      resetTurnUI();
      show('lobby');
      renderLobby();
      document.title = 'Iota';
      return;
    }
    const wasLobby = !prev || prev.phase === 'lobby';
    show('game');
    if (!myTurn(st)) resetTurnUI();
    const handIds = new Set(st.hand.map((c) => c.id));
    const occupied = new Set(st.board.map((c) => Core.key(c.x, c.y)));
    for (const [id, pos] of [...S.pending]) if (!handIds.has(id) || occupied.has(Core.key(pos.x, pos.y))) S.pending.delete(id);
    if (S.selected !== null && !handIds.has(S.selected)) S.selected = null;
    for (const id of [...S.tradeSel]) if (!handIds.has(id)) S.tradeSel.delete(id);
    if (wasLobby) S.needCenter = true;
    renderGame();
    document.title = myTurn(st) ? '▶ Your turn · Iota' : 'Iota';

    const sig = st.lastPlay ? JSON.stringify(st.lastPlay) : '';
    if (sig && sig !== S.lastPlaySig && !wasLobby) {
      const el = document.querySelector('.cell.last');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    S.lastPlaySig = sig;
  }

  // ---------- Rendering ----------
  function renderLobby() {
    const st = S.st;
    $('lcode').textContent = st.code;
    $('llink').value = location.origin + '/?room=' + st.code;
    $('lplayers').innerHTML = st.players
      .map((p, i) =>
        '<li class="' + (p.connected ? '' : 'away') + '"><span class="dot"></span><span>' + esc(p.name) + '</span>' +
        (i === st.you ? ' <em class="muted">(you)</em>' : '') + (i === st.host ? ' <span class="badge">host</span>' : '') + '</li>')
      .join('');
    const isHost = st.you === st.host;
    $('startBtn').classList.toggle('hidden', !isHost);
    $('startBtn').disabled = st.players.length < 2;
    $('lwait').textContent = isHost
      ? st.players.length < 2 ? 'Share the code or link. Waiting for at least one more player…' : 'Everyone in? Start when ready.'
      : 'Waiting for ' + st.players[st.host].name + ' to start…';
    $('copyBtn').textContent = navigator.share ? 'Share' : 'Copy';
  }

  function fmtLog(e, players) {
    if (!e) return '';
    const nm = (i) => (players[i] ? players[i].name : 'Someone');
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    switch (e.type) {
      case 'play': {
        const bits = [];
        if (e.lots) bits.push(e.lots > 1 ? e.lots + ' lots' : 'a lot');
        if (e.allFour) bits.push('all four');
        if (e.final) bits.push('game-ending ×2');
        return nm(e.player) + ' played ' + plural(e.count, 'card') + ' for ' + e.score + ' pts' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
      }
      case 'pass': return e.traded ? nm(e.player) + ' traded ' + plural(e.traded, 'card') : nm(e.player) + ' passed';
      case 'skip': return nm(e.player) + '’s turn was skipped';
      case 'recycle': return nm(e.player) + ' swapped a wild card into their hand';
      case 'end': return e.reason === 'stalemate' ? 'Nobody can move and the pile is empty.' : 'Game over!';
      default: return '';
    }
  }

  function renderGame() {
    const st = S.st;
    const mine = myTurn(st);
    document.body.classList.toggle('myturn', mine);

    $('scoreboard').innerHTML = st.players
      .map((p, i) =>
        '<div class="chip' + (st.phase === 'playing' && i === st.turn ? ' turn' : '') + (p.connected ? '' : ' away') + '">' +
        '<span class="dot"></span><span class="nm">' + esc(p.name) + (i === st.you ? ' (you)' : '') + '</span>' +
        '<span class="sc">' + p.score + '</span><small title="cards in hand">▯' + p.handCount + '</small></div>')
      .join('');

    $('turnText').textContent = st.phase === 'finished' ? 'Game over' : mine ? 'Your turn' : st.players[st.turn].name + '’s turn';
    $('lastEvent').textContent = fmtLog(st.log[st.log.length - 1], st.players);
    $('pile').textContent = st.drawCount === 0
      ? 'Draw pile empty – playing your last card ends the game (×2)'
      : 'Draw pile: ' + st.drawCount;

    renderBoard();
    renderHand();
    renderActions();
    renderOverlay();
    if (S.needCenter) {
      S.needCenter = false;
      const w = $('boardWrap');
      w.scrollLeft = (w.scrollWidth - w.clientWidth) / 2;
      w.scrollTop = (w.scrollHeight - w.clientHeight) / 2;
    }
  }

  function renderBoard() {
    const st = S.st;
    const mine = myTurn(st);
    const handById = new Map(st.hand.map((c) => [c.id, c]));
    const cells = new Map();
    for (const c of st.board) cells.set(Core.key(c.x, c.y), { card: c.card, x: c.x, y: c.y });
    for (const [id, pos] of S.pending) cells.set(Core.key(pos.x, pos.y), { card: handById.get(id), x: pos.x, y: pos.y, pending: true, id });

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of cells.values()) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
    minX--; maxX++; minY--; maxY++;

    const last = new Set(((st.lastPlay && st.lastPlay.cells) || []).map((c) => Core.key(c.x, c.y)));
    const near = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cells.has(Core.key(x + dx, y + dy)));

    let hintOk = new Set();
    if (S.hints && mine && !S.trade && S.selected !== null) {
      const bo = boardObj(st);
      const base = [...S.pending].map(([id, p]) => ({ id, x: p.x, y: p.y }));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const k = Core.key(x, y);
          if (cells.has(k) || !near(x, y)) continue;
          if (Core.validatePlay(bo, base.concat([{ id: S.selected, x, y }]), st.hand).ok) hintOk.add(k);
        }
      }
    }

    let html = '';
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const k = Core.key(x, y);
        const c = cells.get(k);
        if (c) {
          const cls = 'cell card' + (c.pending ? ' pending' : '') + (last.has(k) ? ' last' : '') + (c.card.wild && !c.pending && mine ? ' swappable' : '');
          html += '<div class="' + cls + '" data-x="' + x + '" data-y="' + y + '"' + (c.pending ? ' data-id="' + c.id + '"' : '') + '>' + cardSVG(c.card) + '</div>';
        } else {
          html += '<div class="cell slot' + (near(x, y) ? ' near' : '') + (hintOk.has(k) ? ' ok' : '') + '" data-x="' + x + '" data-y="' + y + '"></div>';
        }
      }
    }
    const board = $('board');
    board.style.gridTemplateColumns = 'repeat(' + (maxX - minX + 1) + ', var(--cw))';
    board.style.gridTemplateRows = 'repeat(' + (maxY - minY + 1) + ', var(--ch))';
    board.innerHTML = html;
  }

  function renderHand() {
    const st = S.st;
    const mine = myTurn(st);
    $('hand').innerHTML = st.hand
      .filter((c) => !S.pending.has(c.id))
      .map((c) => {
        const cls = 'hc card' + (S.selected === c.id ? ' sel' : '') + (S.tradeSel.has(c.id) ? ' trade' : '') + (mine ? '' : ' idle');
        return '<button class="' + cls + '" data-id="' + c.id + '" aria-label="card">' + cardSVG(c) + '</button>';
      })
      .join('');
  }

  function pendingPlacements() {
    return [...S.pending].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  }

  function renderActions() {
    const st = S.st;
    const mine = myTurn(st);
    const msg = $('msg');
    const box = $('actions');
    msg.className = '';
    let html = '';
    let text = '';

    if (st.phase === 'finished') {
      text = '';
    } else if (!mine) {
      const cur = st.players[st.turn];
      if (!cur.connected) {
        text = cur.name + ' seems to be offline.';
        html = '<button class="btn" data-act="skip">Skip their turn</button>';
      } else {
        text = 'Waiting for ' + cur.name + '…';
      }
    } else if (S.trade) {
      const n = S.tradeSel.size;
      text = st.drawCount === 0 ? 'The draw pile is empty, so you can only pass.' : 'Tap the cards you want to swap for new ones.';
      html =
        '<button class="btn primary" data-act="confirmPass">' + (n ? 'Trade ' + n + ' & pass' : 'Pass') + '</button>' +
        '<button class="btn ghost" data-act="cancelTrade">Cancel</button>';
    } else {
      let canPlay = false;
      let label = 'Play';
      if (S.pending.size) {
        const v = Core.validatePlay(boardObj(st), pendingPlacements(), st.hand);
        if (v.ok) {
          canPlay = true;
          label = 'Play +' + v.score;
          const bits = [];
          if (v.lots) bits.push(v.lots > 1 ? v.lots + ' lots ×' + Math.pow(2, v.lots) : 'lot ×2');
          if (v.allFour) bits.push('all four ×2');
          text = v.score + ' points' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
          msg.className = 'good';
        } else {
          text = v.error;
          msg.className = 'bad';
        }
      } else if (S.selected !== null) {
        text = st.board.some((c) => c.card.wild) ? 'Tap a space to place it, or tap a wild card to swap it into your hand.' : 'Tap a space on the board to place it.';
      } else {
        text = 'Your turn: pick a card, then tap a space on the board.';
      }
      html =
        '<button class="btn primary" data-act="play"' + (canPlay ? '' : ' disabled') + '>' + label + '</button>' +
        (S.pending.size ? '<button class="btn" data-act="clear">Clear</button>' : '') +
        '<button class="btn ghost" data-act="trade">Pass / trade</button>';
    }
    msg.textContent = text;
    box.innerHTML = html;
  }

  function renderOverlay() {
    const st = S.st;
    const ov = $('overlay');
    if (st.phase !== 'finished') return ov.classList.add('hidden');
    const order = st.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score);
    const tie = st.winners.length > 1;
    const title = tie ? 'It’s a tie!' : esc(st.players[st.winners[0]].name) + ' wins!';
    const canRestart = st.you === st.host || !st.players[st.host].connected;
    $('overlayBody').innerHTML =
      '<h2>' + title + '</h2><ul class="rank">' +
      order.map(({ p, i }) => '<li class="' + (st.winners.includes(i) ? 'win' : '') + '"><span>' + esc(p.name) + (i === st.you ? ' (you)' : '') + '</span><b>' + p.score + '</b></li>').join('') +
      '</ul>' +
      (canRestart ? '<button class="btn primary" data-act="restart">Back to lobby</button>' : '<p class="muted" style="text-align:center">Waiting for the host to start another game…</p>') +
      '<button class="btn ghost" data-act="leave">Leave</button>';
    ov.classList.remove('hidden');
  }

  // ---------- Actions ----------
  async function run(fn) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); } finally { S.busy = false; }
  }

  async function doAction(name) {
    const st = S.st;
    if (name === 'clear') { S.pending.clear(); return renderGame(); }
    if (name === 'trade') { S.pending.clear(); S.selected = null; S.trade = true; return renderGame(); }
    if (name === 'cancelTrade') { S.trade = false; S.tradeSel.clear(); return renderGame(); }
    await run(async () => {
      let r;
      if (name === 'play') {
        r = await act('play', { placements: pendingPlacements() });
        if (r.ok) S.pending.clear();
      } else if (name === 'confirmPass') {
        r = await act('pass', { tradeIds: [...S.tradeSel] });
        if (r.ok) { S.trade = false; S.tradeSel.clear(); }
      } else if (name === 'skip') r = await act('skip');
      else if (name === 'restart') r = await act('restart');
      else if (name === 'leave') {
        await act('leave');
        return endSession('');
      }
      if (r && !r.ok) toast(r.error);
      if (S.st === st) renderGame();
    });
  }

  async function swapWild(x, y) {
    const st = S.st;
    const card = st.hand.find((c) => c.id === S.selected);
    const v = Core.validateRecycle(boardObj(st), x, y, card);
    if (!v.ok) return toast(v.error);
    await run(async () => {
      const r = await act('recycle', { x, y, cardId: S.selected });
      if (!r.ok) toast(r.error);
      else S.selected = null;
    });
  }

  // ---------- Events ----------
  $('board').addEventListener('click', (e) => {
    const el = e.target.closest('.cell');
    const st = S.st;
    if (!el || !st || !myTurn(st)) return;
    const x = Number(el.dataset.x);
    const y = Number(el.dataset.y);
    if (el.classList.contains('pending')) {
      S.pending.delete(Number(el.dataset.id));
      return renderGame();
    }
    if (el.classList.contains('slot')) {
      if (S.trade) return;
      if (S.selected === null) return toast('Pick a card from your hand first.');
      S.pending.set(S.selected, { x, y });
      S.selected = null;
      return renderGame();
    }
    const placed = boardObj(st)[Core.key(x, y)];
    if (placed && placed.wild && !S.trade) {
      if (S.selected !== null) swapWild(x, y);
      else toast('Select a card from your hand, then tap this wild card to swap it in.');
    }
  });

  $('hand').addEventListener('click', (e) => {
    const el = e.target.closest('.hc');
    const st = S.st;
    if (!el || !st || !myTurn(st)) return;
    const id = Number(el.dataset.id);
    if (S.trade) {
      if (S.tradeSel.has(id)) S.tradeSel.delete(id);
      else S.tradeSel.add(id);
    } else S.selected = S.selected === id ? null : id;
    renderGame();
  });

  $('actions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b && !b.disabled) doAction(b.dataset.act);
  });
  $('overlayBody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) doAction(b.dataset.act);
  });

  $('hintBox').addEventListener('change', (e) => {
    S.hints = e.target.checked;
    try { localStorage.setItem('iota-hints', S.hints ? '1' : '0'); } catch (err) { /* ignore */ }
    if (S.st && S.st.phase !== 'lobby') renderGame();
  });
  $('helpBtn').addEventListener('click', openRules);
  $('homeRules').addEventListener('click', openRules);
  $('lobbyRules').addEventListener('click', openRules);

  const playerName = () => $('name').value.trim();
  $('name').addEventListener('input', () => { try { localStorage.setItem('iota-name', $('name').value); } catch (e) { /* ignore */ } });
  $('createBtn').addEventListener('click', () => run(async () => enter(await api('/api/create', { name: playerName() }))));
  $('joinBtn').addEventListener('click', () => run(async () => {
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('herr').textContent = 'Enter the 4-letter room code.');
    enter(await api('/api/join', { code, name: playerName() }));
  }));
  $('code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value ? $('joinBtn') : $('createBtn')).click(); });

  $('startBtn').addEventListener('click', () => run(async () => {
    const r = await act('start');
    if (!r.ok) toast(r.error);
  }));
  $('leaveLobby').addEventListener('click', () => run(async () => { await act('leave'); endSession(''); }));
  $('leaveGame').addEventListener('click', () => {
    if (confirm('Leave this game? You can rejoin from this device until the room closes.')) {
      if (S.es) S.es.close();
      endSession('');
    }
  });
  $('copyBtn').addEventListener('click', async () => {
    const link = $('llink').value;
    if (navigator.share) {
      try { await navigator.share({ title: 'Iota', text: 'Join my Iota game!', url: link }); return; } catch (e) { /* cancelled */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch (e) {
      $('llink').select();
      document.execCommand && document.execCommand('copy');
      toast('Invite link copied');
    }
  });

  window.addEventListener('pagehide', () => { S.unloading = true; });
  window.addEventListener('beforeunload', () => { S.unloading = true; });

  // ---------- Boot ----------
  try {
    $('name').value = localStorage.getItem('iota-name') || '';
    S.hints = localStorage.getItem('iota-hints') !== '0';
  } catch (e) { /* ignore */ }
  $('hintBox').checked = S.hints;

  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('iota-session') || 'null'); } catch (e) { /* ignore */ }
  if (saved && saved.code && saved.token && (!urlRoom || urlRoom === saved.code)) {
    S.session = saved;
    show('game');
    connect();
  } else {
    if (urlRoom) $('code').value = urlRoom;
    show('home');
    if (urlRoom) $('name').focus();
  }
})();
