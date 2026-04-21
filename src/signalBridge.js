'use strict';

/**
 * Signal Bridge
 *
 * Converts raw scanner results into per-user guided alerts.
 * Handles:
 *   - grade filtering per user setting
 *   - position sizing injection
 *   - inline button generation
 *   - watchlist flagging
 *   - per-user active hours gate
 *   - CVD divergence trap warnings
 *   - smart money absorption display
 *   - accumulation-watch alert type (separate from trade signals)
 */

const { getAllProfiles, calcPositionSizes, shouldReceiveSignal, isUserActive } = require('./userProfile');
const { getPortfolioSnapshot }                                                  = require('./tradeStore');
const { getUsersWatchingSymbol }                                                = require('./watchlist');

// ─── GRADE MAPPING ────────────────────────────────────────────────────────────

function scoreToGrade(iScore) {
  if (iScore >= 80) return 'A+';
  if (iScore >= 65) return 'A';
  if (iScore >= 45) return 'B';
  return 'C';
}

function classificationLabel(classification) {
  if (classification?.includes('EXPLOSIVE')) return '🔥 EXPLOSIVE BREAKOUT';
  if (classification?.includes('STRONG'))    return '💪 STRONG BREAKOUT';
  if (classification?.includes('EARLY'))     return '📈 EARLY BREAKOUT';
  if (classification?.includes('ACCUM'))     return '📊 ACCUMULATION SETUP';
  return classification ?? '📊 SETUP';
}

// ─── CVD HELPERS ─────────────────────────────────────────────────────────────

/**
 * Extract CVD state from scanner result.
 * Scanner may provide r.cvd directly, or we derive it from hiddenFlow.
 *
 * Returns:
 *   { diverging: boolean, direction: 'BULLISH'|'BEARISH'|'NEUTRAL', absorption: number }
 *
 * Field mapping from scanner_v6.js:
 *   r.cvd                      — { direction, priceUp, divergence } if scanner exports it directly
 *   r._instLayer.hiddenFlow    — { type: 'HIDDEN_BUYER'|'HIDDEN_SELLER'|null, confidence: 0–100 }
 *   r._instLayer.mmTrap        — { trap: boolean } — price up + CVD down = MM trap
 */
function extractCVD(r) {
  // Direct CVD field (scanner_v6 may export this)
  if (r.cvd) {
    return {
      diverging  : r.cvd.divergence ?? false,
      direction  : r.cvd.direction ?? 'NEUTRAL',
      absorption : r.cvd.absorption ?? absorptionFromHiddenFlow(r),
    };
  }

  // Derive from hiddenFlow + mmTrap
  const flow      = r._instLayer?.hiddenFlow;
  const isTrap    = r._instLayer?.mmTrap?.trap ?? false;
  const absorption = absorptionFromHiddenFlow(r);

  if (isTrap) {
    return { diverging: true, direction: 'BEARISH', absorption };
  }
  if (flow?.type === 'HIDDEN_BUYER') {
    return { diverging: false, direction: 'BULLISH', absorption };
  }
  if (flow?.type === 'HIDDEN_SELLER') {
    return { diverging: true, direction: 'BEARISH', absorption };
  }
  return { diverging: false, direction: 'NEUTRAL', absorption };
}

/**
 * Read absorption score from hiddenFlow confidence, or order book data.
 * Returns 0–100.
 */
function absorptionFromHiddenFlow(r) {
  if (r._instLayer?.hiddenFlow?.confidence != null) {
    return r._instLayer.hiddenFlow.confidence;
  }
  // Fall back to orderBook bid dominance if available
  if (r.orderBook?.bidDominance != null) {
    return Math.round(r.orderBook.bidDominance);
  }
  return 0;
}

/**
 * Determine if a scanner result is a pure accumulation setup
 * (NOT ready to enter yet — watching phase).
 *
 * Criteria (mirrors guide Section 3.3):
 *   - Price flat or low volatility (volZ.stealth OR low volume ratio)
 *   - CVD / hiddenFlow showing bullish accumulation
 *   - Classification includes ACCUM, or explicitly not EXPLOSIVE/STRONG
 *   - Trigger distance > 1% (not yet at breakout)
 */
