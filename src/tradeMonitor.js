'use strict';

/**
 * Trade Monitor
 *
 * Runs every 5 minutes alongside the scanner.
 * For each open trade it:
 *   1. Fetches the current price
 *   2. Checks if TP1/TP2/Moon/SL was hit
 *   3. Re-runs the institutional layer for continuation score
 *   4. Fires the appropriate guided alert to the user
 *
 * All milestone detection is deterministic — no duplicate alerts because
 * each milestone is flagged on the trade record once triggered.
 */

const { getAllOpenTrades, updateTrade, closeTrade, getPortfolioSnapshot } = require('./tradeStore');
const { buildTP1Alert, buildWeakeningAlert, buildExitNowAlert, buildSLHitAlert } = require('./signalBridge');
const { buildPostTradeDebrief } = require('./performance');
const { checkDailyLimit, getDailyPnL } = require('./userProfile');

// ─── MONITOR LOOP ─────────────────────────────────────────────────────────────

/**
 * Main monitor function — call this on a 5-minute interval.
 * sendFn: async (userId, text, keyboard?) => void  — the Telegram send function
 * getPriceFn: async (symbol) => number | null
 * getInstAnalysisFn: async (symbol, price) => { contScore, warnings, verdict }
 */
async function runMonitor(sendFn, getPriceFn, getInstAnalysisFn) {
  const trades = getAllOpenTrades();
  if (!trades.length) return;

  for (const trade of trades) {
    try {
      await monitorSingleTrade(trade, sendFn, getPriceFn, getInstAnalysisFn);
      await sleep(300);
    } catch (e) {
      console.error(`[Monitor] ${trade.symbol} (${trade.id}):`, e.message);
    }
  }
}

