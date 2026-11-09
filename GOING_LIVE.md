# Going live with Four

Goal: put the game in front of paid traffic without a big server bill and without it falling over (or being used against you).

## What the server now defends against (built in, no setup)

| Threat | Protection |
|---|---|
| One person creating thousands of rooms to fill memory | 15 new rooms / 10 min and 6 open rooms per visitor, 500 rooms total; empty lobbies are deleted after 5 min, idle ones after 30 min, idle games after 2 h |
| Computer players used to burn CPU | Bot thinking runs in a separate worker thread (the rest of the game stays fast); 3 bot rooms per visitor, 100 in total, 8 new per 10 min |
| Guessing the 4-letter room codes | Every wrong code / bad token counts; after 20 in 10 min that visitor gets "429 too many requests". Real players are never affected |
| Action spam | 240 actions/min per visitor, 90/min per player; the server already validated every move |
| Opening thousands of live connections | 3 per player (oldest tab is closed), 30 per visitor, 4000 in total, slow readers are cut off |
| Slow-loris / giant headers or bodies | 15 s to send headers, 20 s for a request, 8 KB headers, 4 KB bodies, 5000-connection ceiling |
| Cross-site tricks | POST only accepts `application/json` from our own origin; strict Content-Security-Policy (only our scripts + the one theme snippet, by hash), no framing, no sniffing, HSTS behind HTTPS |
| Script injection through player names | Names were already escaped; control / invisible / right-to-left-override characters are now stripped too |
| One bad request crashing every game | Errors are caught and logged instead of killing the process |
| Bandwidth cost | Static files are cached in memory, gzip/brotli compressed and served with ETags (a whole page load is ~25 KB) |

Rate limits are per visitor address (IPv6 counts per /64). Tests: `npm test` (includes `test/security.test.js`).

## What it cannot defend against (do these)

1. **Big floods (real DDoS).** No app can absorb that on a small server. Put **Cloudflare (free plan)** in front: point your domain's DNS at it with the orange cloud on, SSL mode "Full (strict)". It absorbs floods, caches the static files so your server mostly only sees game traffic, and works with the live (SSE) connections. Turn on "Bot Fight Mode". Add one rate-limiting rule for `/api/` (e.g. 100 requests per 10 s per IP) if your plan offers it.
2. **A sleeping or tiny server.** Render's free plan sleeps and drops all running games; use the cheapest always-on plan (Render "Starter") or any small VPS. The server idles around 60-130 MB RAM, so the smallest paid instance is enough.
3. **Tell the server how many proxies are in front** (`TRUST_PROXY`), otherwise everyone looks like one visitor, or the limits can be dodged:
   - Render only: `TRUST_PROXY=1` (already set in `render.yaml`)
   - Cloudflare → Render: `TRUST_PROXY=2`
   - Verify after deploying: set `LOG_IPS=1`, create a game from your phone on mobile data, and read the log line `[ip] seen=… socket=… xff=…`. `seen` must be your phone's public address. Then remove `LOG_IPS`.
4. **Ad budget.** Set a daily spend cap in the ad platform. A clicking bot costs you money, not the game. Send ad traffic to the home page and watch for a spike of visits with no games created.

## Before turning on ads

- **Privacy policy page and consent.** Ad platforms require a privacy policy URL, and in the EU/UK the ad pixel or cookie needs a consent banner before it loads. The game itself stores no accounts or cookies (only a name, theme and seat token in the browser's local storage; rooms live in server memory). Have the policy reviewed; this is not legal advice.
- **Ad tags widen the attack surface.** Any ad or analytics script you add runs with full access to the page. The Content-Security-Policy blocks everything not listed, so allow only what you add, using env vars (space-separated hosts): `CSP_SCRIPT`, `CSP_IMG`, `CSP_CONNECT`, `CSP_FRAME`. Prefer a plain click-through ad campaign (ads live on the ad platform, visitors land on your site) over embedding ads inside the game.
- **Link tracking only.** Add `?utm_source=…` to ad links; the server ignores unknown query strings, so you can see which campaign brings real players without extra scripts.

## Watching it cheaply

The server prints one line every 5 minutes:

```
[stats] rooms=12 botRooms=5 streams=19 botQueue=0 rss=88MB loopP99=3ms limited=0
```

- `limited` = requests refused by the abuse limits in that period. A sudden big number means someone is probing; a steady small one near an office/school/campus means many real players share one address (raise the limits in `LIM` in `server.js`).
- `loopP99` above ~100 ms or `botQueue` above ~20 means the instance is too small.
- Add a free uptime monitor (UptimeRobot etc.) on `https://yourdomain/healthz`.

## Capacity (measured, `node test/load.js 100 30 1`)

On a 4-core test machine, 100 simultaneous games against a computer player, with a simulated person acting every 1-2 s (far busier than real people), used about 78% of one core and ~130 MB, and `/healthz` stayed under 3 ms at the 99th percentile. Real players think for 10+ seconds per turn, so a single small instance should carry several hundred concurrent games. Games between people cost almost nothing (no computer thinking), only a connection each.

## Known limits (accepted on purpose)

- Everything is in memory: a deploy or restart ends running games. Deploy when the stats line shows few rooms.
- The live-connection URL contains the player's seat token (browsers cannot send headers on `EventSource`). A token only controls one seat in a short-lived room, but do not enable request-URL logging on proxies you add.
- Rate limiting counts addresses, so a large botnet can still get through slowly; the global caps (rooms, bot rooms, connections) are what keep the server alive in that case. Players would then see "busy, try again" rather than a crash.
