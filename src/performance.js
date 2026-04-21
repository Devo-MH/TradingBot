'use strict';

/**
 * Performance Tracker
 *
 * Builds stats from closed trades and generates post-trade debriefs.
 * Also detects behavioral patterns (exiting too early, ignoring warnings, etc.)
 */

const { getClosedTradesByUser } = require('./tradeStore');

// ─── CORE STATS ───────────────────────────────────────────────────────────────

function buildStats(userId) {
  const trades = getClosedTradesByUser(userId, 200);
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);

  const winRate   = wins.length / trades.length;
  const avgWinPct = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const totalPnlUSDT = trades.reduce((s, t) => s + (t.pnlUSDT ?? 0), 0);

  // Expectancy: average $ earned per trade
  const expectancy = trades.reduce((s, t) => s + (t.pnlUSDT ?? 0), 0) / trades.length;

  // Best and worst trades
  const best  = trades.reduce((b, t) => (t.pnlPct > (b?.pnlPct ?? -Infinity) ? t : b), null);
  const worst = trades.reduce((w, t) => (t.pnlPct < (w?.pnlPct ?? Infinity)  ? t : w), null);

  // Current streak
  let streak = 0, streakType = null;
  for (const t of trades) {
    const isWin = t.pnlPct > 0;
    if (streakType === null) { streakType = isWin; streak = 1; }
    else if (isWin === streakType) streak++;
    else break;
  }

  // Risk-reward achieved
  const rrActual = avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct) : 0;

  // By signal grade
  const byGrade = {};
  for (const t of trades) {
    const g = t.signalGrade ?? 'B';
    if (!byGrade[g]) byGrade[g] = { total: 0, wins: 0 };
    byGrade[g].total++;
    if (t.pnlPct > 0) byGrade[g].wins++;
  }

  return {
    totalTrades  : trades.length,
    wins         : wins.length,
    losses       : losses.length,
    winRate      : +winRate.toFixed(3),
    avgWinPct    : +avgWinPct.toFixed(2),
    avgLossPct   : +avgLossPct.toFixed(2),
    totalPnlUSDT : +totalPnlUSDT.toFixed(2),
    expectancy   : +expectancy.toFixed(2),
    rrActual     : +rrActual.toFixed(2),
    best, worst,
    streak, streakType,
    byGrade,
  };
}

// ─── POST-TRADE DEBRIEF ───────────────────────────────────────────────────────

/**
 * Generate a coaching debrief after a trade closes.
 * trade: the closed trade object
 */
function buildPostTradeDebrief(trade) {
  const isWin    = trade.pnlPct > 0;
  const emoji    = trade.pnlPct >= 5 ? '🚀' : trade.pnlPct >= 2 ? '✅' : trade.pnlPct >= 0 ? '🟡' : trade.pnlPct >= -3 ? '🟠' : '🔴';
  const outcome  = isWin ? 'WIN' : 'LOSS';
  const pnlSign  = trade.pnlPct >= 0 ? '+' : '';

  const lines = [
    `${emoji} *TRADE CLOSED — ${trade.symbol}* (${outcome})`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Entry:  \`${trade.entry}\`  →  Exit: \`${trade.closePrice}\``,
    `Result: *${pnlSign}${trade.pnlPct}%*  (${pnlSign}$${Math.abs(trade.pnlUSDT ?? 0).toFixed(2)})`,
    `Signal grade: ${trade.signalGrade ?? 'B'} | Reason: ${formatCloseReason(trade.closeReason)}`,
    ``,
  ];

  // What worked / what to improve
  const worked   = [];
  const improve  = [];

  if (isWin && trade.tp1Hit) {
    worked.push('✓ You took profit at TP1 — locked gains correctly');
  }
  if (isWin && trade.stopMovedToEntry) {
    worked.push('✓ Moved stop to entry after TP1 — risk-free second half');
  }
  if (trade.closeReason === 'sl') {
    if (trade.pnlPct > -3) improve.push('Stop loss was well placed — loss contained');
    else improve.push('Consider tightening your stop loss on the next entry');
  }
  if (trade.closeReason === 'signal_exit') {
    worked.push('✓ Followed the exit signal — protected capital from further drop');
  }
  if (!isWin && !trade.tp1Hit && trade.pnlPct < -5) {
    improve.push('Price moved against you quickly — check 4H alignment before next entry');
  }
  if (isWin && !trade.partialExited && trade.pnlPct < 5) {
    improve.push('Consider taking 50% at TP1 next time to lock profits');
  }

  if (worked.length) {
    lines.push('*What worked:*');
    worked.forEach(w => lines.push(` ${w}`));
    lines.push('');
  }
  if (improve.length) {
    lines.push('*To improve:*');
    improve.forEach(i => lines.push(` · ${i}`));
    lines.push('');
  }

  // Signal quality review
  lines.push(`*Signal quality:*`);
  lines.push(` · Grade ${trade.signalGrade ?? 'B'} setup → outcome: ${isWin ? 'confirmed ✅' : 'did not play out ⚠️'}`);
  if (trade.expansion?.expansionType) {
    lines.push(` · Expected: ${trade.expansion.expansionType}`);
  }

  return lines.join('\n');
}

