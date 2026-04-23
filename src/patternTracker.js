'use strict';

/**
 * Pattern Tracker
 *
 * Every time the scanner fires a signal for a symbol, we store a snapshot
 * of its key indicators. When the same symbol appears again, we compare
 * the new snapshot against all previous ones and report whether the setup
 * is strengthening, weakening, or just noise.
 *
 * Tracked indicators:
 *   - score      (instGrade.iScore)
 *   - obRatio    (orderBook.ratio)
 *   - tsmom
 *   - atrPct
 *   - volRatio   (volZ.ratio or volRatio)
 *   - cvdIntent  (volIntent.intent)
 *   - entry price
 *
 * Storage: in-memory map (resets on bot restart).
 * Window: last 24h only — older snapshots are pruned automatically.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_SNAPS = 10;                   // max snapshots per symbol

// symbol → [ { ts, score, obRatio, tsmom, atrPct, volRatio, cvdIntent, entry } ]
const _store = new Map();

// ─── SNAPSHOT ─────────────────────────────────────────────────────────────────

function _extract(r) {
  return {
    ts        : Date.now(),
    score     : r.instGrade?.iScore ?? r.score ?? null,
    obRatio   : r.orderBook?.ratio ?? r.instGrade?.obRatio ?? null,
    tsmom     : r.tsmom ?? r.instGrade?.tsmom ?? null,
    atrPct    : parseFloat(r.atrPct ?? r.instGrade?.atrPct ?? 0) || null,
    volRatio  : parseFloat(r.volZ?.ratio ?? r.volRatio ?? 0) || null,
    cvdIntent : r.volIntent?.intent ?? r._instLayer?.hiddenFlow?.type ?? null,
    entry     : r.entry ?? null,
  };
}

function _prune(snaps) {
  const cutoff = Date.now() - WINDOW_MS;
  return snaps.filter(s => s.ts > cutoff).slice(-MAX_SNAPS);
}

// ─── RECORD ───────────────────────────────────────────────────────────────────

/**
 * Record a new signal snapshot for a symbol.
 * Returns the full snapshot list for this symbol (after recording).
 */
function record(r) {
  const sym   = r.symbol;
  const snap  = _extract(r);
  const prior = _prune(_store.get(sym) ?? []);
  prior.push(snap);
  _store.set(sym, prior);
  return prior;
}

// ─── COMPARE ──────────────────────────────────────────────────────────────────

/**
 * Compare the latest snapshot against the previous one.
 * Returns null if this is the first appearance.
 * Returns a comparison object with per-indicator deltas and an overall verdict.
 */
