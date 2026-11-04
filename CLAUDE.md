# Iota Online — project notes for Claude Code

Online multiplayer version of the card game **Iota** (2–4 players, room codes, real time).
Rulebook used: https://cdn.1j1ju.com/medias/0e/e4/7f-iota-rulebook.pdf

## Run
- `npm start` (or `node server.js`), then open http://localhost:3000. `PORT` env var supported.
- `npm test` runs the engine tests and a two-player online test against the real server.
- Zero npm dependencies on purpose (Node >= 18). The first sandbox this was built in could not install packages, so the server uses plain `http` + Server-Sent Events instead of WebSockets. Keep it dependency-free unless there is a real reason to change.

## Layout
- `public/game-core.js` — the rules engine, shared by server and browser (UMD). Deck, line validation, scoring, wild cards, pass/trade, wild swap, game state functions. The client imports it only for live move preview and hints; the server is authoritative.
- `server.js` — rooms, lobby, SSE state broadcast, actions. In-memory only.
- `public/index.html`, `style.css`, `app.js` — vanilla JS client (home, lobby, game, rules dialog). Mobile first.
- `test/core.test.js`, `test/online.test.js`.

## Protocol
- `POST /api/create {name}` and `POST /api/join {code,name}` return `{ok, code, token}`.
- `GET /api/events?code=&token=` is an SSE stream; each `state` event is a personalized view (you only see your own hand).
- `POST /api/act {code, token, t, ...}` with `t` in: `start`, `play {placements:[{id,x,y}]}`, `pass {tradeIds}`, `recycle {x,y,cardId}`, `skip`, `restart`, `leave`.
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
- NOT yet verified: the browser UI has only been syntax-checked, never run in a real browser. First job: run it with two browser windows (or Playwright) and fix whatever is off, especially layout on phone widths, tap-to-place flow, hints, wild swap, trade mode, reconnect after refresh, and the game-over overlay.

## Ideas / next steps
- Test and polish the UI (animations, sounds, nicer card art), then deploy (see README).
- Optional: bots to fill empty seats, persistence across server restarts, a spectator mode, chat/emotes.
