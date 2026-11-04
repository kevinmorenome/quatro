(() => {
  'use strict';
  // "How to play" wizard: illustrated steps, one small quiz, and a button to start a practice game.
  const { cardSVG, shapeSVG, FILL } = window.FourCards;

  const C = (color, shape, num) => ({ color, shape, num, wild: false });
  const WILD = { wild: true };
  const card = (c, cls) => '<div class="tc' + (cls ? ' ' + cls : '') + '">' + cardSVG(c) + '</div>';
  const cards = (list, cls) => '<div class="trow">' + list.map((c) => card(c, cls)).join('') + '</div>';
  const chip = (text, cls) => '<span class="tchip' + (cls ? ' ' + cls : '') + '">' + text + '</span>';

  // ----- Step content -----
  const quizOptions = [
    {
      id: 'A', cards: [C('red', 'triangle', 1), C('red', 'square', 2), C('blue', 'circle', 3)], ok: false,
      why: 'Colors are red, red, blue: two the same and one different. Not allowed. Each property must be all the same or all different.',
    },
    {
      id: 'B', cards: [C('red', 'triangle', 1), C('blue', 'square', 2), C('green', 'circle', 3)], ok: true,
      why: 'Correct! Colors are all different, shapes are all different, numbers are all different. Nothing is "two the same and one different".',
    },
    {
      id: 'C', cards: [C('red', 'circle', 2), C('blue', 'circle', 2), C('green', 'circle', 3)], ok: false,
      why: 'Shapes are all circles (fine) and colors are all different (fine), but the numbers are 2, 2, 3: two the same and one different.',
    },
  ];

  const steps = [
    {
      title: 'Welcome to Four',
      art: () => cards([C('red', 'circle', 1), C('blue', 'circle', 2), C('green', 'circle', 3), C('yellow', 'circle', 4)]),
      body: () => '<p>Four is a pattern game. You place cards on a shared grid to build <b>lines</b> where the cards either all <b>match</b> or are all <b>different</b>.</p><p>Longer lines and bigger numbers score more points. Highest score wins. This takes about 2 minutes to learn.</p>',
    },
    {
      title: 'The cards',
      art: () =>
        '<div class="tprops">' +
        '<div><span class="tl">4 colors</span>' + ['red', 'blue', 'green', 'yellow'].map((c) => '<i class="tdot" style="background:' + FILL[c] + '"></i>').join('') + '</div>' +
        '<div><span class="tl">4 shapes</span>' + ['circle', 'square', 'triangle', 'cross'].map((s) => shapeSVG(s, 'blue', 30)).join('') + '</div>' +
        '<div><span class="tl">4 numbers</span>' + [1, 2, 3, 4].map((n) => '<b class="tnum">' + n + '</b>').join('') + '</div>' +
        '</div>',
      body: () => '<p>Every card has a <b>color</b>, a <b>shape</b> and a <b>number</b> from 1 to 4. There are 64 different cards, plus 2 <b>wild</b> cards.</p><p>You always hold 4 cards in your hand.</p>',
    },
    {
      title: 'What is a line?',
      art: () =>
        cards([C('red', 'circle', 1), C('blue', 'circle', 2), C('green', 'circle', 3)]) +
        '<div class="tcheck">' +
        '<div><span>Color</span>' + chip('all different', 'ok') + '</div>' +
        '<div><span>Shape</span>' + chip('all the same', 'ok') + '</div>' +
        '<div><span>Number</span>' + chip('all different', 'ok') + '</div>' +
        '</div>',
      body: () => '<p>A line is 2 to 4 cards in a straight row or column. For <b>each</b> of color, shape and number, the cards must be <b>all the same</b> or <b>all different</b>.</p><p>The mix "two the same, one different" is never allowed.</p>',
    },
    {
      title: 'Quick quiz',
      art: () =>
        '<div class="tquiz">' +
        quizOptions.map((o) => '<button class="topt" data-q="' + o.id + '"><span class="tq">' + o.id + '</span>' + cards(o.cards) + '</button>').join('') +
        '</div>',
      body: () => '<p>Which of these three lines is valid?</p><p class="tfeed" id="tfeed">Tap a line.</p>',
      after: (root) => {
        root.querySelectorAll('.topt').forEach((btn) =>
          btn.addEventListener('click', () => {
            const o = quizOptions.find((x) => x.id === btn.dataset.q);
            root.querySelectorAll('.topt').forEach((b) => b.classList.remove('right', 'wrong'));
            btn.classList.add(o.ok ? 'right' : 'wrong');
            const feed = root.querySelector('#tfeed');
            feed.textContent = o.why;
            feed.className = 'tfeed ' + (o.ok ? 'good' : 'bad');
          }));
      },
    },
    {
      title: 'Your turn',
      art: () =>
        '<div class="tlabel">Board</div><div class="tboard">' +
        '<div class="tcell slot ok">+</div>' + card(C('red', 'circle', 1)) + card(C('blue', 'circle', 2)) + '<div class="tcell slot ok">+</div>' +
        '</div>' +
        '<div class="tlabel">Your hand: tap the green circle 3, then a green space</div><div class="thand">' + [C('green', 'circle', 3), C('yellow', 'square', 4), C('red', 'cross', 2), C('blue', 'triangle', 1)].map((c, i) => card(c, i === 0 ? 'sel' : '')).join('') + '</div>',
      body: () =>
        '<ol class="tsteps"><li><b>Tap a card</b> in your hand. Green spaces show where it fits.</li>' +
        '<li><b>Tap a space</b> on the board. Add up to 4 cards, all in the same row or column with no gaps.</li>' +
        '<li>At least one card must <b>touch</b> a card already on the board. Then press <b>Play</b>.</li></ol>' +
        '<p class="tnote">Here the green circle 3 fits: the colors and numbers are all different and the shapes are all the same.</p>',
    },
    {
      title: 'Scoring',
      art: () =>
        '<div class="tscore">' +
        '<div>' + cards([C('red', 'circle', 1), C('blue', 'circle', 2), C('green', 'circle', 3)]) + '<div class="teq">1 + 2 + 3 = <b>6</b></div></div>' +
        '<div>' + cards([C('red', 'square', 1), C('blue', 'square', 2), C('green', 'square', 3), C('yellow', 'square', 4)]) + '<div class="teq">1 + 2 + 3 + 4 = 10, line of 4 ×2 = <b>20</b></div></div>' +
        '</div>',
      body: () =>
        '<p>Add up the numbers of <b>every line</b> you make or extend this turn. A card sitting in two lines counts in both.</p>' +
        '<p><b>Lot:</b> a line of 4 doubles the turn. <b>Play all 4 cards</b> in one turn to double it again.</p>',
    },
    {
      title: 'Wild cards',
      art: () => cards([C('red', 'circle', 1), WILD, C('green', 'circle', 3)]) + '<div class="teq">The wild can stand for <b>blue circle 2</b></div>',
      body: () =>
        '<p>A wild card can be <b>any card</b> that keeps its lines valid, and it counts <b>0</b> points.</p>' +
        '<p>On your turn you can <b>swap a wild</b> on the board for a card from your hand that fits: tap the card, then tap the wild. The wild comes back to your hand to use later.</p>',
    },
    {
      title: 'Stuck? And the end',
      art: () =>
        '<div class="thand">' + [C('green', 'cross', 4), C('red', 'triangle', 4), C('yellow', 'circle', 3), C('blue', 'square', 1)].map((c, i) => card(c, i < 2 ? 'trade' : '')).join('') + '</div>' +
        '<div class="teq">Trade the 2 outlined cards for new ones</div>',
      body: () =>
        '<p>No good play? Press <b>Pass / trade</b>. Tap any cards you want to swap for new ones from the pile, then confirm. That ends your turn.</p>' +
        '<p><b>The game ends</b> when the draw pile is empty and someone plays their last card (that turn counts double). If the pile is empty and everyone passes, it ends too. Highest score wins!</p>',
    },
    {
      title: 'You are ready!',
      art: () => cards([C('red', 'cross', 4), C('blue', 'triangle', 3), C('green', 'square', 2), C('yellow', 'circle', 1)]),
      body: () =>
        '<p>The best way to learn is to play. Start a practice game against an <b>easy computer</b>, or just jump in.</p>' +
        '<p class="tnote">You can reopen this guide any time with the <b>?</b> button. <button class="link" data-act="fullRules">Read the full rules</button></p>',
      last: true,
    },
  ];

  // ----- Wizard -----
  let dlg, i = 0, opts = {};

  function build() {
    dlg = document.createElement('dialog');
    dlg.id = 'tutorial';
    dlg.innerHTML =
      '<div class="thead"><span id="tcount"></span><button class="link small" data-act="close">Skip</button></div>' +
      '<div class="tart" id="tart"></div>' +
      '<h2 id="ttitle"></h2><div class="tbody" id="tbody"></div>' +
      '<div class="tfoot"><div class="tdots" id="tdots"></div><div class="tbtns">' +
      '<button class="btn ghost" data-act="back">Back</button><button class="btn primary tnext" data-act="next">Next</button></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'next') go(i + 1);
      else if (a === 'back') go(i - 1);
      else if (a === 'close') close();
      else if (a === 'practice') { close(); if (opts.onPractice) opts.onPractice(); }
      else if (a === 'fullRules') { close(); if (opts.onFullRules) opts.onFullRules(); }
      else if (a === 'dot') go(Number(b.dataset.i));
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    });
  }

  function go(n) {
    i = Math.max(0, Math.min(steps.length - 1, n));
    const s = steps[i];
    dlg.querySelector('#tcount').textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    dlg.querySelector('#tart').innerHTML = s.art();
    dlg.querySelector('#ttitle').textContent = s.title;
    dlg.querySelector('#tbody').innerHTML = s.body();
    dlg.querySelector('#tdots').innerHTML = steps.map((_, k) => '<button class="tdotbtn' + (k === i ? ' on' : '') + '" data-act="dot" data-i="' + k + '" aria-label="Step ' + (k + 1) + '"></button>').join('');
    dlg.querySelector('[data-act=back]').style.visibility = i === 0 ? 'hidden' : 'visible';
    const next = dlg.querySelector('.tnext');
    if (s.last) {
      next.textContent = opts.noPractice ? 'Got it' : 'Practice game';
      next.dataset.act = opts.noPractice ? 'close' : 'practice';
    } else {
      next.textContent = i === 0 ? 'Start' : 'Next';
      next.dataset.act = 'next';
    }
    dlg.querySelector('[data-act=close]').textContent = s.last ? 'Close' : 'Skip';
    if (s.after) s.after(dlg);
    dlg.querySelector('.tbody').scrollTop = 0;
  }

  function open(options) {
    opts = options || {};
    try { localStorage.setItem('four-tutorial-seen', '1'); } catch (e) { /* ignore */ } // offered once; reopen via the buttons
    if (!dlg) build();
    go(0);
    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function close() {
    if (dlg.close) dlg.close();
    else dlg.removeAttribute('open');
  }

  const seen = () => { try { return localStorage.getItem('four-tutorial-seen') === '1'; } catch (e) { return true; } };
  window.FourTutorial = { open, seen };
})();
