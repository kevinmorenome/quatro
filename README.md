# Iota Online

Play the card game Iota with friends in the browser. Create a room, share the 4-letter code or link, and play on separate devices. 2–4 players.

## Run it on your computer
Needs Node 18 or newer. No `npm install` required.

```
node server.js
```

Open http://localhost:3000. The terminal also prints your local network address, so friends on the same Wi-Fi can join from their phones.

## Put it online
Any host that runs a Node web service works, because the whole game is one `server.js` plus the `public/` folder. For example on Render or Railway:

1. This repository is ready to deploy (`render.yaml` included).
2. Create a new Web Service from that repo.
3. Build command: leave empty. Start command: `node server.js`.
4. Share the public URL it gives you.

Notes: rooms live in server memory, so a restart (or a free plan going to sleep) ends running games. The server must allow long-lived connections (Server-Sent Events); Render and Railway do.

## Tests
```
npm test
```
