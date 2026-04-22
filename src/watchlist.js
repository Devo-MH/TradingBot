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

function addToWatchlist(userId, symbol, reason = '', alertPrice = null, entryRef = null) {
  const wl  = load();
  const uid = String(userId);
  if (!wl[uid]) wl[uid] = {};
  wl[uid][symbol] = {
    symbol,
    reason,
    addedAt    : Date.now(),
    triggered  : false,
    alertPrice : alertPrice ?? null,   // price level to fire notification at
    entryRef   : entryRef  ?? null,    // original signal entry for context
    alertFired : false,
  };
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

function fireAlert(userId, symbol) {
  const wl  = load();
  const uid = String(userId);
  if (wl[uid]?.[symbol]) {
    wl[uid][symbol].alertFired = true;
    save(wl);
  }
}

/** Returns all watchlist entries that have an unfired price alert, across all users. */
function getWatchlistAlerts() {
  const wl  = load();
  const out = [];
  for (const [uid, coins] of Object.entries(wl)) {
    for (const item of Object.values(coins)) {
      if (item.alertPrice && !item.alertFired) {
        out.push({ userId: uid, symbol: item.symbol, alertPrice: item.alertPrice, entryRef: item.entryRef });
      }
    }
  }
  return out;
}

function buildWatchlistSummary(userId) {
  const items = getWatchlist(userId);
  if (!items.length) return '👀 Watchlist is empty.\n\nUse /watch SYMBOL to add a coin.';

  const bt    = '`';
  const lines = items.map(w => {
    const age       = Math.round((Date.now() - w.addedAt) / 60000);
    const status    = w.triggered ? ' 🔔 Signal triggered!'
      : w.alertFired  ? ' ✅ Alert fired'
      : '';
    const alertLine = w.alertPrice && !w.alertFired
      ? `\n     🔔 Alert: break above ${bt}${_fmt(w.alertPrice)}${bt}`
      : '';
    return ` · ${bt}${w.symbol}${bt}${status}  (${age < 60 ? age + 'm' : Math.round(age/60) + 'h'} ago)${alertLine}`;
  });

  return `👀 *Your Watchlist (${items.length})*\n━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n\n_Signals on these coins arrive with priority. Alerts fire automatically._`;
}

function _fmt(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return 'N/A';
  if (n < 0.001)  return n.toFixed(8);
  if (n < 0.01)   return n.toFixed(6);
  if (n < 1)      return n.toFixed(5);
  if (n >= 1000)  return n.toFixed(2);
  return n.toFixed(4);
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
  fireAlert,
  getWatchlistAlerts,
  buildWatchlistSummary,
  getUsersWatchingSymbol,
};
