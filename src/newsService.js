'use strict';

/**
 * News Service — CryptoPanic API
 *
 * Fetches latest news headlines for a given coin symbol.
 * Free tier: https://cryptopanic.com/developers/api/
 *
 * Set CRYPTOPANIC_TOKEN in .env to enable.
 * Without a token the service returns a graceful "no data" response.
 *
 * Cache: 10 minutes per symbol to avoid hitting rate limits.
 */

const axios = require('axios');

const CACHE_TTL   = 10 * 60 * 1000; // 10 min
const cache       = new Map();        // symbol → { headlines, fetchedAt }
const BASE_URL    = 'https://cryptopanic.com/api/v1/posts/';

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Fetch latest news for a symbol (e.g. 'BTCUSDT' → currency 'BTC').
 * Returns { headlines: string[], sentiment: 'positive'|'negative'|'neutral', raw }
 */
async function getNewsForSymbol(symbol) {
  const currency = symbolToCurrency(symbol);
  const token    = process.env.CRYPTOPANIC_TOKEN;

  // No token — skip silently
  if (!token) return { headlines: [], sentiment: 'neutral', raw: [] };

  // Cache hit
  const cached = cache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await axios.get(BASE_URL, {
      params: {
        auth_token: token,
        currencies: currency,
        filter     : 'hot',
        public     : true,
      },
      timeout: 8000,
    });

    const posts = res.data?.results ?? [];
    const headlines = posts.slice(0, 3).map(p => p.title);
    const sentiment = deriveSentiment(posts);

    const data = { headlines, sentiment, raw: posts.slice(0, 3) };
    cache.set(currency, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return { headlines: [], sentiment: 'neutral', raw: [] };
  }
}

/**
 * Build a one-line news summary for embedding in a signal alert.
 * Returns a string — empty if no news or no token.
 */
async function buildNewsSummary(symbol) {
  const { headlines, sentiment } = await getNewsForSymbol(symbol);
  const currency = symbolToCurrency(symbol);

  if (!headlines.length) {
    return `📰 ${currency}: No recent news ✅`;
  }

  const sentimentEmoji = { positive: '🟢', negative: '🔴', neutral: '⚪' }[sentiment] ?? '⚪';

  // Show first headline truncated + sentiment
  const first = headlines[0].length > 70
    ? headlines[0].slice(0, 67) + '…'
    : headlines[0];

  return `📰 ${sentimentEmoji} ${first}`;
}

/**
 * Check for red-flag news (delisting, hack, exploit, ban).
 * Returns { danger: boolean, reason: string }
 */
async function checkDangerousNews(symbol) {
  const { headlines } = await getNewsForSymbol(symbol);
  if (!headlines.length) return { danger: false, reason: '' };

  const redFlags = ['delist', 'hack', 'exploit', 'ban', 'suspend', 'lawsuit', 'sec', 'fraud', 'exit scam'];
  for (const h of headlines) {
    const lower = h.toLowerCase();
    for (const flag of redFlags) {
      if (lower.includes(flag)) {
        return { danger: true, reason: h.slice(0, 80) };
      }
    }
  }
  return { danger: false, reason: '' };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function symbolToCurrency(symbol) {
  return symbol.toUpperCase().replace(/USDT$|BUSD$|USDC$|BTC$|ETH$/, '');
}

function deriveSentiment(posts) {
  if (!posts.length) return 'neutral';
  const votes = posts.reduce((acc, p) => {
    acc.pos += (p.votes?.positive ?? 0) + (p.votes?.liked ?? 0);
    acc.neg += (p.votes?.negative ?? 0) + (p.votes?.disliked ?? 0);
    return acc;
  }, { pos: 0, neg: 0 });

  if (votes.pos > votes.neg * 1.5) return 'positive';
  if (votes.neg > votes.pos * 1.5) return 'negative';
  return 'neutral';
}

module.exports = { getNewsForSymbol, buildNewsSummary, checkDangerousNews };
