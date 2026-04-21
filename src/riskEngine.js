'use strict';

/**
 * Risk Engine
 *
 * Centralises all pre-trade and runtime risk enforcement.
 * Every trade entry attempt passes through gateCheck() before opening.
 * Returns { allowed: boolean, reason: string } so callers can surface
 * human-readable rejection messages to the user.
 */

const { getProfile }          = require('./userProfile');
const { getPortfolioSnapshot, getDailyPnL } = require('./tradeStore');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const HARD_MAX_RISK_PER_TRADE_PCT = 0.25;   // never risk > 25 % of capital in one trade
const HARD_DAILY_LOSS_FLOOR_PCT   = 0.20;   // stop trading if daily loss exceeds 20 % regardless of setting
const CONSECUTIVE_LOSS_PAUSE      = 3;       // pause suggestions after N consecutive losses

// ─── GATE CHECK ───────────────────────────────────────────────────────────────

/**
 * Full pre-trade risk gate.
 * Call before opening any trade.
 *
 * @param {string|number} userId
 * @param {number}        tradeUSDT    — the proposed position size in USDT
 * @param {string}        symbol       — e.g. 'BTCUSDT'
 * @returns {{ allowed: boolean, reason: string, warnings: string[] }}
 */
function gateCheck(userId, tradeUSDT, symbol) {
  const profile  = getProfile(userId);
  const snap     = getPortfolioSnapshot(userId);
  const dailyPnl = getDailyPnL(userId);
  const warnings = [];

  if (!profile) {
    return fail('Profile not found — please complete /start setup first.');
  }

  const capital = profile.capital ?? 1000;

  // ── 1. Hard daily loss floor ─────────────────────────────────────────────────
  const dailyLossPct = dailyPnl / capital;
  if (dailyLossPct <= -(HARD_DAILY_LOSS_FLOOR_PCT)) {
    return fail(
      `Daily loss floor reached (${(dailyLossPct * 100).toFixed(1)}% of capital). ` +
      `Trading is paused for today to protect your account.`
    );
  }

  // ── 2. User-defined daily loss limit ────────────────────────────────────────
  const userLimitPct = profile.dailyLossLimitPct ?? 0.05;
  if (dailyLossPct <= -userLimitPct) {
    return fail(
      `Your daily loss limit of ${(userLimitPct * 100).toFixed(0)}% has been reached. ` +
      `I'll resume sending signals tomorrow.`
    );
  }

  // ── 3. Max concurrent trades ─────────────────────────────────────────────────
  const maxTrades = profile.maxTrades ?? 3;
  if (snap.openTrades.length >= maxTrades) {
    return fail(
      `You already have ${snap.openTrades.length} open trades (your limit is ${maxTrades}). ` +
      `Close one before opening another.`
    );
  }

  // ── 4. Duplicate symbol ──────────────────────────────────────────────────────
  const alreadyOpen = snap.openTrades.find(t => t.symbol === symbol);
  if (alreadyOpen) {
    return fail(`You already have an open trade on ${symbol}.`);
  }

  // ── 5. Hard per-trade size cap ───────────────────────────────────────────────
  const maxAllowed = capital * HARD_MAX_RISK_PER_TRADE_PCT;
  if (tradeUSDT > maxAllowed) {
    return fail(
      `Proposed size ($${tradeUSDT.toFixed(0)}) exceeds the per-trade hard cap ` +
      `($${maxAllowed.toFixed(0)} = 25% of capital). Please use a smaller size.`
    );
  }

  // ── 6. Portfolio heat check ──────────────────────────────────────────────────
  const totalDeployed = snap.deployedUSDT + tradeUSDT;
  const deployedPct   = totalDeployed / capital;
  if (deployedPct > 0.80) {
    warnings.push(
      `⚠️ After this trade, ${(deployedPct * 100).toFixed(0)}% of your capital will be deployed. ` +
      `Consider waiting for an existing trade to close.`
    );
  }

  // ── 7. Consecutive loss cool-off ─────────────────────────────────────────────
  const streak = getConsecutiveLosses(userId);
  if (streak >= CONSECUTIVE_LOSS_PAUSE) {
    warnings.push(
      `⚠️ You've had ${streak} consecutive losses. This is allowed, but consider ` +
      `reducing size or sitting out until the streak breaks.`
    );
  }

  return { allowed: true, reason: 'OK', warnings };
}

