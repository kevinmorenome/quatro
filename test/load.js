'use strict';
// Manual load test (not part of `npm test`):  node test/load.js [rooms=100] [seconds=30] [bots=1]
// Starts the server as a child process, opens N rooms against the computer ("normal" level), each with a live
// connection, and a simulated player who passes after 1-2 s so the computer plays a real move every few seconds
// (much busier than real people). Prints server CPU use, memory, and how long a tiny request takes meanwhile.
const { spawn } = require('child_process');
const fs = require('fs');

const ROOMS = Number(process.argv[2]) || 100;
const SECONDS = Number(process.argv[3]) || 30;
const BOTS = Number(process.argv[4]) || 1;
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = 'http://127.0.0.1:' + PORT;

const server = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT, FOUR_DISABLE_LIMITS: '1' }), stdio: 'ignore' });
const cpuSeconds = () => {
  const f = fs.readFileSync('/proc/' + server.pid + '/stat', 'utf8').split(') ')[1].split(' ');
  return (Number(f[11]) + Number(f[12])) / 100; // utime + stime in clock ticks
};
const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + server.pid + '/status', 'utf8'))[1]) / 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

async function player(i, stop) {
  const { code, token } = await post('/api/create', { name: 'L' + i, bots: BOTS, level: 'normal' });
  const res = await fetch(base + '/api/events?code=' + code + '&token=' + token, { signal: stop.signal });
  const dec = new TextDecoder();
  let buf = '';
  let acting = false;
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const m = buf.slice(0, k).match(/^data: (.*)$/m);
        buf = buf.slice(k + 2);
        if (!m) continue;
        const st = JSON.parse(m[1]);
        if (st.phase === 'playing' && st.turn === st.you && !acting) {
          acting = true;
          setTimeout(async () => {
            acting = false;
            await post('/api/act', { code, token, t: 'pass', tradeIds: [] }).catch(() => {});
          }, 1000 + Math.random() * 1000);
        }
      }
    }
  } catch (e) {
    /* stopped */
  }
}

(async () => {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) break;
    } catch (e) {
      await sleep(100);
    }
  }
  const stop = new AbortController();
  for (let i = 0; i < ROOMS; i++) player(i, stop);
  await sleep(3000);
  const cpu0 = cpuSeconds();
  const lat = [];
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const s = process.hrtime.bigint();
    await fetch(base + '/healthz').then((r) => r.text());
    lat.push(Number(process.hrtime.bigint() - s) / 1e6);
    await sleep(50);
  }
  const used = cpuSeconds() - cpu0;
  lat.sort((a, b) => a - b);
  console.log('rooms=' + ROOMS + ' (each with ' + BOTS + ' computer player' + (BOTS > 1 ? 's' : '') + ') over ' + SECONDS + 's');
  console.log('  server CPU: ' + ((used / SECONDS) * 100).toFixed(1) + '% of one core');
  console.log('  server memory: ' + rssMb().toFixed(0) + ' MB');
  console.log('  /healthz latency: p50 ' + lat[Math.floor(lat.length * 0.5)].toFixed(1) + ' ms, p99 ' + lat[Math.floor(lat.length * 0.99)].toFixed(1) + ' ms, max ' + lat[lat.length - 1].toFixed(0) + ' ms');
  stop.abort();
  server.kill();
  process.exit(0);
})();
