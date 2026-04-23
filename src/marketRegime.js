'use strict';

/**
 * Market Regime Detector
 *
 * Checks BTC 4h trend using EMA 20 vs EMA 50 to classify the market as:
 *   BULL       — BTC trending up, altcoin signals stronger
 *   BEAR       — BTC in downtrend, reduce size and tighten stops
 *   RANGING    — BTC sideways, take TP1 only
 *   TRANSITION — Mixed signals, wait for clarity
 *
 * Result is cached for 30 minutes to avoid hammering Binance.
 */

const axios = require('axios');

const CACHE_TTL = 30 * 60 * 1000;
const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api4.binance.com',
  'https://api3.binance.com',
];

let _cache    = null;
let _cacheAt  = 0;

async function _fetchKlines(symbol, interval, limit) {
  for (const host of BINANCE_HOSTS) {
    try {
      const r = await axios.get(`${host}/api/v3/klines`, {
        params: { symbol, interval, limit },
        timeout: 10000,
      });
      return r.data;
    } catch {}
  }
  return null;
}

function _ema(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

async function getMarketRegime() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL) return _cache;

  try {
    const klines = await _fetchKlines('BTCUSDT', '4h', 55);
    if (!klines || klines.length < 52) return null;

    const closes  = klines.map(k => parseFloat(k[4]));
    const current = closes[closes.length - 1];
    const ema20   = _ema(closes, 20);
    const ema50   = _ema(closes, 50);

    // 7-day change: 42 × 4h candles ≈ 7 days
    const weekAgo    = closes[Math.max(0, closes.length - 42)];
    const weekChange = ((current - weekAgo) / weekAgo * 100);

    let regime, emoji, advice;

    if (current > ema20 && ema20 > ema50) {
      regime = 'BULL';
      emoji  = '🟢';
      advice = 'BTC uptrend — altcoin signals carry more weight';
    } else if (current < ema20 && ema20 < ema50) {
      regime = 'BEAR';
      emoji  = '🔴';
      advice = 'BTC downtrend — reduce sizes, tighten stops, skip C-grade';
    } else if (Math.abs(weekChange) < 3) {
      regime = 'RANGING';
      emoji  = '🟡';
      advice = 'BTC ranging — target TP1 only, avoid holds';
    } else {
      regime = 'TRANSITION';
      emoji  = '🟠';
      advice = 'BTC transitioning — wait for direction before sizing up';
    }

    _cache = { regime, emoji, advice, btcPrice: current, weekChange: weekChange.toFixed(1) };
    _cacheAt = now;
    return _cache;
  } catch (e) {
    console.error('[MarketRegime]', e.message);
    return null;
  }
}

function buildRegimeLine(r) {
  if (!r) return null;
  return `${r.emoji} Market: ${r.regime} · BTC 7d ${r.weekChange >= 0 ? '+' : ''}${r.weekChange}% · ${r.advice}`;
}

module.exports = { getMarketRegime, buildRegimeLine };