function isAccumulationSetup(r) {
  const stealth    = r.volZ?.stealth === true;
  const lowVol     = parseFloat(r.volRatio ?? 0) < 1.2;
  const hiddenBuyer = r._instLayer?.hiddenFlow?.type === 'HIDDEN_BUYER';
  const absorption  = absorptionFromHiddenFlow(r);
  const highAbsorption = absorption >= 70;
  const notYetBreaking = (r.triggerDistance ?? r.breakoutDistance ?? 99) > 1.0;
  const classification  = r.classification ?? '';

  return (
    (stealth || lowVol) &&
    (hiddenBuyer || highAbsorption) &&
    notYetBreaking &&
    !classification.includes('EXPLOSIVE') &&
    !classification.includes('STRONG')
  );
}

// ─── SIGNAL SUMMARY (human-readable) ─────────────────────────────────────────

/**
 * Build the "why this coin" summary lines from scanner result.
 * Updated to surface absorption score prominently and use guide language.
 */
function buildWhySummary(r) {
  const reasons    = [];
  const absorption = absorptionFromHiddenFlow(r);
  const cvd        = extractCVD(r);

  // Volume — always first per guide priority
  if (r.volZ?.highAnomaly) {
    reasons.push(`Volume ${r.volZ.ratio}x average — unusual surge`);
  } else if (r.volZ?.stealth) {
    reasons.push('Stealth accumulation — low volume, hidden buying');
  } else if (parseFloat(r.volRatio) > 1.5) {
    reasons.push(`Volume rising (${r.volRatio}x average)`);
  }

  // CVD — second priority per guide
  if (cvd.direction === 'BULLISH' && absorption > 0) {
    reasons.push(`Smart Money Absorption: ${absorption}/100 — supply disappearing`);
  }

  // Timeframe alignment
  if (r._instLayer?.tfHierarchy?.conflictType === 'FULL_ALIGNMENT') {
    reasons.push('All 3 timeframes aligned bullish (15m + 1h + 4h)');
  } else if (r._instLayer?.tfHierarchy?.conflictType === 'LOCAL_PULLBACK') {
    reasons.push('Short dip inside a bullish trend — dip buy opportunity');
  }

  // Wyckoff / structural signals
  if (r.spring?.spring) {
    reasons.push('Wyckoff Spring confirmed — accumulation phase ending');
  }
  if (r._instLayer?.shakeout?.shakeout) {
    reasons.push('Weak-hand flush detected — likely recovery incoming');
  }

  // Breakout confirmation
  if (r.fbCheck?.isFake === false && r.fbCheck?.brokeHigh) {
    reasons.push('Breakout confirmed with volume — not a fake move');
  }

  // Explosion readiness
  if (r.explosionReadiness?.score >= 70) {
    reasons.push(`Explosion readiness: ${r.explosionReadiness.score}/100`);
  }

  return reasons.slice(0, 4);
}

/**
 * Translate institutional verdict to a risk label.
 */
function riskLabel(r) {
  const mmTrap  = r._instLayer?.mmTrap?.trap;
  const clarity = r._instLayer?.conflicts?.signalClarity;
  if (mmTrap)                    return '🔴 HIGH — MM Trap risk present';
  if (clarity === 'DANGEROUS')   return '🔴 HIGH — Conflicting signals';
  if (clarity === 'CONFLICTED')  return '🟠 MEDIUM — Some conflicts';
  if (clarity === 'EXPLAINABLE') return '🟡 LOW-MEDIUM — Explained';
  return '🟢 LOW — Clean signal';
}

// ─── CVD DIVERGENCE BANNER ───────────────────────────────────────────────────

/**
 * Returns a warning banner string when CVD and price are diverging.
 * Price up + CVD down = distribution trap — the most important warning in the guide.
 * Empty string when no divergence.
 */
