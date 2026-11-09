'use strict';
// Worker thread entry: see botpool.js.
const { parentPort } = require('worker_threads');
const bot = require('./bot.js');

parentPort.on('message', ({ id, snap, p, level }) => {
  let move = null;
  try {
    move = bot.chooseMove(snap, p, level);
  } catch (e) {
    move = null;
  }
  parentPort.postMessage({ id, move });
});