// ─── RUNTIME CHECKS (called by monitor) ──────────────────────────────────────

/**
 * Check whether the user's daily loss limit is exceeded mid-session.
 * Returns { allowed, reason } — same shape as gateCheck for easy consumption.
 */
function checkLiveDailyLimit(userId) {
  const profile  = getProfile(userId);
  const dailyPnl = getDailyPnL(userId);
  if (!profile) return { allowed: true, reason: 'OK' };

  const capital      = profile.capital ?? 1000;
  const userLimitPct = profile.dailyLossLimitPct ?? 0.05;
  const dailyLossPct = dailyPnl / capital;

  if (dailyLossPct <= -(HARD_DAILY_LOSS_FLOOR_PCT)) {
    return {
      allowed: false,
      reason : `Hard daily loss floor hit (${(dailyLossPct * 100).toFixed(1)}% of capital). Trading paused for today.`,
    };
  }
  if (dailyLossPct <= -userLimitPct) {
    return {
      allowed: false,
      reason : `Daily loss limit of ${(userLimitPct * 100).toFixed(0)}% reached. Signals resume tomorrow.`,
    };
  }

  return { allowed: true, reason: 'OK' };
}

// ─── PORTFOLIO HEAT DISPLAY ───────────────────────────────────────────────────

/**
 * Build a plain-text portfolio heat summary for display in /status.
 */
function buildHeatSummary(userId) {
  const profile  = getProfile(userId);
  const snap     = getPortfolioSnapshot(userId);
  const dailyPnl = getDailyPnL(userId);

  if (!profile) return '⚠️ Profile not set up.';

  const capital      = profile.capital ?? 1000;
  const deployedPct  = ((snap.deployedUSDT / capital) * 100).toFixed(1);
  const atRiskPct    = ((snap.atRiskUSDT   / capital) * 100).toFixed(1);
  const dailyPnlPct  = ((dailyPnl          / capital) * 100).toFixed(2);
  const dailyLimitPct = ((profile.dailyLossLimitPct ?? 0.05) * 100).toFixed(0);

  const streak   = getConsecutiveLosses(userId);
  const heatBar  = buildHeatBar(parseFloat(deployedPct));
  const limitBar = buildLimitBar(Math.abs(Math.min(dailyPnl / capital, 0)), profile.dailyLossLimitPct ?? 0.05);

  return (
    `🌡️ *Portfolio Heat*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Capital:    $${capital.toLocaleString()}\n` +
    `Deployed:   ${deployedPct}%  ${heatBar}\n` +
    `At risk:    $${snap.atRiskUSDT.toFixed(0)}\n` +
    `Open trades: ${snap.openTrades.length} / ${profile.maxTrades ?? 3}\n` +
    `\n` +
    `*Daily P&L:*  ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)}  (${dailyPnl >= 0 ? '+' : ''}${dailyPnlPct}%)\n` +
    `Loss budget:  ${limitBar}  ${dailyLimitPct}% limit\n` +
    (streak >= 2 ? `\n⚠️ Consecutive losses: ${streak}` : '')
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fail(reason) {
  return { allowed: false, reason, warnings: [] };
}

function buildHeatBar(pct) {
  const filled = Math.round(pct / 10);
  const bar    = '█'.repeat(Math.min(filled, 10)) + '░'.repeat(Math.max(0, 10 - filled));
  return `[${bar}] ${pct}%`;
}

function buildLimitBar(usedRatio, limitRatio) {
  const total  = 10;
  const filled = Math.round((usedRatio / limitRatio) * total);
  const bar    = '█'.repeat(Math.min(filled, total)) + '░'.repeat(Math.max(0, total - filled));
  return `[${bar}]`;
}

/**
 * Count consecutive losing trades (most recent first).
 * Reads from tradeStore directly to avoid circular dep on performance.js.
 */
function getConsecutiveLosses(userId) {
  try {
    const { getClosedTradesByUser } = require('./tradeStore');
    const trades = getClosedTradesByUser(userId, 10);
    let streak = 0;
    for (const t of trades) {
      if (t.pnlPct < 0) streak++;
      else break;
    }
    return streak;
  } catch {
    return 0;
  }
}

module.exports = {
  gateCheck,
  checkLiveDailyLimit,
  buildHeatSummary,
  getConsecutiveLosses,
};