function formatCloseReason(reason) {
  const map = {
    tp1         : 'TP1 reached',
    tp2         : 'TP2 reached',
    moon        : 'Moon target reached 🚀',
    sl          : 'Stop loss hit',
    manual      : 'Manual close',
    signal_exit : 'Bot exit signal',
  };
  return map[reason] ?? reason;
}

// ─── BEHAVIOR PATTERN DETECTION ───────────────────────────────────────────────

/**
 * Look for repeating user mistakes and return coaching tips.
 */
function detectPatterns(userId) {
  const trades = getClosedTradesByUser(userId, 30);
  if (trades.length < 5) return [];

  const tips = [];

  // Pattern 1: Ignores partial exit — holds through to SL
  const noPartialCount = trades.filter(
    t => !t.partialExited && t.closeReason === 'sl' && t.pnlPct < -2
  ).length;
  if (noPartialCount >= 3) {
    tips.push('📌 Pattern: You often hold all in until SL hits. Try taking 50% at TP1 to lock gains.');
  }

  // Pattern 2: Closes winners too early
  const earlyExits = trades.filter(
    t => t.closeReason === 'manual' && t.pnlPct > 0 && t.pnlPct < 2
  ).length;
  if (earlyExits >= 3) {
    tips.push('📌 Pattern: You exit winning trades too early. Trust the signal targets more.');
  }

  // Pattern 3: Keeps losing trades too long
  const bigLosses = trades.filter(t => t.pnlPct < -6).length;
  if (bigLosses >= 2) {
    tips.push('📌 Pattern: Some losses exceeded 6%. Always set stop loss on the exchange immediately.');
  }

  // Pattern 4: Trades against weak signals
  const weakLosses = trades.filter(t => t.signalGrade === 'B' && t.pnlPct < 0).length;
  const weakTotal  = trades.filter(t => t.signalGrade === 'B').length;
  if (weakTotal >= 5 && weakLosses / weakTotal > 0.6) {
    tips.push('📌 Pattern: Grade B signals have low win rate for you. Consider filtering to Grade A only.');
  }

  return tips;
}

// ─── STATS DISPLAY ────────────────────────────────────────────────────────────

function buildStatsSummary(userId) {
  const stats = buildStats(userId);
  if (!stats) return '📊 No closed trades yet. Your stats will appear after your first trade.';

  const streakLabel = stats.streakType
    ? `${stats.streak} ${stats.streakType ? 'wins' : 'losses'} in a row ${stats.streakType ? '🔥' : '❄️'}`
    : '-';

  const gradeLines = Object.entries(stats.byGrade)
    .map(([g, v]) => ` · Grade ${g}: ${v.wins}/${v.total} (${((v.wins/v.total)*100).toFixed(0)}%)`)
    .join('\n');

  const patterns = detectPatterns(userId);

  return (
    `📊 *Your Trading Performance*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Trades:    ${stats.totalTrades} total | ${stats.wins} wins | ${stats.losses} losses\n` +
    `Win rate:  *${(stats.winRate * 100).toFixed(1)}%*\n` +
    `Avg win:   +${stats.avgWinPct}%  |  Avg loss: ${stats.avgLossPct}%\n` +
    `R:R ratio: ${stats.rrActual}x\n` +
    `Total P&L: *${stats.totalPnlUSDT >= 0 ? '+' : ''}$${stats.totalPnlUSDT}*\n` +
    `Per trade: ${stats.expectancy >= 0 ? '+' : ''}$${stats.expectancy} avg\n` +
    `Streak:    ${streakLabel}\n\n` +
    `*By Signal Grade:*\n${gradeLines}\n\n` +
    `*Best:*  +${stats.best?.pnlPct}%  ${stats.best?.symbol ?? '-'}\n` +
    `*Worst:* ${stats.worst?.pnlPct}%  ${stats.worst?.symbol ?? '-'}\n` +
    (patterns.length ? `\n*Coaching tips:*\n${patterns.join('\n')}` : '')
  );
}

module.exports = {
  buildStats,
  buildPostTradeDebrief,
  detectPatterns,
  buildStatsSummary,
};
