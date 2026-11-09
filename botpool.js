'use strict';
// Runs computer-player thinking in ONE worker thread so a slow move (up to ~1.3 s on a busy board)
// never blocks the main thread, which keeps every other game responsive. Built in, no dependencies.
// Jobs are queued; if the queue is too long or the worker hangs, the caller gets null and falls back to a pass.
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_QUEUE = 200;
const JOB_TIMEOUT_MS = 5000;

let worker = null;
let seq = 0;
const pending = new Map(); // id -> {resolve, timer}
let busy = 0;

function spawn() {
  worker = new Worker(path.join(__dirname, 'bot-worker.js'));
  worker.unref();
  worker.on('message', ({ id, move }) => {
    const j = pending.get(id);
    if (!j) return;
    pending.delete(id);
    clearTimeout(j.timer);
    j.resolve(move || null);
  });
  const reset = () => {
    const w = worker;
    worker = null;
    for (const [id, j] of pending) {
      clearTimeout(j.timer);
      j.resolve(null);
      pending.delete(id);
    }
    if (w) w.terminate().catch(() => {});
  };
  worker.on('error', reset);
  worker.on('exit', () => {
    if (worker) reset();
  });
}

// Only what the bot reads is sent: the board, its own hand and the pile size.
function snapshot(g, p) {
  return { board: g.board, hands: { [p]: g.hands[p] }, draw: { length: g.draw.length } };
}

function choose(g, p, level) {
  if (pending.size >= MAX_QUEUE) return Promise.resolve(null);
  if (!worker) spawn();
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
      // A hung worker would block the whole queue: replace it.
      const w = worker;
      worker = null;
      if (w) w.terminate().catch(() => {});
      for (const [i, j] of pending) {
        clearTimeout(j.timer);
        j.resolve(null);
        pending.delete(i);
      }
    }, JOB_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pending.set(id, { resolve, timer });
    worker.postMessage({ id, snap: snapshot(g, p), p, level });
  });
}

const queued = () => pending.size;
module.exports = { choose, queued };
