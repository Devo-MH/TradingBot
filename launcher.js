'use strict';

/**
 * Launcher
 *
 * Single entry point that starts both the Telegram bot and the scanner
 * in the same process, wired together so every scanner signal is
 * automatically broadcast to eligible users.
 *
 * Usage:
 *   node launcher.js
 *
 * Environment variables required (set in .env or shell):
 *   BOT_TOKEN        — Telegram bot token from @BotFather
 *   BINANCE_API_KEY  — Binance API key (read-only is fine)
 *   BINANCE_SECRET   — Binance API secret
 *
 * To run bot only (no scanner):
 *   node bot.js
 *
 * To run scanner only (no Telegram):
 *   node scanner_v6.js
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

// ── Ensure data directory exists ─────────────────────────────────────────────
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('[Launcher] Created data/ directory');
}

// ── Start bot ─────────────────────────────────────────────────────────────────
console.log('[Launcher] Starting Telegram bot…');
const { broadcastSignal } = require('./bot');

// ── Wire scanner patch ────────────────────────────────────────────────────────
const patch = require('./src/scannerPatch');
patch.attachBot(broadcastSignal);

// ── Start scanner ─────────────────────────────────────────────────────────────
console.log('[Launcher] Starting scanner…');

let scanner;
try {
  scanner = require('./scanner_v6');
} catch (e) {
  console.error('[Launcher] Could not load scanner_v6.js:', e.message);
  console.log('[Launcher] Bot is running without scanner. Start scanner separately if needed.');
  return;
}

// ── Hook scanner emit ─────────────────────────────────────────────────────────
// scanner_v6.js must export a `onSignal` hook or we wrap its broadcastSignal.
// Pattern A: scanner exports { onSignal }
if (typeof scanner.onSignal === 'function') {
  scanner.onSignal(result => patch.forwardSignal(result));
  console.log('[Launcher] Hooked scanner via onSignal()');

// Pattern B: scanner exports { broadcastSignal } — wrap it
} else if (typeof scanner.broadcastSignal === 'function') {
  const original = scanner.broadcastSignal.bind(scanner);
  scanner.broadcastSignal = async function (result) {
    await original(result);
    await patch.forwardSignal(result);
  };
  console.log('[Launcher] Hooked scanner via broadcastSignal wrapper');

// Pattern C: scanner runs standalone — advise user on manual integration
} else {
  console.warn(
    '[Launcher] scanner_v6.js does not export onSignal or broadcastSignal.\n' +
    '           Add the following two lines inside scanner_v6.js to complete integration:\n' +
    '\n' +
    "           // At the top of scanner_v6.js:\n" +
    "           const { forwardSignal } = require('./src/scannerPatch');\n" +
    '\n' +
    '           // After scoring each symbol (where you currently console.log the result):\n' +
    '           forwardSignal(result);\n'
  );
}

console.log('[Launcher] System online. Bot + scanner running.');
