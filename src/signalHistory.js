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

const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'signal_history.json');
const MAX_AGE_DAYS  = 7;
const MAX_SIGNALS   = 300;
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

function recordSignal(r) {
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

function buildReport(limit = 25) {
  const data    = load();
  const signals = data.signals.slice(-limit).reverse();

  if (!signals.length) {
    return '📊 *Signal Report*\n\nNo signals recorded yet. The bot will start tracking from now.';
  }

  // Stats
  const resolved = signals.filter(s => ['TP1_HIT', 'TP2_HIT', 'SL_HIT'].includes(s.outcome));
  const wins     = resolved.filter(s => s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT');
  const losses   = resolved.filter(s => s.outcome === 'SL_HIT');
  const winRate  = resolved.length > 0 ? ((wins.length / resolved.length) * 100).toFixed(0) : '—';

  const avgWinPct = wins.length > 0
    ? (wins.reduce((sum, s) => {
        const pct = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : 0;
        return sum + pct;
      }, 0) / wins.length).toFixed(1)
    : '—';

  const avgLossPct = losses.length > 0
    ? (losses.reduce((sum, s) => {
        const pct = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : 0;
        return sum + pct;
      }, 0) / losses.length).toFixed(1)
    : '—';

  // Per-signal lines
  const lines = signals.map(s => {
    const age     = _ageLabel(s.timestamp);
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
      const maxPct = s.maxReached && s.entry
        ? `  peak: ${((s.maxReached - s.entry) / s.entry * 100).toFixed(1)}%`
        : '';
      return `⏰ \`${s.symbol}\` @${priceFmt}  Expired${maxPct}  _(${age})_`;
    }
    // PENDING — show live progress if maxReached available
    const liveMove = s.maxReached && s.entry
      ? ` (peak: ${((s.maxReached - s.entry) / s.entry * 100).toFixed(1)}%)`
      : '';
    return `⏳ \`${s.symbol}\` @${priceFmt}  Pending${liveMove}  _(${age})_`;
  });

  return [
    `📊 *Signal Performance Report*`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `Resolved: *${resolved.length}* of ${signals.length}  |  Win rate: *${winRate}%*`,
    `Avg win: *+${avgWinPct}%*  |  Avg loss: *${avgLossPct}%*`,
    `Wins: ${wins.length} ✅  |  Losses: ${losses.length} ❌  |  Pending: ${signals.length - resolved.length} ⏳`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ...lines,
    ``,
    `_Last ${signals.length} signals. Bot tracks outcomes automatically._`,
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

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  recordSignal,
  getPendingSignals,
  resolveSignal,
  updateMaxReached,
  buildReport,
};
