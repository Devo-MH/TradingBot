'use strict';

/**
 * Sector Momentum Tracker
 *
 * Groups coins into sectors and tracks which sectors are hot
 * based on recent scanner signals. When a signal fires, the
 * bot can say "DeFi sector is hot — 3 signals in the last 2h".
 *
 * This is the "money rotation" layer the guide describes.
 * No external API needed — derived purely from scanner output.
 */

// ─── SECTOR MAP ───────────────────────────────────────────────────────────────

const SECTORS = {
  L1      : ['BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','ATOMUSDT','NEARUSDT','APTUSDT','SUIUSDT','TONUSDT','INJUSDT'],
  L2      : ['MATICUSDT','ARBUSDT','OPUSDT','STRKUSDT','ZKUSDT','SCROLLUSDT','MANAUSDT','LRCUSDT'],
  DeFi    : ['UNIUSDT','AAVEUSDT','CRVUSDT','MKRUSDT','SUSHIUSDT','COMPUSDT','SNXUSDT','DYDXUSDT','GMXUSDT','JUPUSDT'],
  AI      : ['FETUSDT','AGIXUSDT','OCEANUSDT','RENDERUSDT','TAORUSDT','WLDUSDT','ARKMUSDT','GRTUSDT'],
  Meme    : ['DOGEUSDT','SHIBUSDT','PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT','BOMEUSDT'],
  Gaming  : ['AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','IMXUSDT','RONUSDT','PIXELUSDT','YGGUSDT'],
  Infra   : ['LINKUSDT','FILUSDT','ARUSDT','HBARUSDT','ICPUSDT','STXUSDT','CFXUSDT','MOVEUSDT'],
  Exchange: ['BNBUSDT','OKBUSDT','HTUSDT','KCSUSDT','CROUSUSDT'],
  RWA     : ['ONDOUSDT','POLXUSDT','CFGUSDT','ORCAUSDT'],
  Privacy : ['XMRUSDT','ZCASHUSDT','SCRTUSDT','DEROLUSDT'],
};

// ─── STATE ────────────────────────────────────────────────────────────────────

// Recent signals: { symbol, sector, iScore, ts }[]
const recentSignals = [];
const WINDOW_MS     = 2 * 60 * 60 * 1000; // 2-hour rolling window

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Record a new scanner signal for momentum tracking.
 */
function recordSignal(symbol, iScore) {
  const sector = getSector(symbol);
  recentSignals.push({ symbol, sector, iScore, ts: Date.now() });
  pruneOld();
}

/**
 * Get the sector name for a symbol.
 */
function getSector(symbol) {
  for (const [sector, symbols] of Object.entries(SECTORS)) {
    if (symbols.includes(symbol.toUpperCase())) return sector;
  }
  return 'Other';
}

/**
 * Get a momentum summary for the rolling window.
 * Returns array of { sector, count, avgScore } sorted by count desc.
 */
function getMomentumSummary() {
  pruneOld();
  const byS = {};
  for (const s of recentSignals) {
    if (!byS[s.sector]) byS[s.sector] = { count: 0, scoreSum: 0 };
    byS[s.sector].count++;
    byS[s.sector].scoreSum += s.iScore ?? 50;
  }
  return Object.entries(byS)
    .map(([sector, v]) => ({
      sector,
      count   : v.count,
      avgScore: Math.round(v.scoreSum / v.count),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build a one-line rotation summary for embedding in a signal alert.
 * Example: "🔄 Sector: DeFi 🔥 (4 signals in 2h) — money rotating in"
 */
function buildRotationLine(symbol) {
  pruneOld();
  const sector  = getSector(symbol);
  const summary = getMomentumSummary();
  const own     = summary.find(s => s.sector === sector);

  if (!own || own.count < 2) return '';

  const rank     = summary.findIndex(s => s.sector === sector) + 1;
  const isHot    = rank === 1 && own.count >= 3;
  const emoji    = isHot ? '🔥' : own.count >= 2 ? '📈' : '';
  const topSector = summary[0];

  if (isHot) {
    return `🔄 Sector: *${sector}* ${emoji} — ${own.count} setups in 2h (hottest sector)`;
  }
  if (topSector && topSector.sector !== sector && topSector.count >= 3) {
    return `🔄 Sector: ${sector} | Rotation leader: *${topSector.sector}* (${topSector.count} signals)`;
  }
  return `🔄 Sector: ${sector} ${emoji} — ${own.count} setups in 2h`;
}

/**
 * Full sector rotation card for /status or /sectors command.
 */
function buildSectorCard() {
  pruneOld();
  const summary = getMomentumSummary();
  if (!summary.length) return '🔄 No sector data yet — signals populate this over time.';

  const lines = summary.slice(0, 6).map((s, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ` ${i + 1}.`;
    const bar   = '█'.repeat(Math.min(s.count, 8)) + '░'.repeat(Math.max(0, 8 - s.count));
    return `${medal} *${s.sector.padEnd(8)}* [${bar}] ${s.count}  (avg ${s.avgScore}/100)`;
  });

  return (
    `🔄 *Sector Momentum (last 2h)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join('\n') + '\n\n' +
    `_Top sector = highest money flow_`
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function pruneOld() {
  const cutoff = Date.now() - WINDOW_MS;
  while (recentSignals.length && recentSignals[0].ts < cutoff) {
    recentSignals.shift();
  }
}

module.exports = {
  recordSignal,
  getSector,
  getMomentumSummary,
  buildRotationLine,
  buildSectorCard,
};
