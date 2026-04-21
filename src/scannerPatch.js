'use strict';

/**
 * Scanner Patch
 *
 * Monkey-patches scanner_v6.js so its output flows into the Telegram bot.
 *
 * Usage (at the top of scanner_v6.js or via the launcher):
 *   require('./src/scannerPatch');
 *
 * What this does:
 *   - Intercepts the `broadcastSignal` call point inside the scanner
 *   - Forwards each qualifying result to bot.js → broadcastSignal()
 *   - Handles bot not-started gracefully (queues and drains on connect)
 *
 * scanner_v6.js does NOT need to be modified if you use the launcher
 * (launcher.js) instead of running scanner_v6.js directly.
 */

const { adapt } = require('./scannerAdapter');

let botBroadcast = null;
const pendingQueue = [];

/**
 * Called once by launcher.js after the bot is initialised.
 * Drains any signals that arrived before the bot was ready.
 */
function attachBot(broadcastFn) {
  botBroadcast = broadcastFn;
  while (pendingQueue.length) {
    const r = pendingQueue.shift();
    broadcastFn(r).catch(e => console.error('[ScannerPatch] drain error:', e.message));
  }
}

/**
 * Forward a scanner result to the bot.
 * Called by the hooked scanner emit point.
 */
async function forwardSignal(result) {
  if (!result || !result.symbol) return;

  // Normalise scanner_v6.js raw output to bot's unified shape
  const normalised = adapt(result);
  if (!normalised) return;

  if (botBroadcast) {
    try {
      await botBroadcast(normalised);
    } catch (e) {
      console.error('[ScannerPatch] forward error:', e.message);
    }
  } else {
    pendingQueue.push(normalised);
    if (pendingQueue.length > 50) pendingQueue.shift();
  }
}

module.exports = { attachBot, forwardSignal };
