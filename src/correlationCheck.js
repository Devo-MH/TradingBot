'use strict';

/**
 * Correlation Check
 *
 * Groups coins into correlated clusters.
 * When a signal arrives, warns the user if they already have a correlated
 * position open — combined exposure is higher than it looks.
 */

const GROUPS = {
  MAJORS : ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
  DEFI   : ['UNIUSDT', 'AAVEUSDT', 'SUSHIUSDT', 'CRVUSDT', 'COMPUSDT', 'MKRUSDT', 'YFIUSDT', 'DYDXUSDT'],
  L1     : ['SOLUSDT', 'AVAXUSDT', 'ADAUSDT', 'DOTUSDT', 'NEARUSDT', 'ATOMUSDT', 'ALGOUSDT', 'APTUSDT', 'SUIUSDT'],
  L2     : ['MATICUSDT', 'ARBUSDT', 'OPUSDT', 'STRKUSDT'],
  MEME   : ['DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT', 'BONKUSDT'],
  GAMING : ['AXSUSDT', 'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'GALAUSDT'],
  AI     : ['FETUSDT', 'AGIXUSDT', 'OCEAUSDT', 'RENDERUSDT', 'WLDUSDT'],
  INFRA  : ['LINKUSDT', 'FILUSDT', 'ARWEAVEUSDT', 'THETAUSDT'],
};

function getGroup(symbol) {
  for (const [group, symbols] of Object.entries(GROUPS)) {
    if (symbols.includes(symbol)) return group;
  }
  return 'ALTS'; // everything else is correlated with BTC
}

/**
 * Returns a warning string if the user already has correlated open trades,
 * or null if no conflict.
 *
 * @param {string}   symbol     - incoming signal symbol
 * @param {object[]} openTrades - user's open trades from tradeStore snapshot
 */
function buildCorrelationWarning(symbol, openTrades) {
  if (!openTrades?.length) return null;

  const group       = getGroup(symbol);
  const openSymbols = openTrades.map(t => t.symbol);

  // Find open trades in the same group
  const sameGroup = openSymbols.filter(s => s !== symbol && getGroup(s) === group);

  // All alts also correlate with BTC — if BTC is open and this is an alt, flag it
  const btcOpen = openSymbols.includes('BTCUSDT') && group !== 'MAJORS';

  const conflicts = [...new Set(sameGroup)];
  if (btcOpen && !conflicts.includes('BTCUSDT')) conflicts.push('BTCUSDT');

  if (!conflicts.length) return null;

  const names = conflicts.join(', ');
  const groupLabel = group === 'ALTS' ? 'altcoin' : group;
  return (
    `⚠️ Correlated exposure: ${names} already open (${groupLabel} cluster) — ` +
    `if market drops, both positions fall together. Use smaller size.`
  );
}

module.exports = { getGroup, buildCorrelationWarning };