function cvdDivergenceBanner(r) {
  const cvd  = extractCVD(r);
  const trap = r._instLayer?.mmTrap?.trap ?? false;

  if (trap || (cvd.diverging && cvd.direction === 'BEARISH')) {
    return (
      `⚠️ *CVD DIVERGENCE WARNING*\n` +
      `Price is moving UP but buying pressure is NOT confirming.\n` +
      `This pattern precedes fake breakouts. Use smaller size or wait for CVD to align.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n`
    );
  }
  return '';
}

// ─── COMPACT INDICATOR ROW ────────────────────────────────────────────────────

/**
 * Build the one-line indicator dashboard shown at the top of every signal.
 * Shows actual numbers — H, TSMOM, ATR%, VolZ — the numbers Emy asked for.
 */
function buildIndicatorRow(r) {
  const parts = [];

  // Hurst exponent
  const h = r.hurst ?? r.hurstH ?? r.instGrade?.hurst;
  if (h != null) {
    const he = h >= 0.9 ? '🔥' : h >= 0.85 ? '✅' : h >= 0.7 ? '🟡' : '🔴';
    parts.push(`H=${h.toFixed(2)}${he}`);
  }

  // TSMOM
  const ts = r.tsmom ?? r.instGrade?.tsmom;
  if (ts != null) {
    const te = ts >= 0.9 ? '📈' : ts >= 0.5 ? '🟡' : '📉';
    parts.push(`TSMOM=${ts.toFixed(1)}${te}`);
  }

  // ATR%
  const atrPct = r.atrPct ?? r.instGrade?.atrPct;
  if (atrPct != null) {
    const coiling = parseFloat(atrPct) < 1.0;
    const ae = coiling ? '🗜️' : parseFloat(atrPct) <= 1.8 ? '✅' : '⚡';
    parts.push(`ATR=${parseFloat(atrPct).toFixed(2)}%${ae}`);
  }

  // Volume Z
  const vz = r.volZ?.ratio ?? r.volRatio;
  if (vz != null) {
    const ve = parseFloat(vz) >= 4 ? '🚀' : parseFloat(vz) >= 2 ? '🔥' : parseFloat(vz) >= 1.5 ? '📈' : '';
    parts.push(`VolZ=${parseFloat(vz).toFixed(2)}${ve}`);
  }

  return parts.length ? parts.join('  |  ') : null;
}

/**
 * Build the market depth row: OB ratio + absorption + breakout distance.
 */
function buildDepthRow(r) {
  const parts = [];
  const absorption = absorptionFromHiddenFlow(r);
  const obRatio    = r.orderBook?.ratio ?? r.instGrade?.obRatio;
  const trigDist   = r.triggerDistance ?? r.breakoutDistance;

  if (obRatio != null) {
    const oe = obRatio >= 3 ? '🔥' : obRatio >= 2.5 ? '✅' : obRatio >= 1.0 ? '🟡' : '⚠️';
    parts.push(`OB: ${obRatio.toFixed(2)}x${oe}`);
  }

  if (absorption >= 40) {
    const ae = absorption >= 90 ? '🔥' : absorption >= 70 ? '✅' : '';
    parts.push(`Abs: ${absorption}/100${ae}`);
  }

  if (trigDist != null) {
    const de = parseFloat(trigDist) <= 0.5 ? '🎯' : parseFloat(trigDist) <= 1.0 ? '📍' : '';
    parts.push(`Break: ${parseFloat(trigDist).toFixed(1)}% away${de}`);
  }

  return parts.length ? parts.join('  |  ') : null;
}

/**
 * One plain-English sentence describing the CVD situation.
 * This is what Emy asked for: "CVD rising fast" or "price flat - CVD rising surprisingly".
 */