async function monitorSingleTrade(trade, sendFn, getPriceFn, getInstAnalysisFn) {
  const price = await getPriceFn(trade.symbol);
  if (!price || !isFinite(price)) return;

  // Update peak price
  if (price > (trade.peakPrice ?? trade.entry)) {
    updateTrade(trade.id, { peakPrice: price });
  }

  const now = Date.now();

  // ── 1. STOP LOSS HIT ────────────────────────────────────────────────────────
  if (price <= trade.sl && !trade.slAlertSent) {
    updateTrade(trade.id, { slAlertSent: true });
    const closed = closeTrade(trade.id, price, 'sl');
    const alert  = buildSLHitAlert(closed);
    await sendFn(trade.userId, alert.text, alert.inlineKeyboard);

    // Daily limit check after loss
    const dailyPnl = getDailyPnL(trade.userId);
    const limitCheck = checkDailyLimit(trade.userId, dailyPnl);
    if (!limitCheck.allowed) {
      await sendFn(
        trade.userId,
        `⛔ *Daily loss limit reached*\n\n${limitCheck.reason}\n\n_I'll resume sending signals tomorrow._`,
        null
      );
    }

    // Post-trade debrief
    await sleep(1500);
    await sendFn(trade.userId, buildPostTradeDebrief(closed), null);
    return;
  }

  // ── 2. MOON TARGET HIT ──────────────────────────────────────────────────────
  if (price >= trade.moon && !trade.moonAlertSent) {
    updateTrade(trade.id, { moonAlertSent: true });
    const closed = closeTrade(trade.id, price, 'moon');
    const pnlPct = closed.pnlPct;
    await sendFn(
      trade.userId,
      `🚀 *MOON TARGET HIT — ${trade.symbol}!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Price: \`${price}\`\n` +
      `Gain:  *+${pnlPct}%*  (+$${Math.abs(closed.pnlUSDT ?? 0).toFixed(2)})\n\n` +
      `Incredible. Take full profit or trail stop.\n` +
      `This is exactly what the scanner looks for. 🎉`,
      {
        inline_keyboard: [[
          { text: '💰 Took full profit',   callback_data: `moon_exit_${trade.id}` },
          { text: '📊 Trade debrief',      callback_data: `debrief_${trade.id}`   },
        ]],
      }
    );
    await sleep(1500);
    await sendFn(trade.userId, buildPostTradeDebrief(closed), null);
    return;
  }

  // ── 3. TP2 HIT ──────────────────────────────────────────────────────────────
  if (price >= trade.tp2 && !trade.tp2AlertSent) {
    updateTrade(trade.id, { tp2AlertSent: true });
    const pnlPct = ((price - trade.entry) / trade.entry * 100).toFixed(2);
    await sendFn(
      trade.userId,
      `🎯 *TP2 HIT — ${trade.symbol}!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Price: \`${price}\` — *+${pnlPct}%*\n\n` +
      `Strong move! Options:\n` +
      ` · Exit remaining → lock full profit\n` +
      ` · Hold for Moon target with trailing stop`,
      {
        inline_keyboard: [
          [
            { text: '💰 Exited everything',     callback_data: `tp2_exit_${trade.id}`  },
            { text: '🌕 Hold for moon',         callback_data: `tp2_hold_${trade.id}`  },
          ],
        ],
      }
    );
    return;
  }

  // ── 4. TP1 HIT ──────────────────────────────────────────────────────────────
  if (price >= trade.tp1 && !trade.tp1Hit && !trade.tp1AlertSent) {
    updateTrade(trade.id, { tp1AlertSent: true, tp1Hit: true });
    const alert = buildTP1Alert(trade, price);
    await sendFn(trade.userId, alert.text, alert.inlineKeyboard);
    return;
  }

  // ── 5. INSTITUTIONAL RE-ANALYSIS (continuation check) ───────────────────────
  const cooldown = (trade.alertCount ?? 0) < 3
    ? 15 * 60 * 1000   // first 3 updates: every 15 min
    : 30 * 60 * 1000;  // after that: every 30 min

  if (now - (trade.lastAlertTime ?? 0) < cooldown) return;

  const analysis = await getInstAnalysisFn(trade.symbol, price);
  if (!analysis) return;

  const pnlPct  = ((price - trade.entry) / trade.entry * 100).toFixed(2);
  const fromPeak = trade.peakPrice > 0
    ? ((price - trade.peakPrice) / trade.peakPrice * 100).toFixed(2)
    : 0;

  // ── 5a. FORCE EXIT — critical signals ────────────────────────────────────────
  const forceExitReasons = [];
  if (analysis.mmTrap)                          forceExitReasons.push('Market Maker Trap confirmed — breakout was fake');
  if (analysis.verdict === 'AVOID')             forceExitReasons.push('Institutional verdict flipped to AVOID');
  if (analysis.tfConflict === 'FULL_BEARISH')   forceExitReasons.push('4H + 1H + 15M all flipped bearish');
  if (analysis.trendStatus === 'Trend Stop')    forceExitReasons.push('Price structure broken — trend stopped');
  if (parseFloat(fromPeak) < -8 && !trade.tp1Hit) forceExitReasons.push(`Price -${Math.abs(fromPeak)}% from peak`);

  if (forceExitReasons.length >= 1) {
    const alert = buildExitNowAlert(trade, forceExitReasons, price);
    await sendFn(trade.userId, alert.text, alert.inlineKeyboard);
    updateTrade(trade.id, { lastAlertTime: now, alertCount: (trade.alertCount ?? 0) + 1 });
    return;
  }

  // ── 5b. WARNING — weakening signals ──────────────────────────────────────────
  if (analysis.contScore <= 45 || analysis.warnings?.length >= 2) {
    const reasons = analysis.warnings?.slice(0, 3) ?? ['Momentum weakening', 'Trend structure softening'];
    const alert   = buildWeakeningAlert(trade, reasons);
    await sendFn(trade.userId, alert.text, alert.inlineKeyboard);
    updateTrade(trade.id, { lastAlertTime: now, alertCount: (trade.alertCount ?? 0) + 1 });
    return;
  }

  // ── 5c. POSITIVE UPDATE — trend still strong ─────────────────────────────────
  if (analysis.contScore >= 70 && (now - (trade.lastAlertTime ?? 0)) > 30 * 60 * 1000) {
    const pnlEmoji = parseFloat(pnlPct) >= 0 ? '📈' : '📉';
    await sendFn(
      trade.userId,
      `${pnlEmoji} *UPDATE — ${trade.symbol}*\n` +
      `Price: \`${price}\`  |  P&L: ${parseFloat(pnlPct) >= 0 ? '+' : ''}${pnlPct}%\n` +
      `Continuation: *${analysis.contScore}/100* — Trend intact\n` +
      `${analysis.verdict ? `Verdict: ${analysis.verdict}` : ''}`,
      {
        inline_keyboard: [[
          { text: '📊 Full analysis', callback_data: `upd_analysis_${trade.symbol}` },
          { text: '💰 Close trade',   callback_data: `exit_done_${trade.id}`        },
        ]],
      }
    );
    updateTrade(trade.id, { lastAlertTime: now, alertCount: (trade.alertCount ?? 0) + 1 });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runMonitor };
