# Four — project notes for Claude Code

Online multiplayer version of the card game **Four** (2–4 players, room codes, real time).
Rulebook used: https://cdn.1j1ju.com/medias/0e/e4/7f-iota-rulebook.pdf

## Run
- `npm start` (or `node server.js`), then open http://localhost:3000. `PORT` env var supported.
- `npm test` runs the engine tests and a two-player online test against the real server.
- Zero npm dependencies on purpose (Node >= 18). The first sandbox this was built in could not install packages, so the server uses plain `http` + Server-Sent Events instead of WebSockets. Keep it dependency-free unless there is a real reason to change.

## Layout
- `public/game-core.js` — the rules engine, shared by server and browser (UMD). Deck, line validation, scoring, wild cards, pass/trade, wild swap, game state functions. The client imports it only for live move preview and hints; the server is authoritative.
- `server.js` — rooms, lobby, SSE state broadcast, actions. In-memory only.
- `bot.js` — computer opponent (server-side). Enumerates every legal play (ordered card sequences along rows/cols, cheap pre-filters, then the real `validatePlay`) and picks by level: easy = any legal move, normal = one of the better 25%, hard = best score (holds wilds back). If nothing is playable it trades its non-wild cards.
- `public/index.html`, `style.css`, `app.js` — vanilla JS client (home, lobby, game, rules dialog). Mobile first.
- `public/logo.svg` (wordmark), `icon.svg`/`favicon.svg` (app tile), `icon-192/512.png`, `apple-touch-icon.png` (rendered from icon.svg), `manifest.webmanifest` (installable PWA).
- `test/core.test.js`, `test/bot.test.js`, `test/online.test.js`.

## Look & feel
Bauhaus: warm paper background (`--paper #efece6`), ink-navy text, flat primary colors (navy `#20476f`, red `#e8445a`, yellow `#f5c84f`, green `#6dbf50`), pill/rounded shapes, bold rounded sans. Card shape colors live in `FILL`/`DARK` in `app.js`. Dark mode: all colors are CSS variables on `:root`; the dark set applies under `prefers-color-scheme: dark` unless `html[data-theme="light"]`, or always with `data-theme="dark"`. A ☾/☀ button (`.themeBtn`, saved as `four-theme` in localStorage, applied by an inline script in `<head>` before first paint) overrides the system setting. In dark mode the logo sits on a paper tile so the navy F stays visible; cards keep their cream faces. The F-o-U-R logo is the user's own design, redrawn as vector in `logo.svg`; if you change it, re-render the PNG icons from `icon.svg`.

## Protocol
- `POST /api/create {name}` and `POST /api/join {code,name}` return `{ok, code, token}`.
- `GET /api/events?code=&token=` is an SSE stream; each `state` event is a personalized view (you only see your own hand).
- `POST /api/act {code, token, t, ...}` with `t` in: `start`, `play {placements:[{id,x,y}]}`, `pass {tradeIds}`, `recycle {x,y,cardId}`, `skip`, `restart`, `rematch`, `addBot {level}`, `removeBot {index}`, `leave`.
- `POST /api/create {name, bots, level}`: if `bots` is an integer 0–3 the room starts at once with that many computer players (0 = solo, one player, no opponents). Levels: `easy|normal|hard`.
- Computer players are server-side players with `bot:true` (always 'connected'). They move 0.8–1.5 s after their turn starts, and only while a human is connected.
- A player's token (saved in localStorage) lets them reconnect after a refresh or dropped connection.

## Rules as implemented
- 64 cards (4 shapes x 4 colors x 4 numbers) + 2 wild cards. Hand size 4. Starter card at (0,0) is never a wild.
- Play 1–4 cards in one row or column, no gaps (existing cards may fill the gaps), at least one card touching the grid. Every resulting line (max length 4) must be all-same or all-different in color, shape and number.
- Score = sum of card numbers over every line created or extended this turn (a card in two lines counts twice, wild = 0), x2 per lot (line of 4), x2 for playing 4 cards. Game ends when the pile is empty and a player plays their last card (that turn x2).
- Wilds are not named; the board only has to be satisfiable with one consistent choice per wild. A wild on the board can be swapped for a fitting card from your hand (free action on your turn, before playing).
- Pass/trade: new cards are drawn from the top first, then the traded cards go to the bottom. Cannot trade more cards than remain in the pile.
- House rule (not in the rulebook): if the pile is empty and every player passes in a row, the game ends. Also, anyone can skip a disconnected player's turn.

## Status
- Verified: engine tests (rule cases and bot-played full games for 2/3/4 players with card-conservation and board-consistency checks), online test (lobby, privacy of hands, turn enforcement, play, trade, disconnect/reconnect, full game, restart).
- UI driven with Playwright (two 390px phone clients): home, lobby, tap-to-place, hints, Play button score, trade/pass, reload mid-game (reconnects), full game to the game-over overlay. Fixed: reloading the page used to wipe the saved session (SSE error on unload was treated as 'room gone'); now `/api/state-check` confirms before forgetting it.
- Board zoom: pinch (touch), ctrl+wheel (trackpad), +/− buttons and a 'fit whole board' button; zoom is a CSS var `--z` on `#board`. Tested with a CDP two-finger pinch on a 390px viewport.
- Computer players: bot-vs-bot games (2/3/4 seats, all levels) checked move-by-move against the engine; online tests cover add/remove, auto turns, solo and vs-computer rooms; browser test covers home options, lobby add/remove, a game vs 2 computers, solo.
- Still NOT exercised in a browser: wild-card swap, desktop/tablet widths, 3-4 player layout (scoreboard wrapping).

## Ideas / next steps
- Test and polish the UI (animations, sounds, nicer card art), then deploy (see README).
- Optional: smarter bot (wild swaps, look-ahead), persistence across server restarts, a spectator mode, chat/emotes.