function buildCVDLine(r) {
  const cvd  = extractCVD(r);
  const trap = r._instLayer?.mmTrap?.trap ?? false;

  if (trap) {
    return `⚠️ CVD: Price up but buying NOT confirming — *fake breakout risk*`;
  }

  const flowType = r._instLayer?.hiddenFlow?.type;
  const volRatio = parseFloat(r.volRatio ?? 0);
  const absorption = absorptionFromHiddenFlow(r);

  if (flowType === 'HIDDEN_BUYER') {
    if (volRatio < 1.2) return `📈 CVD: Price flat — CVD rising surprisingly — *hidden accumulation*`;
    if (absorption >= 80) return `📈 CVD: Rising fast alongside volume — *strong buying confirmed*`;
    return `📈 CVD: Bullish — buying pressure building`;
  }

  if (flowType === 'HIDDEN_SELLER') {
    return `⚠️ CVD: Rising price — CVD falling — *distribution warning*`;
  }

  if (cvd.direction === 'BULLISH') return `📈 CVD: Aligned with price — trend confirmed`;
  if (cvd.direction === 'BEARISH') return `⚠️ CVD: Diverging — *proceed with caution*`;
  return `➡️ CVD: Neutral`;
}

/**
 * OB imbalance warning — if sellers outweigh, flag it prominently.
 */
function buildOBWarning(r) {
  const obRatio = r.orderBook?.ratio ?? r.instGrade?.obRatio;
  if (obRatio == null) return '';
  if (obRatio < 1.0) {
    return `⚠️ *Sellers outweigh buyers (OB ${obRatio.toFixed(2)}x)* — wait for confirm above resistance\n`;
  }
  return '';
}

// ─── ENTRY ALERT MESSAGE (trade signal) ──────────────────────────────────────

/**
 * Step 1 alert — compact dashboard format.
 * extras: { newsSummary?: string, rotationLine?: string } — pre-fetched async data
 * Returns { text, inlineKeyboard, grade, verdict }
 */
function buildSignalAlert(r, userId, isWatched = false, extras = {}) {
  const grade      = scoreToGrade(r.instGrade?.iScore ?? 50);
  const iScore     = r.instGrade?.iScore ?? 50;
  const verdict    = r._instLayer?.verdict?.verdict ?? 'WATCH';
  const sizes      = calcPositionSizes(userId);
  const snapshot   = getPortfolioSnapshot(userId);
  const capacity   = _checkCapacity(userId, snapshot);

  const watchedFlag   = isWatched ? ' 👀 *You were watching this!*\n' : '';
  const verdictEmoji  = { HIGH_CONVICTION: '🔥', BUY: '✅', WATCH: '👁', WAIT: '⏳', AVOID: '🚫' }[verdict] ?? '⚪';

  const iRow    = buildIndicatorRow(r);
  const dRow    = buildDepthRow(r);
  const cvdLine = buildCVDLine(r);
  const obWarn  = buildOBWarning(r);

  // Session
  const session = r.session ?? r.instGrade?.session ?? '';
  const sessionEmoji = { EUROPE: '🌍', US: '🇺🇸', ASIA: '🌏' }[session] ?? '';

  // Confirm level (from scanner entry plan)
  const confirmLevel = r.confirmAbove ?? r.breakoutLevel;
  const confirmLine  = confirmLevel
    ? ` ↑ Confirm above: \`${fmtPrice(confirmLevel)}\``
    : '';

  // Targets
  const tp1Pct  = r.tp1  ? `+${((r.tp1  - r.entry) / r.entry * 100).toFixed(0)}%` : '';
  const tp2Pct  = r.tp2  ? `+${((r.tp2  - r.entry) / r.entry * 100).toFixed(0)}%` : '';
  const moonPct = r.moonPrice ? `+${((r.moonPrice - r.entry) / r.entry * 100).toFixed(0)}%` : '';
  const slPct   = r.sl   ? `-${((r.entry  - r.sl)  / r.entry * 100).toFixed(1)}%` : '';

  const text = [
    obWarn,
    `${verdictEmoji} *${classificationLabel(r.classification)} — ${r.symbol}*`,
    watchedFlag,
    `\`@${fmtPrice(r.entry)}\`  |  Grade *${grade}*  |  Score ${iScore}/100${session ? `  |  ${sessionEmoji} ${session}` : ''}`,
    ``,
    iRow  ? `📊  ${iRow}` : null,
    dRow  ? `💧  ${dRow}` : null,
    cvdLine,
    ``,
    r.sl && r.tp1
      ? `🎯  SL: \`${fmtPrice(r.sl)}\` *(${slPct})*  TP1: \`${fmtPrice(r.tp1)}\` *(${tp1Pct})*  TP2: \`${fmtPrice(r.tp2)}\` *(${tp2Pct})*  🌕 \`${fmtPrice(r.moonPrice)}\` *(${moonPct})*`
      : null,
    confirmLine || null,
    ``,
    extras.newsSummary   || null,
    extras.rotationLine  || null,
    ``,
    capacity.allowed && sizes
      ? `💰 Size: *~$${sizes.recommended}*  (cons: $${sizes.conservative}  |  agg: $${sizes.aggressive})`
      : `⚠️ ${capacity.reason}`,
  ].filter(l => l !== null).join('\n');

  const keyboard = capacity.allowed
    ? {
        inline_keyboard: [
          [
            { text: '⚡ Quick Summary',   callback_data: `sig_quick_${r.symbol}` },
            { text: '📊 Full Analysis',   callback_data: `sig_full_${r.symbol}`  },
          ],
          [
            { text: '✅ Enter trade',     callback_data: `sig_enter_${r.symbol}` },
            { text: '👀 Watch it',        callback_data: `sig_watch_${r.symbol}` },
          ],
          [
            { text: '❌ Skip',            callback_data: `sig_skip_${r.symbol}`  },
          ],
        ],
      }
    : {
        inline_keyboard: [[
          { text: '📊 View Analysis',     callback_data: `sig_full_${r.symbol}`  },
          { text: '👀 Watch it',          callback_data: `sig_watch_${r.symbol}` },
        ]],
      };

  return { text, inlineKeyboard: keyboard, grade, verdict };
}

