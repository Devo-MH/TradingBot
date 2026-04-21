'use strict';

/**
 * Watchlist
 *
 * Stores coins the user wants to watch (pre-pump or near-breakout).
 * When scanner later finds a signal for a watched coin, the alert
 * is flagged as "YOU WERE WATCHING THIS".
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, '../data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

function load() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch {}
  return {};
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function addToWatchlist(userId, symbol, reason = '') {
  const wl = load();
  const uid = String(userId);
  if (!wl[uid]) wl[uid] = {};
  wl[uid][symbol] = { symbol, reason, addedAt: Date.now(), triggered: false };
  save(wl);
}

function removeFromWatchlist(userId, symbol) {
  const wl = load();
  const uid = String(userId);
  if (wl[uid]) delete wl[uid][symbol];
  save(wl);
}

function getWatchlist(userId) {
  const wl = load();
  return Object.values(wl[String(userId)] ?? {});
}

function isWatching(userId, symbol) {
  const wl = load();
  return !!(wl[String(userId)]?.[symbol]);
}

function markTriggered(userId, symbol) {
  const wl = load();
  const uid = String(userId);
  if (wl[uid]?.[symbol]) {
    wl[uid][symbol].triggered = true;
    save(wl);
  }
}

function buildWatchlistSummary(userId) {
  const items = getWatchlist(userId);
  if (!items.length) return '👀 Watchlist is empty.\n\nUse /watch SYMBOL to add a coin.';

  const lines = items.map(w => {
    const age  = Math.round((Date.now() - w.addedAt) / 60000);
    const flag = w.triggered ? ' 🔔 Signal triggered!' : '';
    return ` · \`${w.symbol}\`${flag}  (added ${age}m ago${w.reason ? ' — ' + w.reason : ''})`;
  });

  return `👀 *Your Watchlist (${items.length})*\n━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n\nSignals on these coins arrive with priority.`;
}

/**
 * Get all users watching a given symbol.
 * Used by the broadcaster to tag alerts.
 */
function getUsersWatchingSymbol(symbol) {
  const wl  = load();
  const out = [];
  for (const [uid, coins] of Object.entries(wl)) {
    if (coins[symbol]) out.push(uid);
  }
  return out;
}

module.exports = {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  isWatching,
  markTriggered,
  buildWatchlistSummary,
  getUsersWatchingSymbol,
};
