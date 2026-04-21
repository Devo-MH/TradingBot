'use strict';

/**
 * Trade Store
 *
 * All trade lifecycle management: open, update, close.
 * Also tracks per-user daily P&L for the risk engine.
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '../data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

// ─── STORAGE ─────────────────────────────────────────────────────────────────

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveTrades(data) {
  try {
    fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });
    fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[TradeStore] Save error:', e.message);
  }
}

// ─── TRADE LIFECYCLE ─────────────────────────────────────────────────────────

/**
 * Open a new trade.
 * signalData: { symbol, entry, sl, tp1, tp2, moon, signalGrade, signalScore,
 *               classification, atrPct, expansion }
 */
function openTrade(userId, sizeUSDT, signalData) {
  const trades = loadTrades();
  const id = uuidv4().slice(0, 8).toUpperCase();

  trades[id] = {
    id,
    userId         : String(userId),
    symbol         : signalData.symbol,
    entry          : signalData.entry,
    sizeUSDT,
    sl             : signalData.sl,
    tp1            : signalData.tp1,
    tp2            : signalData.tp2,
    moon           : signalData.moon,
    signalGrade    : signalData.signalGrade    ?? 'B',
    signalScore    : signalData.signalScore    ?? 0,
    classification : signalData.classification ?? '',
    atrPct         : signalData.atrPct         ?? 1,
    expansion      : signalData.expansion      ?? {},
    openTime       : Date.now(),
    status         : 'open',
    tp1Hit         : false,
    stopMovedToEntry: false,
    partialExited  : false,
    partialExitPct : 0,
    peakPrice      : signalData.entry,
    lastAlertTime  : 0,
    alertCount     : 0,
    notes          : [],
  };

  saveTrades(trades);
  return trades[id];
}

/**
 * Update mutable fields on an open trade.
 */
function updateTrade(tradeId, patch) {
  const trades = loadTrades();
  if (!trades[tradeId]) return null;
  trades[tradeId] = { ...trades[tradeId], ...patch };
  saveTrades(trades);
  return trades[tradeId];
}

/**
 * Close a trade with a final price and reason.
 * reason: 'tp1' | 'tp2' | 'moon' | 'sl' | 'manual' | 'signal_exit'
 */
function closeTrade(tradeId, closePrice, reason = 'manual') {
  const trades = loadTrades();
  const t = trades[tradeId];
  if (!t) return null;

  const pnlPct  = ((closePrice - t.entry) / t.entry) * 100;
  const pnlUSDT = (t.sizeUSDT * pnlPct) / 100;

  trades[tradeId] = {
    ...t,
    status    : 'closed',
    closePrice,
    closeTime : Date.now(),
    closeReason: reason,
    pnlPct    : +pnlPct.toFixed(2),
    pnlUSDT   : +pnlUSDT.toFixed(2),
  };

  saveTrades(trades);
  return trades[tradeId];
}

// ─── QUERIES ─────────────────────────────────────────────────────────────────

function getTradeById(tradeId) {
  return loadTrades()[tradeId] ?? null;
}

function getOpenTradesByUser(userId) {
  const trades = loadTrades();
  return Object.values(trades).filter(
    t => t.userId === String(userId) && t.status === 'open'
  );
}

function getOpenTradeBySymbol(userId, symbol) {
  return getOpenTradesByUser(userId).find(t => t.symbol === symbol) ?? null;
}

function getClosedTradesByUser(userId, limit = 50) {
  const trades = loadTrades();
  return Object.values(trades)
    .filter(t => t.userId === String(userId) && t.status === 'closed')
    .sort((a, b) => b.closeTime - a.closeTime)
    .slice(0, limit);
}

function getAllOpenTrades() {
  const trades = loadTrades();
  return Object.values(trades).filter(t => t.status === 'open');
}

// ─── DAILY P&L ───────────────────────────────────────────────────────────────

/**
 * Sum P&L for all trades closed today for a given user.
 */
function getDailyPnL(userId) {
  const today  = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const trades = loadTrades();
  return Object.values(trades)
    .filter(t =>
      t.userId === String(userId) &&
      t.status  === 'closed' &&
      t.closeTime >= startOfDay
    )
    .reduce((sum, t) => sum + (t.pnlUSDT ?? 0), 0);
}

/**
 * Count trades closed today for a user.
 */
function getDailyTradeCount(userId) {
  const today  = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const trades = loadTrades();
  return Object.values(trades).filter(
    t => t.userId === String(userId) && t.status === 'closed' && t.closeTime >= startOfDay
  ).length;
}

// ─── PORTFOLIO SNAPSHOT ───────────────────────────────────────────────────────

/**
 * Build a full portfolio snapshot for a user.
 * Returns deployed capital, at-risk amount, open trade list, daily P&L.
 */
function getPortfolioSnapshot(userId) {
  const open    = getOpenTradesByUser(userId);
  const dailyPnl = getDailyPnL(userId);

  const deployedUSDT = open.reduce((s, t) => s + t.sizeUSDT, 0);
  const atRiskUSDT   = open.reduce((s, t) => {
    const slDist = Math.abs(t.entry - t.sl) / t.entry;
    return s + t.sizeUSDT * slDist;
  }, 0);

  return {
    openCount      : open.length,
    openTrades     : open,
    deployedUSDT   : +deployedUSDT.toFixed(2),
    atRiskUSDT     : +atRiskUSDT.toFixed(2),
    dailyPnlUSDT   : +dailyPnl.toFixed(2),
    dailyTradeCount: getDailyTradeCount(userId),
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  openTrade,
  updateTrade,
  closeTrade,
  getTradeById,
  getOpenTradesByUser,
  getOpenTradeBySymbol,
  getClosedTradesByUser,
  getAllOpenTrades,
  getDailyPnL,
  getDailyTradeCount,
  getPortfolioSnapshot,
};