// ─── ACCUMULATION WATCH ALERT (new — no trade entry yet) ─────────────────────

/**
 * Build an "ACCUMULATION WATCH" alert.
 * Fired for flat-price + rising CVD setups that aren't ready to trade yet.
 * User can add to watchlist — bot will notify when the setup triggers.
 *
 * Returns { text, inlineKeyboard, grade }
 */
function buildAccumulationAlert(r, userId, isWatched = false, extras = {}) {
  const absorption  = absorptionFromHiddenFlow(r);
  const iScore      = r.instGrade?.iScore ?? 50;
  const obRatio     = r.orderBook?.ratio ?? r.instGrade?.obRatio;
  const triggerDist = r.triggerDistance ?? r.breakoutDistance;
  const timing      = iScore >= 70 ? '2h–12h' : iScore >= 55 ? '4h–24h' : '12h–48h';

  const iRow = buildIndicatorRow(r);
  const cvdLine = buildCVDLine(r);

  // Key accumulation facts — compact bullets
  const facts = [];
  if (absorption >= 50) facts.push(`Absorption: ${absorption}/100 ${absorption >= 80 ? '🔥' : '✅'}`);
  if (obRatio != null)  facts.push(`OB: ${obRatio.toFixed(2)}x ${obRatio >= 2.5 ? '✅' : obRatio < 1 ? '⚠️' : ''}`);
  if (triggerDist)      facts.push(`${parseFloat(triggerDist).toFixed(1)}% below breakout`);
  if (r.volZ?.stealth)  facts.push('Volume: stealth — whale accumulation');
  if (r.spring?.spring) facts.push('Wyckoff Spring confirmed');

  const text = [
    `👁 *ACCUMULATION WATCH — ${r.symbol}*${isWatched ? ' ✅ watching' : ''}`,
    `\`@${fmtPrice(r.entry)}\`  |  Score ${iScore}/100  |  *Not a trade yet*`,
    ``,
    iRow    ? `📊  ${iRow}` : null,
    cvdLine,
    facts.length ? `\n` + facts.map(f => ` · ${f}`).join('\n') : null,
    ``,
    `*Entry trigger:* Volume spike + break above consolidation`,
    `*Expected window:* ${timing}`,
    ``,
    extras.newsSummary  || null,
    extras.rotationLine || null,
  ].filter(l => l !== null).join('\n');

  const keyboard = {
    inline_keyboard: [
      [
        { text: isWatched ? '✅ Already watching' : '👀 Add to watchlist', callback_data: `sig_watch_${r.symbol}` },
        { text: '📊 Full analysis',                                        callback_data: `sig_full_${r.symbol}`  },
      ],
      [
        { text: '❌ Not interested',                                       callback_data: `sig_skip_${r.symbol}`  },
      ],
    ],
  };

  return { text, inlineKeyboard: keyboard, grade: scoreToGrade(iScore) };
}

