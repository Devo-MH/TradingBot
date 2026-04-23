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
const { buildCorrelationWarning }                                               = require('./correlationCheck');

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
 * Build the VWAP line — shows 24h VWAP and whether price is above/below.
 * vwap is passed in via extras after being fetched in broadcastSignal.
 */
function buildVWAPLine(r, vwap) {
  const v = vwap ?? r.fbCheck?.vwap;
  if (!v || !r.entry) return null;
  const above = r.entry >= v;
  const arrow = above ? '▲' : '▼';
  const label = above ? 'Above VWAP ✅' : 'Below VWAP ⚠️';
  return `📍 VWAP: \`${fmtPrice(v)}\`  ${arrow} ${label}`;
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
 * CVD line — shows intent, rise speed type, and the CVD vs price note.
 * Uses volIntent object from scanner when available (most accurate).
 */
function buildCVDLine(r) {
  const vi   = r.volIntent;  // full volIntent object from scanner
  const trap = r._instLayer?.mmTrap?.trap ?? false;

  if (trap) {
    return `⚠️ CVD: Price up but buying NOT confirming — *fake breakout risk*`;
  }

  // ── Use rich volIntent data when available ────────────────────────────────
  if (vi && typeof vi === 'object' && vi.intent) {
    const riseRatio = vi.volTrendRatio ?? 1;
    const riseType  = riseRatio > 1.5 ? '🔥 Sudden'
      : riseRatio > 1.1 ? '📈 Fast'
      : riseRatio < 0.8 ? '📉 Declining'
      : '➡️ Steady';

    const intentEmoji = vi.emoji ?? '⚪';
    const cvdNote = vi.cvdNote ? ` — ${vi.cvdNote}` : '';

    return `${intentEmoji} CVD: *${vi.intent}* | Rise: *${riseType}*${cvdNote}`;
  }

  // ── Fallback: derive from _instLayer ─────────────────────────────────────
  const cvd        = extractCVD(r);
  const flowType   = r._instLayer?.hiddenFlow?.type;
  const volRatio   = parseFloat(r.volRatio ?? 0);
  const absorption = absorptionFromHiddenFlow(r);

  if (flowType === 'HIDDEN_BUYER') {
    if (volRatio < 1.2) return `📈 CVD: Price flat — CVD rising *steadily* — hidden accumulation`;
    if (absorption >= 80) return `📈 CVD: Rising *fast* alongside volume — strong buying confirmed`;
    return `📈 CVD: Bullish — buying pressure building`;
  }
  if (flowType === 'HIDDEN_SELLER') {
    return `⚠️ CVD: Rising price — CVD falling — distribution warning`;
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

// ─── SETUP CLASSIFIER ────────────────────────────────────────────────────────

/**
 * Classifies the setup type and timing urgency using the Pump Detection Guide rules.
 *
 * Priority order:
 *   1. Distribution Warning  (high vol + falling CVD → danger)
 *   2. Stealth Accumulation  (low vol + hidden buyer → patience)
 *   3. Fast Move             (golden combo → act now)
 *   4. Delayed Explosion     (building → entry window open)
 *   5. Moon Setup            (moonData pattern → long hold)
 *   6. Standard              (default)
 *
 * Returns { type, label, timing, urgency, note }
 */
function classifySetup(r) {
  const volRatio   = parseFloat(r.volZ?.ratio ?? r.volRatio ?? 1);
  const intent     = r.volIntent?.intent ?? '';
  const flowRatio  = parseFloat(r.lf?.flowRatio ?? r._raw?.lf?.flowRatio ?? 0);
  const energy     = parseFloat(r.candleEnergy ?? r._raw?.candleEnergy ?? r._raw?.expansion?.candleEnergy ?? 0);
  const trigDist   = parseFloat(r.triggerDistance ?? r.breakoutDistance ?? 99);
  const mmTrap     = r._instLayer?.mmTrap?.trap ?? false;
  const hiddenSell = r._instLayer?.hiddenFlow?.type === 'HIDDEN_SELLER';
  const hiddenBuy  = r._instLayer?.hiddenFlow?.type === 'HIDDEN_BUYER';
  const bullishCVD = intent === 'BULLISH' || hiddenBuy || intent.includes('ACCUM');

  // 1. Distribution Warning — highest priority, flag before anything else
  if (mmTrap || (volRatio >= 1.5 && hiddenSell)) {
    return {
      type: 'DISTRIBUTION', label: '⚠️ Distribution Warning',
      timing: null, urgency: 'DANGER',
      note: 'High vol + falling CVD — possible sell trap',
    };
  }

  // 2. Stealth Accumulation — low vol + hidden buyer = whale phase
  if (volRatio < 1.2 && (hiddenBuy || intent.includes('ACCUM'))) {
    return {
      type: 'STEALTH_ACCUM', label: '🕵️ Stealth Accumulation',
      timing: '4h–24h', urgency: 'LOW',
      note: 'Whales accumulating quietly — no rush to enter',
    };
  }

  // 3. Fast Move — golden combination: high vol + CVD + flow + near breakout
  const nearBreakout = trigDist <= 1.0;
  const highVol      = volRatio >= 2;
  const strongFlow   = flowRatio >= 1.5;
  const activeEnergy = energy >= 6;
  const goldenCount  = [highVol, bullishCVD, strongFlow, nearBreakout].filter(Boolean).length;

  if (goldenCount >= 3 && activeEnergy) {
    return {
      type: 'FAST_MOVE', label: '⚡ Fast Move',
      timing: '15min–2h', urgency: 'HIGH',
      note: 'Golden combo active — move likely imminent',
    };
  }

  // 3b. Fast Move without full golden combo but vol + CVD align near breakout
  if (volRatio >= 1.5 && bullishCVD && nearBreakout) {
    return {
      type: 'FAST_MOVE', label: '⚡ Fast Move',
      timing: '15min–2h', urgency: 'HIGH',
      note: 'Volume + CVD aligned at breakout zone',
    };
  }

  // 4. Delayed Explosion — decent vol + CVD but not yet at breakout or energy low
  if (volRatio >= 1.2 && bullishCVD) {
    return {
      type: 'DELAYED', label: '💣 Delayed Explosion',
      timing: '2h–12h', urgency: 'MEDIUM',
      note: 'Building momentum — entry window open',
    };
  }

  // 5. Moon Setup — moonData or expansion pattern present
  if (r.moonData || r._raw?.moonData) {
    return {
      type: 'MOON', label: '🌕 Moon Setup',
      timing: '4h–24h', urgency: 'LOW',
      note: 'Longer hold expected — use wider stops',
    };
  }

  // 6. Default
  return {
    type: 'STANDARD', label: '📊 Standard Setup',
    timing: '1h–12h', urgency: 'MEDIUM',
    note: 'Moderate conditions — wait for confirmation',
  };
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

  const iRow     = buildIndicatorRow(r);
  const dRow     = buildDepthRow(r);
  const cvdLine  = buildCVDLine(r);
  const obWarn   = buildOBWarning(r);
  const vwapLine = buildVWAPLine(r, extras.vwap);
  const setup    = classifySetup(r);
  const setupLine = setup.timing
    ? `⏱ ${setup.label} — est. ${setup.timing} · ${setup.note}`
    : `${setup.label} · ${setup.note}`;

  // R:R ratio
  const rrRatio = r.sl && r.tp1 && r.entry
    ? ((r.tp1 - r.entry) / (r.entry - r.sl))
    : null;
  const rrLine = rrRatio != null
    ? `📐 R:R 1:${rrRatio.toFixed(1)} · Risk ${((r.entry - r.sl) / r.entry * 100).toFixed(1)}% → Reward +${((r.tp1 - r.entry) / r.entry * 100).toFixed(0)}%`
    : null;

  // Entry zone (±0.3% or half ATR% if available)
  const atrPct    = parseFloat(r.atrPct ?? r.instGrade?.atrPct ?? 0);
  const zoneHalf  = atrPct > 0 ? r.entry * (atrPct / 200) : r.entry * 0.003;
  const zoneLine  = r.entry
    ? `📍 Entry zone: \`${fmtPrice(r.entry - zoneHalf)}\` – \`${fmtPrice(r.entry + zoneHalf)}\``
    : null;

  // Correlation warning
  const snapshot2      = getPortfolioSnapshot(userId);
  const correlationWarn = buildCorrelationWarning(r.symbol, snapshot2.openTrades);

  // Market regime line from extras
  const regimeLine = extras.regime ? `${extras.regime}` : null;

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
    iRow     ? `📊  ${iRow}` : null,
    dRow     ? `💧  ${dRow}` : null,
    vwapLine || null,
    cvdLine,
    setupLine,
    regimeLine,
    ``,
    zoneLine,
    r.sl && r.tp1
      ? `🎯  SL: \`${fmtPrice(r.sl)}\` *(${slPct})*  TP1: \`${fmtPrice(r.tp1)}\` *(${tp1Pct})*  TP2: \`${fmtPrice(r.tp2)}\` *(${tp2Pct})*  🌕 \`${fmtPrice(r.moonPrice)}\` *(${moonPct})*`
      : null,
    rrLine,
    confirmLine || null,
    ``,
    extras.newsSummary   || null,
    extras.rotationLine  || null,
    correlationWarn      || null,
    ``,
    capacity.allowed && sizes
      ? `💰 Size: *~$${sizes.recommended}*  (cons: $${sizes.conservative}  |  agg: $${sizes.aggressive})`
      : `⚠️ ${capacity.reason}`,
  ].filter(l => l !== null).join('\n');

  const keyboard = capacity.allowed
    ? {
        inline_keyboard: [
          [
            { text: '⚡ Quick Summary',   callback_data: `sig_quick_${r.symbol}`    },
            { text: '📊 Full Analysis',   callback_data: `sig_full_${r.symbol}`     },
          ],
          [
            { text: '🔰 Beginner Guide',  callback_data: `sig_beginner_${r.symbol}` },
            { text: '👀 Watch it',        callback_data: `sig_watch_${r.symbol}`    },
          ],
          [
            { text: '✅ Enter trade',     callback_data: `sig_enter_${r.symbol}`    },
            { text: '❌ Skip',            callback_data: `sig_skip_${r.symbol}`     },
          ],
        ],
      }
    : {
        inline_keyboard: [[
          { text: '🔰 Beginner Guide',    callback_data: `sig_beginner_${r.symbol}` },
          { text: '📊 View Analysis',     callback_data: `sig_full_${r.symbol}`     },
          { text: '👀 Watch it',          callback_data: `sig_watch_${r.symbol}`    },
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

// ─── BEGINNER GUIDE ──────────────────────────────────────────────────────────

/**
 * Full beginner-friendly signal breakdown.
 * Zero jargon. One clear action. Dollar amounts. Exact steps.
 */
function buildBeginnerGuide(r, extras = {}, userId = null) {
  const iScore     = r.instGrade?.iScore ?? 50;
  const grade      = scoreToGrade(iScore);
  const verdict    = r._instLayer?.verdict?.verdict ?? 'WATCH';
  const mmTrap     = r._instLayer?.mmTrap?.trap ?? false;
  const absorption = absorptionFromHiddenFlow(r);
  const volRatio   = parseFloat(r.volZ?.ratio ?? r.volRatio ?? 1);
  const setup      = classifySetup(r);
  const sizes      = userId ? calcPositionSizes(userId) : null;
  const vwap       = extras.vwap ?? r.fbCheck?.vwap;

  // ── Confidence stars ─────────────────────────────────────────────────────
  const stars = iScore >= 80 ? '⭐⭐⭐⭐⭐'
    : iScore >= 65            ? '⭐⭐⭐⭐'
    : iScore >= 45            ? '⭐⭐⭐'
    : '⭐⭐';

  // ── Single clear action ───────────────────────────────────────────────────
  let action, actionEmoji, actionReason;

  if (mmTrap) {
    action      = 'SKIP THIS';
    actionEmoji = '🚫';
    actionReason = 'This looks like a fake move. Big players may be tricking buyers into entering before the price drops. Not worth the risk.';
  } else if (verdict === 'AVOID') {
    action      = 'SKIP THIS';
    actionEmoji = '🚫';
    actionReason = 'Too many signals are conflicting. The bot cannot confidently say this will go up. Skip and wait for a cleaner setup.';
  } else if (verdict === 'WAIT' || setup.type === 'STEALTH_ACCUM') {
    action      = 'WATCH — NOT YET';
    actionEmoji = '👁';
    actionReason = 'The setup is forming but not ready. Big players are accumulating quietly. Add to watchlist — the bot will notify you when the right moment arrives.';
  } else if (grade === 'A+' || grade === 'A') {
    action      = 'YOU CAN BUY';
    actionEmoji = '✅';
    actionReason = grade === 'A+'
      ? 'This is a strong setup. Volume is high, big players are buying, and the timing looks good.'
      : 'This is a good setup with solid signals. Not perfect, but the conditions favor a move up.';
  } else {
    action      = 'SMALL ENTRY OK';
    actionEmoji = '🟡';
    actionReason = 'Decent setup but not the strongest. If you want to enter, use a smaller amount than usual and be ready to exit quickly.';
  }

  // ── Plain-English market reading ──────────────────────────────────────────
  const readings = [];

  // Volume
  if (volRatio >= 3) {
    readings.push(`Volume: *${volRatio.toFixed(1)}x higher than normal* — a lot of people are suddenly interested in this coin right now.`);
  } else if (volRatio >= 1.5) {
    readings.push(`Volume: *${volRatio.toFixed(1)}x above normal* — more buyers than usual are stepping in.`);
  } else {
    readings.push(`Volume: *Normal* — no big surge yet. The move may be slower to develop.`);
  }

  // Smart money / CVD
  if (mmTrap) {
    readings.push(`Big players: *Selling quietly* — while price looks like it's going up, the actual buying pressure is falling. Classic trap.`);
  } else if (absorption >= 80) {
    readings.push(`Big players: *Heavy buying (${absorption}/100)* — institutions are absorbing supply. This often happens right before a big move.`);
  } else if (absorption >= 50) {
    readings.push(`Big players: *Moderate buying (${absorption}/100)* — some institutional interest detected.`);
  } else {
    readings.push(`Big players: *Neutral* — no clear signal of large player activity.`);
  }

  // VWAP (in plain English)
  if (vwap && r.entry) {
    const aboveVwap = r.entry >= vwap;
    readings.push(aboveVwap
      ? `Price position: *Above the 24h average price* — momentum is on your side.`
      : `Price position: *Below the 24h average price* — price hasn't fully recovered yet. Wait for it to cross above for a stronger entry.`
    );
  }

  // Timing
  if (setup.timing) {
    readings.push(`Expected move: *${setup.timing}* — ${setup.note}.`);
  }

  // Market regime
  if (extras.regime) {
    readings.push(`Overall market: ${extras.regime}`);
  }

  // ── Risk in dollar terms ─────────────────────────────────────────────────
  let moneyBlock = null;
  if (sizes && r.entry && r.sl && r.tp1) {
    const riskAmt   = (sizes.recommended * ((r.entry - r.sl) / r.entry)).toFixed(0);
    const rewardAmt = (sizes.recommended * ((r.tp1 - r.entry) / r.entry)).toFixed(0);
    const rrRatio   = ((r.tp1 - r.entry) / (r.entry - r.sl)).toFixed(1);
    moneyBlock = (
      `With *$${sizes.recommended}* invested:\n` +
      ` · If stop hits → you lose *$${riskAmt}*\n` +
      ` · If TP1 hits → you gain *+$${rewardAmt}*\n` +
      ` · For every $1 risked, possible gain: $${rrRatio}`
    );
  }

  // ── Exact steps ──────────────────────────────────────────────────────────
  let steps = null;
  if (action !== 'SKIP THIS' && action !== 'WATCH — NOT YET' && r.entry && r.sl && r.tp1) {
    const sizeLabel = sizes ? `$${sizes.recommended}` : 'your planned amount';
    steps = (
      `*What to do — step by step:*\n` +
      ` 1️⃣ Buy *${sizeLabel}* worth of ${r.symbol.replace('USDT', '')} at around \`${fmtPrice(r.entry)}\`\n` +
      ` 2️⃣ Immediately set a stop loss at \`${fmtPrice(r.sl)}\` — this is your safety net\n` +
      ` 3️⃣ When price hits \`${fmtPrice(r.tp1)}\`, sell *half* of your coins and move stop to your entry price\n` +
      ` 4️⃣ Let the remaining half run to \`${fmtPrice(r.tp2 ?? r.tp1)}\`\n` +
      ` 5️⃣ If price drops to your stop before hitting TP1 — exit. That's your plan working correctly.`
    );
  } else if (action === 'WATCH — NOT YET') {
    steps = (
      `*What to do:*\n` +
      ` 1️⃣ Tap "👀 Watch it" to add this coin to your watchlist\n` +
      ` 2️⃣ The bot will alert you automatically when the entry moment arrives\n` +
      ` 3️⃣ Do NOT enter now — wait for the alert`
    );
  }

  const lines = [
    `🔰 *Beginner Guide — ${r.symbol}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Confidence: ${stars}  (${iScore}/100)`,
    ``,
    `${actionEmoji} *Action: ${action}*`,
    actionReason,
    ``,
    `*What's happening right now:*`,
    ...readings.map(l => ` · ${l}`),
    ``,
    moneyBlock,
    ``,
    steps,
    ``,
    `_Never invest money you can't afford to lose. Always set a stop loss._`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

// ─── SIMPLE EXPLANATION (for end users) ──────────────────────────────────────

/**
 * Builds a jargon-free explanation of the signal with a plain recommendation.
 * Designed for users who don't know technical analysis.
 */
function buildExplainMessage(r, extras = {}) {
  const grade      = scoreToGrade(r.instGrade?.iScore ?? 50);
  const iScore     = r.instGrade?.iScore ?? 50;
  const verdict    = r._instLayer?.verdict?.verdict ?? 'WATCH';
  const absorption = absorptionFromHiddenFlow(r);
  const cvd        = extractCVD(r);
  const mmTrap     = r._instLayer?.mmTrap?.trap ?? false;
  const vwap       = extras.vwap ?? r.fbCheck?.vwap;
  const volRatio   = parseFloat(r.volRatio ?? r.volZ?.ratio ?? 1);

  // Risk rating
  const riskLevel = mmTrap                   ? '🔴 HIGH — possible fake move'
    : grade === 'A+' || grade === 'A'        ? '🟢 LOW — clean signal'
    : grade === 'B'                          ? '🟡 MEDIUM — decent setup'
    : '🟠 MEDIUM-HIGH — weaker signal';

  // What is happening
  let happening;
  if (mmTrap) {
    happening = 'Warning: the price is moving up but the real buying pressure is NOT following. This can be a fake breakout designed to trap buyers. Be very careful.';
  } else if (absorption >= 70) {
    happening = `Large institutions are quietly buying this coin (${absorption}/100 confidence). The price hasn't exploded yet, but the smart money is accumulating. This often happens before a big move up.`;
  } else if (cvd.direction === 'BULLISH') {
    happening = 'More buyers than sellers are entering this coin right now. The buying pressure is real and confirmed by volume data.';
  } else {
    happening = 'Technical patterns suggest a potential upward move. The score is moderate — treat this as a watchlist candidate.';
  }

  // VWAP context
  const vwapLine = vwap
    ? `• VWAP (24h fair price): \`${fmtPrice(vwap)}\` — price is ${r.entry >= vwap ? '*above* ✅ (momentum in your favor)' : '*below* ⚠️ (price under average — wait for reclaim)'}`
    : null;

  // Volume context
  const volLine = volRatio >= 2
    ? `• Volume: *${volRatio.toFixed(1)}x* above normal — unusual surge in activity`
    : volRatio >= 1.5
    ? `• Volume: ${volRatio.toFixed(1)}x above normal — buyers stepping in`
    : `• Volume: Normal — no unusual surge yet`;

  // Absorption
  const absLine = absorption >= 50
    ? `• Smart money: ${absorption}/100 — ${absorption >= 80 ? 'heavy institutional buying detected' : 'moderate institutional interest'}`
    : null;

  // Setup type
  const setup     = classifySetup(r);
  const setupLine2 = setup.timing
    ? `• Setup type: ${setup.label} — est. ${setup.timing} · ${setup.note}`
    : `• Setup type: ${setup.label} · ${setup.note}`;

  // Recommendation
  let recommend;
  if (mmTrap || verdict === 'AVOID') {
    recommend = `🚫 *Skip this trade.* The signal has a high-risk pattern (possible fake move). Wait for the next clean setup.`;
  } else if (verdict === 'WAIT') {
    recommend = `⏳ *Not yet.* The setup is forming but not ready. Add it to your watchlist and wait for the bot to alert you when it triggers.`;
  } else {
    const slPct = r.sl && r.entry ? ((r.entry - r.sl) / r.entry * 100).toFixed(1) : '?';
    recommend = (
      `✅ *You can consider entering.*\n` +
      ` 1. Buy a small amount at around \`${fmtPrice(r.entry)}\`\n` +
      ` 2. Set your stop loss at \`${fmtPrice(r.sl)}\` (-${slPct}%) — *this is your safety net*\n` +
      ` 3. Take half profit at \`${fmtPrice(r.tp1)}\` — lock in gains\n` +
      ` 4. Let the rest run to \`${fmtPrice(r.tp2)}\` or beyond`
    );
  }

  const lines = [
    `💡 *Simple Explanation — ${r.symbol}*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🔍 *What's happening:*`,
    happening,
    ``,
    `📊 *Key signals explained:*`,
    volLine,
    absLine,
    vwapLine,
    setupLine2,
    ``,
    `📋 *My recommendation:*`,
    recommend,
    ``,
    `⚠️ *Risk level:* ${riskLevel}`,
    `_Always set your stop loss. Never risk more than you're comfortable losing._`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  scoreToGrade,
  isAccumulationSetup,
  classifySetup,
  buildSignalAlert,
  buildAccumulationAlert,
  buildEntryPlan,
  buildBeginnerGuide,
  buildExplainMessage,
  buildTP1Alert,
  buildWeakeningAlert,
  buildExitNowAlert,
  buildSLHitAlert,
  getEligibleUsers,
  fmtPrice,
};
