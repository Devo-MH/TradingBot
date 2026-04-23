'use strict';

/**
 * Signal History
 *
 * Records every broadcast signal and tracks its outcome:
 *   PENDING  → waiting to resolve
 *   TP1_HIT  → price reached TP1 (partial win)
 *   TP2_HIT  → price reached TP2 (full win)
 *   SL_HIT   → price hit stop loss (loss)
 *   EXPIRED  → 7 days passed with no outcome
 *
 * The background resolver runs every 15 min and updates outcomes.
 * /report generates a summary of recent signals vs what happened.
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE     = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'signal_history.json');
const FEATURED_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'featured_history.json');
const MAX_AGE_DAYS  = 7;
const MAX_SIGNALS   = 1000;
const DEDUPE_WINDOW = 60 * 60 * 1000; // 1h — don't double-record same symbol

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { signals: [] };
}

function save(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ─── RECORD ──────────────────────────────────────────────────────────────────

function recordSignal(r, recipientIds = []) {
  if (!r?.symbol || !r?.entry) return;

  const data = load();
  const now  = Date.now();

  // Dedupe — skip if same symbol recorded within last hour
  const recent = data.signals.find(
    s => s.symbol === r.symbol && (now - s.timestamp) < DEDUPE_WINDOW
  );
  if (recent) return;

  const grade = _scoreToGrade(r.instGrade?.iScore ?? r.score ?? 50);

  data.signals.push({
    id         : `${r.symbol}_${now}`,
    symbol     : r.symbol,
    entry      : r.entry,
    sl         : r.sl   ?? null,
    tp1        : r.tp1  ?? null,
    tp2        : r.tp2  ?? null,
    moon       : r.moonPrice ?? r.moon ?? null,
    grade,
    score      : r.instGrade?.iScore ?? r.score ?? 50,
    timestamp  : now,
    outcome    : 'PENDING',
    exitPrice  : null,
    maxReached : r.entry,
    resolvedAt : null,
    recipients : recipientIds,
  });

  // Trim to cap
  if (data.signals.length > MAX_SIGNALS) {
    data.signals = data.signals.slice(-MAX_SIGNALS);
  }
  save(data);
}

// ─── RESOLVE ─────────────────────────────────────────────────────────────────

function getPendingSignals() {
  return load().signals.filter(s => s.outcome === 'PENDING' || s.outcome === 'TP1_HIT');
}

function resolveSignal(id, outcome, exitPrice) {
  const data = load();
  const sig  = data.signals.find(s => s.id === id);
  if (!sig) return;
  sig.outcome    = outcome;
  sig.exitPrice  = exitPrice;
  sig.resolvedAt = Date.now();
  save(data);
}

function updateMaxReached(id, price) {
  const data = load();
  const sig  = data.signals.find(s => s.id === id);
  if (!sig) return;
  if (price > (sig.maxReached ?? 0)) {
    sig.maxReached = price;
    save(data);
  }
}

// ─── REPORT ──────────────────────────────────────────────────────────────────

function buildReport(limit = 50) {
  const data       = load();
  const allSignals = data.signals;

  if (!allSignals.length) {
    return '📊 *Signal Report*\n\nNo signals recorded yet. The bot will start tracking from now.';
  }

  // Stats calculated from ALL stored signals for accuracy
  const allResolved = allSignals.filter(s => ['TP1_HIT', 'TP2_HIT', 'SL_HIT'].includes(s.outcome));
  const allWins     = allResolved.filter(s => s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT');
  const allLosses   = allResolved.filter(s => s.outcome === 'SL_HIT');
  const winRate     = allResolved.length > 0 ? ((allWins.length / allResolved.length) * 100).toFixed(0) : '—';

  const avgWinPct = allWins.length > 0
    ? (allWins.reduce((sum, s) => {
        const pct = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : 0;
        return sum + pct;
      }, 0) / allWins.length).toFixed(1)
    : '—';

  const avgLossPct = allLosses.length > 0
    ? (allLosses.reduce((sum, s) => {
        const pct = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : 0;
        return sum + pct;
      }, 0) / allLosses.length).toFixed(1)
    : '—';

  // Display slice — most recent first
  const display = (limit === 0 ? allSignals : allSignals.slice(-limit)).reverse();

  // Per-signal lines
  const lines = display.map(s => {
    const age      = _ageLabel(s.timestamp);
    const priceFmt = _fmt(s.entry);

    if (s.outcome === 'TP2_HIT') {
      const pct = s.exitPrice ? `+${((s.exitPrice - s.entry) / s.entry * 100).toFixed(1)}%` : '';
      return `🏆 \`${s.symbol}\` @${priceFmt}  TP2 ✅✅  ${pct}  _(${age})_`;
    }
    if (s.outcome === 'TP1_HIT') {
      const pct = s.tp1 ? `+${((s.tp1 - s.entry) / s.entry * 100).toFixed(1)}%` : '';
      return `✅ \`${s.symbol}\` @${priceFmt}  TP1 hit  ${pct}  _(${age})_`;
    }
    if (s.outcome === 'SL_HIT') {
      const pct = s.sl ? `-${((s.entry - s.sl) / s.entry * 100).toFixed(1)}%` : '';
      return `❌ \`${s.symbol}\` @${priceFmt}  SL hit  ${pct}  _(${age})_`;
    }
    if (s.outcome === 'EXPIRED') {
      const peakPct = s.maxReached && s.entry
        ? ((s.maxReached - s.entry) / s.entry * 100)
        : 0;
      const peakStr = peakPct >= 0.1 ? `  peak: +${peakPct.toFixed(1)}%` : '';
      return `⏰ \`${s.symbol}\` @${priceFmt}  Expired${peakStr}  _(${age})_`;
    }
    // PENDING — only show peak if resolver has run and moved price meaningfully
    const peakPct = s.maxReached && s.entry
      ? ((s.maxReached - s.entry) / s.entry * 100)
      : 0;
    const peakStr = peakPct >= 0.1 ? ` (peak: +${peakPct.toFixed(1)}%)` : '';
    return `⏳ \`${s.symbol}\` @${priceFmt}  Pending${peakStr}  _(${age})_`;
  });

  const displayLabel = limit === 0 ? 'All' : `Last ${display.length}`;

  return [
    `📊 *Signal Performance Report*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Total signals: *${allSignals.length}*  |  Resolved: *${allResolved.length}*`,
    `Win rate: *${winRate}%*  (${allWins.length}W / ${allLosses.length}L)`,
    `Avg win: *+${avgWinPct}%*  |  Avg loss: *${avgLossPct}%*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ...lines,
    ``,
    `_${displayLabel} signals shown. Stats from all ${allSignals.length} recorded._`,
  ].join('\n');
}

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

function _scoreToGrade(s) {
  if (s >= 80) return 'A+';
  if (s >= 65) return 'A';
  if (s >= 45) return 'B';
  return 'C';
}

function _ageLabel(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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

// ─── FEATURED HISTORY ────────────────────────────────────────────────────────

function loadFeatured() {
  try {
    if (fs.existsSync(FEATURED_FILE)) return JSON.parse(fs.readFileSync(FEATURED_FILE, 'utf8'));
  } catch {}
  return { signals: [] };
}

function saveFeatured(data) {
  try { fs.writeFileSync(FEATURED_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function recordFeatured(r) {
  if (!r?.symbol || !r?.entry) return;
  const data = loadFeatured();
  const now  = Date.now();

  const recent = data.signals.find(
    s => s.symbol === r.symbol && (now - s.timestamp) < DEDUPE_WINDOW
  );
  if (recent) return;

  data.signals.push({
    id         : `${r.symbol}_${now}`,
    symbol     : r.symbol,
    entry      : r.entry,
    sl         : r.sl   ?? null,
    tp1        : r.tp1  ?? null,
    tp2        : r.tp2  ?? null,
    moon       : r.moonPrice ?? r.moon ?? null,
    score      : r.instGrade?.iScore ?? 50,
    timestamp  : now,
    outcome    : 'PENDING',
    exitPrice  : null,
    maxReached : r.entry,
    resolvedAt : null,
  });

  if (data.signals.length > MAX_SIGNALS) data.signals = data.signals.slice(-MAX_SIGNALS);
  saveFeatured(data);
}

function updateFeaturedMaxReached(symbol, price) {
  const data = loadFeatured();
  const sig  = data.signals.find(s => s.symbol === symbol && s.outcome === 'PENDING');
  if (!sig) return;
  if (price > (sig.maxReached ?? 0)) { sig.maxReached = price; saveFeatured(data); }
}

function resolveFeatured(symbol, outcome, exitPrice) {
  const data = loadFeatured();
  const sig  = data.signals.find(s => s.symbol === symbol && (s.outcome === 'PENDING' || s.outcome === 'TP1_HIT'));
  if (!sig) return;
  sig.outcome    = outcome;
  sig.exitPrice  = exitPrice;
  sig.resolvedAt = Date.now();
  saveFeatured(data);
}

function getPendingFeatured() {
  return loadFeatured().signals.filter(s => s.outcome === 'PENDING' || s.outcome === 'TP1_HIT');
}

function buildFeaturedReport(limit = 50) {
  const data       = loadFeatured();
  const allSignals = data.signals;

  if (!allSignals.length) {
    return '🌟 *Featured Signal Report*\n\nNo featured signals recorded yet. Only A+ grade signals with strong R:R appear here.';
  }

  const allResolved = allSignals.filter(s => ['TP1_HIT', 'TP2_HIT', 'SL_HIT'].includes(s.outcome));
  const allWins     = allResolved.filter(s => s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT');
  const allLosses   = allResolved.filter(s => s.outcome === 'SL_HIT');
  const winRate     = allResolved.length > 0 ? ((allWins.length / allResolved.length) * 100).toFixed(0) : '—';

  const avgWinPct = allWins.length > 0
    ? (allWins.reduce((sum, s) => {
        return sum + (s.exitPrice && s.entry ? (s.exitPrice - s.entry) / s.entry * 100 : 0);
      }, 0) / allWins.length).toFixed(1)
    : '—';

  const avgLossPct = allLosses.length > 0
    ? (allLosses.reduce((sum, s) => {
        return sum + (s.exitPrice && s.entry ? (s.exitPrice - s.entry) / s.entry * 100 : 0);
      }, 0) / allLosses.length).toFixed(1)
    : '—';

  const display = (limit === 0 ? allSignals : allSignals.slice(-limit)).reverse();

  const lines = display.map(s => {
    const age      = _ageLabel(s.timestamp);
    const priceFmt = _fmt(s.entry);
    const rrRatio  = s.sl && s.tp1 ? ((s.tp1 - s.entry) / (s.entry - s.sl)).toFixed(1) : '?';

    if (s.outcome === 'TP2_HIT') {
      const pct = s.exitPrice ? `+${((s.exitPrice - s.entry) / s.entry * 100).toFixed(1)}%` : '';
      return `🏆 \`${s.symbol}\` @${priceFmt}  TP2 ✅✅  ${pct}  R:R 1:${rrRatio}  _(${age})_`;
    }
    if (s.outcome === 'TP1_HIT') {
      const pct = s.tp1 ? `+${((s.tp1 - s.entry) / s.entry * 100).toFixed(1)}%` : '';
      return `✅ \`${s.symbol}\` @${priceFmt}  TP1 hit  ${pct}  R:R 1:${rrRatio}  _(${age})_`;
    }
    if (s.outcome === 'SL_HIT') {
      const pct = s.sl ? `-${((s.entry - s.sl) / s.entry * 100).toFixed(1)}%` : '';
      return `❌ \`${s.symbol}\` @${priceFmt}  SL hit  ${pct}  _(${age})_`;
    }
    if (s.outcome === 'EXPIRED') {
      const peakPct = s.maxReached && s.entry ? ((s.maxReached - s.entry) / s.entry * 100) : 0;
      const peakStr = peakPct >= 0.1 ? `  peak: +${peakPct.toFixed(1)}%` : '';
      return `⏰ \`${s.symbol}\` @${priceFmt}  Expired${peakStr}  _(${age})_`;
    }
    const peakPct = s.maxReached && s.entry ? ((s.maxReached - s.entry) / s.entry * 100) : 0;
    const peakStr = peakPct >= 0.1 ? ` (peak: +${peakPct.toFixed(1)}%)` : '';
    return `⏳ \`${s.symbol}\` @${priceFmt}  Pending${peakStr}  R:R 1:${rrRatio}  _(${age})_`;
  });

  const displayLabel = limit === 0 ? 'All' : `Last ${display.length}`;

  return [
    `🌟 *Featured Signal Report*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Total featured: *${allSignals.length}*  |  Resolved: *${allResolved.length}*`,
    `Win rate: *${winRate}%*  (${allWins.length}W / ${allLosses.length}L)`,
    `Avg win: *+${avgWinPct}%*  |  Avg loss: *${avgLossPct}%*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ...lines,
    ``,
    `_${displayLabel} shown. Only A+ grade signals with R:R ≥ 1:2.5._`,
  ].join('\n');
}

// ─── COOLDOWN ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the symbol hit SL within the last 24 hours.
 * Used in broadcastSignal to suppress re-entry on a coin that just failed.
 */
function isCoolingDown(symbol) {
  const data      = load();
  const cutoff    = Date.now() - 24 * 60 * 60 * 1000;
  return data.signals.some(
    s => s.symbol === symbol && s.outcome === 'SL_HIT' && s.resolvedAt && s.resolvedAt > cutoff
  );
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  recordSignal,
  getPendingSignals,
  resolveSignal,
  updateMaxReached,
  buildReport,
  isCoolingDown,
  recordFeatured,
  getPendingFeatured,
  updateFeaturedMaxReached,
  resolveFeatured,
  buildFeaturedReport,
};