// ─── ENTRY PLAN MESSAGE (Step 3) ─────────────────────────────────────────────

function buildEntryPlan(r, userId) {
  const sizes = calcPositionSizes(userId);
  if (!sizes) return null;

  const slPct   = (Math.abs(r.entry - r.sl)   / r.entry * 100).toFixed(1);
  const tp1Pct  = ((r.tp1  - r.entry) / r.entry * 100).toFixed(1);
  const tp2Pct  = ((r.tp2  - r.entry) / r.entry * 100).toFixed(1);
  const moonPct = ((r.moonPrice - r.entry) / r.entry * 100).toFixed(1);

  const maxLossRec  = (sizes.recommended  * parseFloat(slPct) / 100).toFixed(2);
  const maxLossCons = (sizes.conservative * parseFloat(slPct) / 100).toFixed(2);

  const timeline = r.expansion ? `⏱ Expected timeline: *${buildTimeline(r)}*` : '';

  // CVD warning in plan
  const cvdBanner = cvdDivergenceBanner(r);
  const absorption = absorptionFromHiddenFlow(r);
  const absLine = absorption >= 70
    ? `Smart Money Absorption: *${absorption}/100* ${absorption >= 90 ? '🔥' : '✅'}\n`
    : '';

  const text = (
    cvdBanner +
    `📋 *ENTRY PLAN — ${r.symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    absLine +
    `*💰 Position Size (choose one):*\n` +
    ` · Recommended:  *$${sizes.recommended}*  (risks $${maxLossRec})\n` +
    ` · Conservative: $${sizes.conservative}  (risks $${maxLossCons})\n` +
    ` · Aggressive:   $${sizes.aggressive}\n\n` +
    `*📍 Entry Zone:*\n` +
    ` · Ideal:   \`${fmtPrice(r.entry * 0.999)}\` – \`${fmtPrice(r.entry * 1.002)}\`\n` +
    ` · Current: \`${fmtPrice(r.entry)}\` ${r.entry <= r.entry * 1.003 ? '✅ inside zone' : '⚠️ slightly above'}\n\n` +
    `*🛡️ Stop Loss:*\n` +
    ` · Set at: \`${fmtPrice(r.sl)}\` (-${slPct}%)\n` +
    ` · Max loss on recommended size: -$${maxLossRec}\n\n` +
    `*🎯 Targets:*\n` +
    ` · TP1:  \`${fmtPrice(r.tp1)}\`   (+${tp1Pct}%)  → sell 50% here\n` +
    ` · TP2:  \`${fmtPrice(r.tp2)}\`   (+${tp2Pct}%)  → move stop to entry\n` +
    ` · Moon: \`${fmtPrice(r.moonPrice)}\`  (+${moonPct}%) → trail stop\n\n` +
    (timeline ? timeline + '\n\n' : '') +
    `*After entering:*\n` +
    ` 1️⃣ Set stop loss at \`${fmtPrice(r.sl)}\` on Binance\n` +
    ` 2️⃣ Do not move stop LOWER under any circumstances\n` +
    ` 3️⃣ I'll alert you at TP1, TP2 or if signals break down`
  );

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Entered at market',      callback_data: `enter_market_${r.symbol}` },
        { text: '📝 Enter custom price',     callback_data: `enter_custom_${r.symbol}` },
      ],
      [
        { text: '❓ How to set stop loss',   callback_data: `help_sl_${r.symbol}`      },
        { text: '❌ Changed mind',           callback_data: `sig_skip_${r.symbol}`     },
      ],
    ],
  };

  return { text, inlineKeyboard: keyboard };
}