function compare(r) {
  const sym   = r.symbol;
  const snaps = _store.get(sym) ?? [];
  if (snaps.length < 2) return null;

  const prev = snaps[snaps.length - 2];
  const curr = snaps[snaps.length - 1];
  const timeDiff = Math.round((curr.ts - prev.ts) / 60000); // minutes

  const indicators = [];
  let improvements = 0;
  let regressions  = 0;

  function _delta(label, prev, curr, higherIsBetter = true, fmt = v => v?.toFixed(2) ?? '?') {
    if (prev == null || curr == null) return;
    const diff = curr - prev;
    const pct  = prev !== 0 ? ((diff / Math.abs(prev)) * 100).toFixed(0) : null;
    const improved = higherIsBetter ? diff > 0.05 : diff < -0.05;
    const regressed = higherIsBetter ? diff < -0.05 : diff > 0.05;
    const arrow = improved ? '✅' : regressed ? '⚠️' : '➡️';
    if (improved) improvements++;
    if (regressed) regressions++;
    indicators.push({
      label,
      prev : fmt(prev),
      curr : fmt(curr),
      pct,
      arrow,
      improved,
      regressed,
    });
  }

  _delta('Score',    prev.score,    curr.score,    true,  v => v?.toFixed(0) ?? '?');
  _delta('OB Ratio', prev.obRatio,  curr.obRatio,  true,  v => v != null ? v.toFixed(2) + 'x' : '?');
  _delta('TSMOM',    prev.tsmom,    curr.tsmom,    true,  v => v?.toFixed(2) ?? '?');
  _delta('Volume',   prev.volRatio, curr.volRatio, true,  v => v != null ? v.toFixed(2) + 'x' : '?');
  _delta('ATR%',     prev.atrPct,   curr.atrPct,   false, v => v != null ? v.toFixed(2) + '%' : '?');

  // CVD intent change
  const cvdChanged = prev.cvdIntent !== curr.cvdIntent;
  const cvdImproved = (
    (curr.cvdIntent === 'BULLISH' && prev.cvdIntent !== 'BULLISH') ||
    (curr.cvdIntent === 'HIDDEN_BUYER' && prev.cvdIntent !== 'HIDDEN_BUYER')
  );
  const cvdWorsened = (
    curr.cvdIntent === 'HIDDEN_SELLER' || curr.cvdIntent === 'BEARISH'
  );
  if (cvdChanged) {
    if (cvdImproved) improvements++;
    if (cvdWorsened) regressions++;
    indicators.push({
      label    : 'CVD',
      prev     : prev.cvdIntent ?? '?',
      curr     : curr.cvdIntent ?? '?',
      pct      : null,
      arrow    : cvdImproved ? '✅' : cvdWorsened ? '⚠️' : '➡️',
      improved : cvdImproved,
      regressed: cvdWorsened,
    });
  }

  // Price movement between signals
  const priceMoved = prev.entry && curr.entry
    ? ((curr.entry - prev.entry) / prev.entry * 100).toFixed(2)
    : null;

  // Verdict
  const total = indicators.length;
  let verdict, urgency;

  if (improvements >= 3 && regressions === 0) {
    verdict = 'STRONG_IMPROVEMENT';
    urgency = 'HIGH';
  } else if (improvements >= 2 && regressions <= 1) {
    verdict = 'IMPROVING';
    urgency = 'MEDIUM';
  } else if (regressions >= 2) {
    verdict = 'WEAKENING';
    urgency = 'LOW';
  } else if (improvements === 0 && regressions === 0) {
    verdict = 'NO_CHANGE';
    urgency = 'LOW';
  } else {
    verdict = 'MIXED';
    urgency = 'MEDIUM';
  }

  return {
    symbol      : r.symbol,
    appearance  : snaps.length,
    timeDiff,
    priceMoved,
    indicators,
    improvements,
    regressions,
    verdict,
    urgency,
  };
}

// ─── FORMAT ───────────────────────────────────────────────────────────────────

/**
 * Build a Telegram message summarising the pattern comparison.
 * Returns null if this is the first appearance (nothing to compare yet).
 */
function buildPatternUpdate(r) {
  const snaps = _store.get(r.symbol) ?? [];
  if (snaps.length < 2) return null;

  const cmp = compare(r);
  if (!cmp) return null;

  // Only send if there's something meaningful to say
  if (cmp.verdict === 'NO_CHANGE') return null;

  const verdictLine = {
    STRONG_IMPROVEMENT: `✅ *STRONG IMPROVEMENT — all indicators rising*\nThis is not noise. Setup is validating consistently.`,
    IMPROVING         : `📈 *IMPROVING — indicators building*\nSetup is strengthening. Watch for entry.`,
    WEAKENING         : `⚠️ *WEAKENING — indicators fading*\nShort-term blip only. Do not chase — wait or skip.`,
    MIXED             : `➡️ *MIXED — some up, some down*\nNo clear confirmation yet. Wait for next scan.`,
  }[cmp.verdict] ?? `➡️ Setup unchanged.`;

  const timeLabel = cmp.timeDiff < 60
    ? `${cmp.timeDiff}m apart`
    : `${Math.round(cmp.timeDiff / 60)}h apart`;

  const priceMovedLine = cmp.priceMoved != null
    ? `Price moved: ${cmp.priceMoved >= 0 ? '+' : ''}${cmp.priceMoved}% between signals`
    : null;

  // Build indicator table
  const rows = cmp.indicators.map(ind => {
    const pctStr = ind.pct != null ? ` (${ind.pct >= 0 ? '+' : ''}${ind.pct}%)` : '';
    return `${ind.arrow} ${ind.label.padEnd(9)} ${String(ind.prev).padEnd(8)} → ${ind.curr}${pctStr}`;
  });

  const lines = [
    `🔄 *${r.symbol} — Signal #${cmp.appearance}* _(${timeLabel})_`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    verdictLine,
    ``,
    `\`Indicator  Before   → Now\``,
    ...rows.map(row => `\`${row}\``),
    priceMovedLine,
    ``,
    `_${cmp.improvements} improving · ${cmp.regressions} weakening · ${cmp.appearance} appearances in 24h_`,
  ].filter(l => l !== null).join('\n');

  return { text: lines, verdict: cmp.verdict, urgency: cmp.urgency };
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = { record, compare, buildPatternUpdate };
