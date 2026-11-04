(() => {
  'use strict';
  // Card drawing, shared by the game (app.js) and the tutorial (tutorial.js).
  const FILL = { red: '#e8445a', blue: '#2a5aa8', green: '#5fb946', yellow: '#f2b705' };
  const DARK = { red: '#a3213a', blue: '#17356b', green: '#2e7d27', yellow: '#a87700' };

  function shapeEl(shape) {
    switch (shape) {
      case 'circle': return '<circle cx="30" cy="31" r="15"/>';
      case 'square': return '<rect x="15" y="16" width="30" height="30" rx="3"/>';
      case 'triangle': return '<polygon points="30,14 46,47 14,47"/>';
      default: return '<path d="M25 15H35V26H46V36H35V47H25V36H14V26H25Z"/>';
    }
  }

  const WILD_SVG =
    '<svg viewBox="0 0 60 84" role="img" aria-label="wild card"><rect x="1.5" y="1.5" width="57" height="81" rx="7" fill="#fffdf8" stroke="#d9d3c4" stroke-width="1.5"/>' +
    '<g stroke-width="1.5" stroke-linejoin="round">' +
    '<circle cx="20" cy="24" r="8" fill="#e8445a" stroke="#a3213a"/>' +
    '<rect x="32" y="16" width="16" height="16" rx="2" fill="#2a5aa8" stroke="#17356b"/>' +
    '<polygon points="20,40 28,56 12,56" fill="#5fb946" stroke="#2e7d27"/>' +
    '<path d="M37 40H43V45H48V51H43V56H37V51H32V45H37Z" fill="#f2b705" stroke="#a87700"/></g>' +
    '<text x="30" y="75" text-anchor="middle" font-size="13" font-weight="800" fill="#444" font-family="system-ui,sans-serif" letter-spacing="1">WILD</text></svg>';

  function cardSVG(card) {
    if (card.wild) return WILD_SVG;
    const f = FILL[card.color];
    const d = DARK[card.color];
    return (
      '<svg viewBox="0 0 60 84" role="img" aria-label="' + card.color + ' ' + card.shape + ' ' + card.num + '">' +
      '<rect x="1.5" y="1.5" width="57" height="81" rx="7" fill="#fffdf8" stroke="#d9d3c4" stroke-width="1.5"/>' +
      '<g fill="' + f + '" stroke="' + d + '" stroke-width="2" stroke-linejoin="round">' + shapeEl(card.shape) + '</g>' +
      '<text x="30" y="75" text-anchor="middle" font-size="22" font-weight="800" fill="' + d + '" font-family="system-ui,sans-serif">' + card.num + '</text></svg>'
    );
  }


  // A small standalone shape icon (used in the tutorial).
  function shapeSVG(shape, color, size) {
    return '<svg viewBox="0 0 60 60" width="' + size + '" height="' + size + '" aria-hidden="true"><g fill="' + FILL[color] + '" stroke="' + DARK[color] + '" stroke-width="2.5" stroke-linejoin="round">' + shapeEl(shape).replace(/ cy="31"/, ' cy="30"') + '</g></svg>';
  }

  window.FourCards = { FILL, DARK, cardSVG, shapeSVG };
})();