// ─── MILESTONE ALERTS ────────────────────────────────────────────────────────

function buildTP1Alert(trade, currentPrice) {
  const pnlPct  = ((currentPrice - trade.entry) / trade.entry * 100).toFixed(2);
  const pnlUSDT = (trade.sizeUSDT * parseFloat(pnlPct) / 100).toFixed(2);
  const newSL   = fmtPrice(trade.entry * 1.001);

  return {
    text: (
      `🎯 *TP1 HIT — ${trade.symbol}!*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Price reached \`${fmtPrice(currentPrice)}\`\n` +
      `You're up *+${pnlPct}%*  (+$${pnlUSDT})\n\n` +
      `*What to do now:*\n` +
      ` 1️⃣ Sell *50%* of your position\n` +
      ` 2️⃣ Move stop loss to: \`${newSL}\` (your entry)\n` +
      ` → Remaining 50% is now *risk-free*\n\n` +
      `*Remaining targets:*\n` +
      ` · TP2:  \`${fmtPrice(trade.tp2)}\`\n` +
      ` · Moon: \`${fmtPrice(trade.moon)}\``
    ),
    inlineKeyboard: {
      inline_keyboard: [
        [
          { text: '✅ Sold 50%, moved stop', callback_data: `tp1_done_${trade.id}` },
          { text: '🚀 Holding all in',       callback_data: `tp1_hold_${trade.id}` },
        ],
        [
          { text: '💰 Sold everything',      callback_data: `tp1_exit_${trade.id}` },
        ],
      ],
    },
  };
}

function buildWeakeningAlert(trade, reasons) {
  const newSL = fmtPrice(trade.entry * (trade.tp1Hit ? 1.001 : 0.9875));
  return {
    text: (
      `⚠️ *CAUTION — ${trade.symbol}* (Trade ${trade.id})\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Signals weakening:\n` +
      reasons.slice(0, 3).map(r => ` · ${r}`).join('\n') + '\n\n' +
      `*Not an exit yet — protect yourself:*\n` +
      ` · Tighten stop to: \`${newSL}\`\n` +
      (trade.tp1Hit ? ` · You're in profit — tightening is free insurance` : '')
    ),
    inlineKeyboard: {
      inline_keyboard: [
        [
          { text: `🔒 Tightened stop to ${newSL}`, callback_data: `weak_tighten_${trade.id}` },
          { text: '💰 Take partial profit',         callback_data: `weak_partial_${trade.id}` },
        ],
        [
          { text: '📊 Show full analysis',          callback_data: `weak_analysis_${trade.id}` },
        ],
      ],
    },
  };
}

function buildExitNowAlert(trade, reasons, currentPrice) {
  const pnlPct  = ((currentPrice - trade.entry) / trade.entry * 100).toFixed(2);
  const pnlUSDT = (trade.sizeUSDT * parseFloat(pnlPct) / 100).toFixed(2);
  const sign    = parseFloat(pnlPct) >= 0 ? '+' : '';

  return {
    text: (
      `🚨 *EXIT SIGNAL — ${trade.symbol}* (Trade ${trade.id})\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Structure broken:\n` +
      reasons.slice(0, 3).map(r => ` · ${r}`).join('\n') + '\n\n' +
      `Exit now at market: ~\`${fmtPrice(currentPrice)}\`\n` +
      `Your P&L: *${sign}${pnlPct}%*  (${sign}$${pnlUSDT})\n\n` +
      `_Protecting capital is always the right move._`
    ),
    inlineKeyboard: {
      inline_keyboard: [
        [
          { text: '✅ Exited',              callback_data: `exit_done_${trade.id}`    },
          { text: '⏳ Give 15 min more',   callback_data: `exit_wait_${trade.id}`    },
        ],
        [
          { text: '❓ Explain why',        callback_data: `exit_explain_${trade.id}` },
        ],
      ],
    },
  };
}

function buildSLHitAlert(trade) {
  return {
    text: (
      `🛑 *STOP HIT — ${trade.symbol}* (Trade ${trade.id})\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Price reached your stop: \`${fmtPrice(trade.sl)}\`\n` +
      `Loss: *${trade.pnlPct}%*  (-$${Math.abs(trade.pnlUSDT ?? 0).toFixed(2)})\n\n` +
      `✅ *This is within your risk plan. It's normal.*\n\n` +
      `Even a 40% win rate is profitable with good R:R.\n` +
      `Your next trade is waiting.`
    ),
    inlineKeyboard: {
      inline_keyboard: [
        [
          { text: '📊 Post-trade debrief', callback_data: `debrief_${trade.id}` },
          { text: '🔄 Find next signal',   callback_data: 'scan_now'            },
        ],
      ],
    },
  };
}

// ─── BROADCASTER ─────────────────────────────────────────────────────────────

/**
 * Determine which users should receive a signal and in what form.
 * Returns array of { userId, isWatched, alertType: 'signal'|'accumulation' }
 */
function getEligibleUsers(r) {
  const profiles  = getAllProfiles();
  const grade     = scoreToGrade(r.instGrade?.iScore ?? 50);
  const watchers  = new Set(getUsersWatchingSymbol(r.symbol));
  const isAccum   = isAccumulationSetup(r);
  const recipients = [];

  for (const [userId, profile] of Object.entries(profiles)) {
    if (!profile.onboarded) continue;
    if (!isUserActive(userId)) continue;

    const isWatched = watchers.has(userId);

    // For accumulation alerts: send to watchers always, others only if grade B+
    if (isAccum) {
      if (!isWatched && grade === 'C') continue;
      const snapshot   = getPortfolioSnapshot(userId);
      const alreadyOpen = snapshot.openTrades.some(t => t.symbol === r.symbol);
      if (alreadyOpen) continue;
      recipients.push({ userId, isWatched, alertType: 'accumulation' });
      continue;
    }

    // Trade signals: standard grade filter
    if (!shouldReceiveSignal(userId, grade)) {
      if (!isWatched) continue;
    }
    const snapshot   = getPortfolioSnapshot(userId);
    const alreadyOpen = snapshot.openTrades.some(t => t.symbol === r.symbol);
    if (alreadyOpen) continue;

    recipients.push({ userId, isWatched, alertType: 'signal' });
  }

  return recipients;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return 'N/A';
  if (n < 0.001)  return n.toFixed(8);
  if (n < 0.01)   return n.toFixed(6);
  if (n < 1)      return n.toFixed(5);
  if (n >= 1000)  return n.toFixed(2);
  return n.toFixed(4);
}

function buildTimeline(r) {
  const exp = r.expansion?.expansionTypeKey ?? 'CONTROLLED';
  const map = {
    MICRO     : '30min–4h',
    CONTROLLED: '1h–8h',
    STRONG    : '30min–6h',
    DELAYED   : '4h–48h',
    MOON      : '2h–24h',
  };
  return map[exp] ?? '1h–12h';
}

/**
 * Simple capacity check without importing riskEngine (avoids circular dep).
 * Returns { allowed: boolean, reason: string }
 */
function _checkCapacity(userId, snapshot) {
  const { getAllProfiles } = require('./userProfile');
  const profiles = getAllProfiles();
  const profile  = profiles[String(userId)];
  if (!profile) return { allowed: false, reason: 'Profile not found' };
  const max = profile.maxTrades ?? 3;
  if (snapshot.openTrades.length >= max) {
    return { allowed: false, reason: `Max trades reached (${max})` };
  }
  return { allowed: true, reason: 'OK' };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  scoreToGrade,
  isAccumulationSetup,
  buildSignalAlert,
  buildAccumulationAlert,
  buildEntryPlan,
  buildTP1Alert,
  buildWeakeningAlert,
  buildExitNowAlert,
  buildSLHitAlert,
  getEligibleUsers,
  fmtPrice,
};
