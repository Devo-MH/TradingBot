'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   CRYPTO TRADING GUIDE BOT                                       ║
 * ║   Step-by-step trading assistant powered by Scanner v6.0        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Architecture:
 *   bot.js            ← you are here (Telegram command + callback handler)
 *   src/userProfile   ← onboarding, risk settings, profile storage
 *   src/tradeStore    ← open/close/update trades, daily P&L
 *   src/signalBridge  ← converts scanner results into guided messages
 *   src/tradeMonitor  ← watches open trades every 5 min
 *   src/performance   ← stats, debriefs, pattern coaching
 *   src/watchlist     ← pre-pump watchlist
 *   scanner_v6.js     ← the signal engine (runs in parallel)
 */

process.on('uncaughtException',  e => console.error('[Crash]',     e.message));
process.on('unhandledRejection', e => console.error('[Rejection]', e?.message ?? e));

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const { RSI, MACD, EMA, ATR } = require('technicalindicators');

// ─── LOCAL MODULES ────────────────────────────────────────────────────────────
const profile    = require('./src/userProfile');
const store      = require('./src/tradeStore');
const bridge     = require('./src/signalBridge');
const monitor    = require('./src/tradeMonitor');
const perf       = require('./src/performance');
const watchlist  = require('./src/watchlist');
const risk       = require('./src/riskEngine');
const news       = require('./src/newsService');
const sector     = require('./src/sectorMomentum');
const { adapt }  = require('./src/scannerAdapter');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_TOKEN  : process.env.TELEGRAM_TOKEN ?? 'YOUR_BOT_TOKEN_HERE',
  CHANNEL_ID      : process.env.CHANNEL_ID     ?? null,
  BOT_USERNAME    : process.env.BOT_USERNAME   ?? 'cryptodailytrading_bot',
  WEBHOOK_URL     : process.env.WEBHOOK_URL    ?? null,
  PORT            : parseInt(process.env.PORT  ?? '3000'),
  SCAN_INTERVAL_MS: 5 * 60 * 1000,
  BINANCE_HOSTS   : [
    'https://data-api.binance.vision',
    'https://api4.binance.com',
    'https://api3.binance.com',
  ],
};

// Channel ID can also be set at runtime via /setchannel
let channelId = CONFIG.CHANNEL_ID;

// ─── BOT INIT ─────────────────────────────────────────────────────────────────
console.log('[Config] TOKEN prefix:', CONFIG.TELEGRAM_TOKEN?.substring(0, 15));
console.log('[Config] CHANNEL_ID:', CONFIG.CHANNEL_ID);
console.log('[Config] WEBHOOK_URL:', CONFIG.WEBHOOK_URL ?? 'none (polling mode)');

let bot;
if (CONFIG.WEBHOOK_URL) {
  // Webhook mode — Railway injects PORT automatically
  const webhookPort = CONFIG.PORT;
  console.log('[Config] Webhook port:', webhookPort);
  bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { webHook: { port: webhookPort, host: '0.0.0.0' } });
  bot.setWebHook(`${CONFIG.WEBHOOK_URL}/bot${CONFIG.TELEGRAM_TOKEN}`)
    .then(() => console.log('[Bot] Webhook set on port', webhookPort))
    .catch(e => console.error('[Bot] Webhook error:', e.message));
} else {
  // Polling mode — used locally
  bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
}

// ─── CONVERSATION STATE ───────────────────────────────────────────────────────
// Tracks multi-step conversations per user (entry flow, custom price input, etc.)
const conversationState = new Map();

function getState(userId)         { return conversationState.get(String(userId)) ?? {}; }
function setState(userId, state)  { conversationState.set(String(userId), state); }
function clearState(userId)       { conversationState.delete(String(userId)); }

// ─── BINANCE HELPERS ──────────────────────────────────────────────────────────

async function safeGet(path) {
  for (const host of CONFIG.BINANCE_HOSTS) {
    for (let i = 0; i < 3; i++) {
      try {
        return await axios.get(host + path, { timeout: 15000 });
      } catch { await sleep(1000 * (i + 1)); }
    }
  }
  return null;
}

async function getPrice(symbol) {
  const res = await safeGet(`/api/v3/ticker/price?symbol=${symbol}`);
  return res ? parseFloat(res.data.price) : null;
}

async function getCandles(symbol, interval, limit = 120) {
  const res = await safeGet(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res) return null;
  return {
    opens  : res.data.map(c => parseFloat(c[1])),
    highs  : res.data.map(c => parseFloat(c[2])),
    lows   : res.data.map(c => parseFloat(c[3])),
    closes : res.data.map(c => parseFloat(c[4])),
    volumes: res.data.map(c => parseFloat(c[5])),
  };
}

async function getOrderBook(symbol) {
  const res = await safeGet(`/api/v3/depth?symbol=${symbol}&limit=20`);
  if (!res) return null;
  try {
    const bids = res.data.bids.map(([p, q]) => ({ price: +p, qty: +q })).filter(b => b.qty > 0);
    const asks = res.data.asks.map(([p, q]) => ({ price: +p, qty: +q })).filter(a => a.qty > 0);
    if (!bids.length || !asks.length) return null;
    return { bids, asks };
  } catch { return null; }
}

// ─── SEND HELPERS ─────────────────────────────────────────────────────────────

async function send(chatId, text, keyboard = null) {
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) opts.reply_markup = keyboard;
  try {
    await bot.sendMessage(chatId, text, opts);
  } catch (e) {
    const plain = text.replace(/[*_`\[\]]/g, '');
    try { await bot.sendMessage(chatId, plain, keyboard ? { reply_markup: keyboard } : {}); }
    catch (e2) { console.error('[Send]', e2.message); }
  }
}

async function edit(chatId, msgId, text, keyboard = null) {
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) opts.reply_markup = keyboard;
  try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); }
  catch { await send(chatId, text, keyboard); }
}

async function answerCb(callbackQueryId, text = '') {
  try { await bot.answerCallbackQuery(callbackQueryId, { text }); } catch {}
}

// ─── /start — ONBOARDING ENTRY ───────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const uid = msg.chat.id;

  if (profile.isOnboarded(uid)) {
    await send(uid,
      `👋 Welcome back!\n\n` +
      `I'm scanning markets every 5 minutes.\n` +
      `You'll be alerted when a quality setup appears.\n\n` +
      `*Quick commands:*\n` +
      ` /status — portfolio + open trades\n` +
      ` /stats — your performance\n` +
      ` /profile — your settings\n` +
      ` /watchlist — coins you're watching\n` +
      ` /help — all commands`
    );
    return;
  }

  await send(uid,
    `🤖 *Welcome to Crypto Trading Guide Bot*\n\n` +
    `I'll guide you through every trade step by step:\n` +
    ` · Tell you *when* to enter and *where* to set your stop\n` +
    ` · Alert you when to take profit or exit\n` +
    ` · Track your performance and coach you over time\n\n` +
    `First, let me learn a little about you.\n` +
    `_(This takes 30 seconds and sets your risk parameters)_`
  );

  await sleep(800);
  await sendOnboardStep(uid, 0);
});

async function sendOnboardStep(userId, step) {
  const q = profile.getOnboardQuestion(step);
  if (!q) return;
  await send(userId, q.question, { inline_keyboard: q.buttons });
}

// ─── /profile ─────────────────────────────────────────────────────────────────

bot.onText(/\/profile/, async (msg) => {
  const uid = msg.chat.id;
  if (!guardOnboarded(uid)) return;
  await send(uid, profile.buildProfileSummary(uid), {
    inline_keyboard: [[
      { text: '✏️ Change risk %',    callback_data: 'profile_edit_risk'    },
      { text: '✏️ Change capital',   callback_data: 'profile_edit_capital' },
    ], [
      { text: '✏️ Change max trades',callback_data: 'profile_edit_maxt'   },
      { text: '✏️ Change signal filter', callback_data: 'profile_edit_filter' },
    ]],
  });
});

// ─── /status ──────────────────────────────────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  const uid = msg.chat.id;
  if (!guardOnboarded(uid)) return;

  const p        = profile.getProfile(uid);
  const snapshot = store.getPortfolioSnapshot(uid);
  const dailyPct = p.capital > 0 ? ((snapshot.dailyPnlUSDT / p.capital) * 100).toFixed(2) : '0.00';
  const pnlEmoji = snapshot.dailyPnlUSDT >= 0 ? '📈' : '📉';
  const deployedPct = p.capital > 0 ? ((snapshot.deployedUSDT / p.capital) * 100).toFixed(0) : '0';

  const barFilled = Math.round(parseFloat(deployedPct) / 10);
  const bar = '▓'.repeat(barFilled) + '░'.repeat(10 - barFilled);

  let tradesBlock = '_No open trades_';
  if (snapshot.openTrades.length) {
    tradesBlock = await Promise.all(snapshot.openTrades.map(async t => {
      const price  = await getPrice(t.symbol) ?? t.entry;
      const pnlPct = ((price - t.entry) / t.entry * 100).toFixed(1);
      const sign   = parseFloat(pnlPct) >= 0 ? '+' : '';
      return ` · \`${t.symbol}\`  Entry: ${bridge.fmtPrice(t.entry)}  Now: ${bridge.fmtPrice(price)}  ${sign}${pnlPct}%`;
    })).then(lines => lines.join('\n'));
  }

  const slotsFree = Math.max(0, p.maxTrades - snapshot.openCount);
  const status    = p.paused ? '⏸️ Paused' : slotsFree > 0 ? `✅ Active — ${slotsFree} slot${slotsFree > 1 ? 's' : ''} free` : '🔴 Full — max trades open';

  await send(uid,
    `📊 *Portfolio Status*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Capital:    $${p.capital.toLocaleString()}\n` +
    `Deployed:   $${snapshot.deployedUSDT} (${deployedPct}%)  ${bar}\n` +
    `At risk:    $${snapshot.atRiskUSDT}\n` +
    `Today P&L:  ${pnlEmoji} ${snapshot.dailyPnlUSDT >= 0 ? '+' : ''}$${snapshot.dailyPnlUSDT}  (${dailyPct >= 0 ? '+' : ''}${dailyPct}%)\n\n` +
    `*Open Trades (${snapshot.openCount}/${p.maxTrades}):*\n` +
    tradesBlock + '\n\n' +
    `Status: ${status}`,
    {
      inline_keyboard: [[
        { text: '📊 My stats',      callback_data: 'show_stats'     },
        { text: '👀 Watchlist',     callback_data: 'show_watchlist'  },
      ], [
        { text: '🌡️ Risk heat',   callback_data: 'show_heat'       },
        { text: '🔄 Sectors',       callback_data: 'show_sectors'    },
      ]],
    }
  );
});

// ─── /stats ───────────────────────────────────────────────────────────────────

bot.onText(/\/stats/, async (msg) => {
  const uid = msg.chat.id;
  if (!guardOnboarded(uid)) return;
  await send(uid, perf.buildStatsSummary(uid));
});

// ─── /watchlist ───────────────────────────────────────────────────────────────

bot.onText(/\/watchlist/, async (msg) => {
  const uid = msg.chat.id;
  if (!guardOnboarded(uid)) return;
  await send(uid, watchlist.buildWatchlistSummary(uid));
});

bot.onText(/\/watch (.+)/, async (msg, match) => {
  const uid    = msg.chat.id;
  const symbol = normalizeSymbol(match[1].trim());
  watchlist.addToWatchlist(uid, symbol, 'Manual add');
  await send(uid, `👀 Added *${symbol}* to your watchlist.\n\nI'll flag any signal on it with priority.`);
});

bot.onText(/\/unwatch (.+)/, async (msg, match) => {
  const uid    = msg.chat.id;
  const symbol = normalizeSymbol(match[1].trim());
  watchlist.removeFromWatchlist(uid, symbol);
  await send(uid, `✅ Removed *${symbol}* from watchlist.`);
});

// ─── /pause / /resume ────────────────────────────────────────────────────────

bot.onText(/\/sectors/, async (msg) => {
  await send(msg.chat.id, sector.buildSectorCard());
});

bot.onText(/\/pause/, async (msg) => {
  const uid = msg.chat.id;
  profile.updateProfile(uid, { paused: true });
  await send(uid, `⏸️ Bot paused. No alerts until you type /resume.`);
});

bot.onText(/\/resume/, async (msg) => {
  const uid = msg.chat.id;
  profile.updateProfile(uid, { paused: false });
  await send(uid, `✅ Resumed. I'm watching markets again.`);
});

// ─── /track (manual entry) ───────────────────────────────────────────────────

bot.onText(/\/track (.+)/, async (msg, match) => {
  const uid   = msg.chat.id;
  if (!guardOnboarded(uid)) return;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) {
    await send(uid, '⚠️ Usage: `/track SYMBOL ENTRY_PRICE`\nExample: `/track STOUSDT 0.13`');
    return;
  }
  const symbol    = normalizeSymbol(parts[0]);
  const entryPrice = parseFloat(parts[1]);
  if (isNaN(entryPrice)) { await send(uid, '⚠️ Invalid price.'); return; }

  const sizes    = profile.calcPositionSizes(uid);
  const snapshot = store.getPortfolioSnapshot(uid);
  const capacity = profile.checkTradeCapacity(uid, snapshot.openCount);

  if (!capacity.allowed) {
    await send(uid, `⚠️ ${capacity.reason}`);
    return;
  }

  // Manual track: use recommended size, user can adjust
  const trade = store.openTrade(uid, sizes?.recommended ?? 100, {
    symbol,
    entry  : entryPrice,
    sl     : entryPrice * 0.975,
    tp1    : entryPrice * 1.025,
    tp2    : entryPrice * 1.055,
    moon   : entryPrice * 1.15,
    signalGrade: 'B',
  });

  await send(uid,
    `✅ *Tracking ${symbol}* (Trade ${trade.id})\n` +
    `Entry: \`${bridge.fmtPrice(entryPrice)}\`\n` +
    `SL:    \`${bridge.fmtPrice(trade.sl)}\`\n` +
    `TP1:   \`${bridge.fmtPrice(trade.tp1)}\`\n\n` +
    `I'll update you every 15–30 min.\n` +
    `Use /untrack ${symbol} to stop.`
  );
});

bot.onText(/\/untrack (.+)/, async (msg, match) => {
  const uid    = msg.chat.id;
  const symbol = normalizeSymbol(match[1].trim());
  const trade  = store.getOpenTradeBySymbol(uid, symbol);
  if (!trade) { await send(uid, `⚠️ No open trade for ${symbol}.`); return; }
  const price = await getPrice(symbol) ?? trade.entry;
  store.closeTrade(trade.id, price, 'manual');
  await send(uid, `✅ Stopped tracking ${symbol}.`);
});

bot.onText(/\/tracked/, async (msg) => {
  const uid      = msg.chat.id;
  if (!guardOnboarded(uid)) return;
  const snapshot = store.getPortfolioSnapshot(uid);
  if (!snapshot.openCount) {
    await send(uid, 'No open trades.\nUse /track SYMBOL PRICE to add one.');
    return;
  }
  const lines = await Promise.all(snapshot.openTrades.map(async t => {
    const price  = await getPrice(t.symbol) ?? t.entry;
    const pnlPct = ((price - t.entry) / t.entry * 100).toFixed(1);
    const sign   = parseFloat(pnlPct) >= 0 ? '+' : '';
    return ` · \`${t.symbol}\` | Entry: ${bridge.fmtPrice(t.entry)} | ${sign}${pnlPct}%`;
  }));
  await send(uid, `*Open Positions (${snapshot.openCount}):*\n${lines.join('\n')}`);
});

// ─── /testsignal — fire a fake signal to verify formatting ───────────────────

bot.onText(/\/testsignal(?:\s+(\S+))?/, async (msg, match) => {
  const uid    = msg.chat.id;
  if (!guardOnboarded(uid)) return;

  const rawSymbol = (match[1] ?? 'SCRTUSDT').toUpperCase();
  const symbol    = rawSymbol.endsWith('USDT') ? rawSymbol : rawSymbol + 'USDT';

  // Fetch a live price if possible, otherwise use a placeholder
  const livePrice = await getPrice(symbol).catch(() => null);
  const price     = livePrice ?? 0.114;

  // Build a raw object matching real scanner_v6.js output shape
  const rawSignal = {
    symbol,
    price,
    score           : 20,
    hurst           : 0.9,
    tsmom           : 1.0,
    atrPct          : 1.07,
    volZ            : 1.22,
    volRatio        : 1.5,
    obBids          : 17500,
    obAsks          : 30100,
    obRatio         : 0.58,
    absorption      : 50,
    instConfidence  : 100,
    breakoutScore   : 45,
    expansionType   : 'STRONG EXPANSION',
    session         : 'EUROPE',
    sessionWeight   : 1,
    confirmAbove    : price * 1.03,
    stop            : price * 0.975,
    tp1             : price * 1.10,
    tp2             : price * 1.20,
    moon            : price * 1.40,
    triggerPct      : 0.1,
    volIntent       : 'Strong Buying',
    action          : 'Aggressive entry on confirm — strong OB support',
    signals         : [
      'Vol Z=1.22 MODERATE',
      'Vol Intent: Strong Buying',
      'TSMOM Max 1',
      'Hurst 0.9 — exceptional trending',
      'ATR Coiling — compressed',
      'EUROPE — EU market hours',
      'Imminent Breakout (0.1% away)',
      'Partial Absorption (50/100)',
    ],
    classification  : 'STRONG SETUP',
  };

  await send(uid, `🧪 Firing test signal for *${symbol}*…`);
  await sleep(500);
  await broadcastSignal(adapt(rawSignal));
});

// ─── /setchannel — register channel via DM ───────────────────────────────────

bot.onText(/\/setchannel(?:\s+(-?\d+))?/, async (msg, match) => {
  const uid = msg.chat.id;
  const provided = match?.[1];

  if (provided) {
    channelId = provided;
    console.log(`[Channel] Registered channel: ${channelId}`);
    await send(uid,
      `✅ *Channel registered!*\n\n` +
      `ID: \`${channelId}\`\n` +
      `Signals will now be posted there automatically.\n\n` +
      `To make this permanent on Railway, add this to Variables:\n` +
      `\`CHANNEL_ID = ${channelId}\``
    );
  } else {
    await send(uid,
      `*How to register your channel:*\n\n` +
      `1. Forward any message from your channel to @userinfobot\n` +
      `2. It will reply with the channel ID (starts with -100)\n` +
      `3. Come back here and send:\n` +
      `\`/setchannel YOUR_CHANNEL_ID\`\n\n` +
      `_Example: /setchannel -1001234567890_`
    );
  }
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await send(msg.chat.id,
    `*Trading Guide Bot — Commands*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `*Setup:*\n` +
    ` /start — begin or return to home\n` +
    ` /profile — view and edit your settings\n\n` +
    `*Trading:*\n` +
    ` /status — open trades + portfolio\n` +
    ` /stats — win rate, P&L, coaching\n` +
    ` /track SYMBOL PRICE — manually track a trade\n` +
    ` /untrack SYMBOL — stop tracking\n` +
    ` /tracked — all open positions\n\n` +
    `*Watchlist:*\n` +
    ` /watchlist — view watched coins\n` +
    ` /watch SYMBOL — add a coin to watch\n` +
    ` /unwatch SYMBOL — remove from watchlist\n\n` +
    `*Controls:*\n` +
    ` /pause — pause all alerts\n` +
    ` /resume — resume alerts\n\n` +
    `*Market Intel:*\n` +
    ` /sectors — sector rotation (where money is flowing)\n\n` +
    `*Admin:*\n` +
    ` /setchannel — post this in your channel to register it for broadcasts\n\n` +
    `*Dev / Testing:*\n` +
    ` /testsignal — fire a test signal to check formatting\n` +
    ` /testsignal BTCUSDT — test with a specific coin\n\n` +
    `_Signals arrive automatically. No need to ask._`
  );
});

// ─── CALLBACK QUERY HANDLER ───────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const uid  = query.message.chat.id;
  const mid  = query.message.message_id;
  const data = query.data;
  await answerCb(query.id);

  try {
    // ── ONBOARDING CALLBACKS ────────────────────────────────────────────────
    if (data.startsWith('ob_')) {
      const result = profile.processOnboardAnswer(uid, data);
      if (result.done) {
        await edit(uid, mid,
          `✅ *Setup complete!*\n\n` +
          profile.buildProfileSummary(uid) + '\n\n' +
          `_I'm now scanning 200 pairs every 5 minutes.\nYou'll be alerted when a quality setup appears for you._`
        );
      } else if (result.nextQuestion) {
        const q = result.nextQuestion;
        await edit(uid, mid, q.question, { inline_keyboard: q.buttons });
      }
      return;
    }

    // ── SIGNAL FLOW ─────────────────────────────────────────────────────────
    if (data.startsWith('sig_quick_')) {
      const symbol = data.replace('sig_quick_', '');
      const cached = signalCache.get(symbol);
      if (!cached) { await send(uid, `⚠️ Signal for ${symbol} expired.`); return; }
      const r          = cached;
      const absorption = r._instLayer?.hiddenFlow?.confidence ?? 0;
      const obRatio    = r.orderBook?.ratio ?? r.instGrade?.obRatio;
      const cvd        = r._instLayer?.hiddenFlow?.type === 'HIDDEN_BUYER' ? '📈 Bullish (accumulating)'
                       : r._instLayer?.mmTrap?.trap                        ? '⚠️ Diverging (trap risk)'
                       : '➡️ Neutral';
      await send(uid,
        `⚡ *Quick Summary — ${symbol}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Grade:       ${bridge.scoreToGrade(r.instGrade?.iScore ?? 50)}  (${r.instGrade?.iScore ?? '?'}/100)\n` +
        `CVD:         ${cvd}\n` +
        (absorption >= 50 ? `Absorption:  ${absorption}/100\n` : '') +
        (obRatio ? `OB Ratio:    ${obRatio.toFixed(2)}x\n` : '') +
        `Trigger:     ${r.triggerDistance?.toFixed(1) ?? '?'}% away\n` +
        `Risk:        ${r._instLayer?.mmTrap?.trap ? '🔴 Trap risk' : '🟢 Clean'}\n\n` +
        `_Tap "I want to enter" on the signal card to proceed._`
      );
      return;
    }

    if (data.startsWith('sig_full_')) {
      const symbol = data.replace('sig_full_', '');
      const cached = signalCache.get(symbol);
      if (!cached) { await send(uid, `⚠️ Signal for ${symbol} expired.`); return; }
      const r          = cached;
      const absorption = r._instLayer?.hiddenFlow?.confidence ?? 0;
      const obRatio    = r.orderBook?.ratio ?? r.instGrade?.obRatio;
      const tf         = r._instLayer?.tfHierarchy;
      await send(uid,
        `📊 *Full Analysis — ${symbol}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Institutional Score:* ${r.instGrade?.iScore ?? '?'}/100\n` +
        `*Verdict:* ${r._instLayer?.verdict?.verdict ?? 'WATCH'}\n\n` +
        `*Smart Money:*\n` +
        ` · Absorption: ${absorption}/100  ${absorption >= 90 ? '🔥 Max' : absorption >= 70 ? '✅ Strong' : absorption >= 50 ? '🟡 Moderate' : '⚪ Weak'}\n` +
        ` · Flow type:  ${r._instLayer?.hiddenFlow?.type ?? 'None detected'}\n` +
        (obRatio ? ` · OB ratio:   ${obRatio.toFixed(2)}x bids\n` : '') +
        `\n*Timeframes:*\n` +
        (tf ? ` · Alignment:  ${tf.conflictType ?? 'UNKNOWN'}\n · 15m: ${tf.tf15m?.trend ?? '?'} | 1h: ${tf.tf1h?.trend ?? '?'} | 4h: ${tf.tf4h?.trend ?? '?'}\n` : ' · No TF data\n') +
        `\n*Structure:*\n` +
        ` · Spring: ${r.spring?.spring ? '✅ Yes' : '—'}\n` +
        ` · Shakeout: ${r._instLayer?.shakeout?.shakeout ? '✅ Yes' : '—'}\n` +
        ` · MM Trap: ${r._instLayer?.mmTrap?.trap ? '⚠️ Yes' : '—'}\n` +
        ` · Explosion readiness: ${r.explosionReadiness?.score ?? '?'}/100\n\n` +
        `*Targets if entering:*\n` +
        ` SL: \`${bridge.fmtPrice(r.sl)}\` | TP1: \`${bridge.fmtPrice(r.tp1)}\` | TP2: \`${bridge.fmtPrice(r.tp2)}\``,
        {
          inline_keyboard: [[
            { text: '✅ I want to enter', callback_data: `sig_enter_${symbol}` },
            { text: '👀 Watch it',        callback_data: `sig_watch_${symbol}` },
          ]],
        }
      );
      return;
    }

    if (data.startsWith('sig_enter_')) {
      const symbol = data.replace('sig_enter_', '');
      const cached = signalCache.get(symbol);
      if (!cached) { await send(uid, `⚠️ Signal for ${symbol} expired. Wait for the next scan.`); return; }
      const plan = bridge.buildEntryPlan(cached, uid);
      if (!plan) { await send(uid, '⚠️ Could not build entry plan.'); return; }
      await send(uid, plan.text, plan.inlineKeyboard);
      return;
    }

    if (data.startsWith('sig_watch_')) {
      const symbol = data.replace('sig_watch_', '');
      watchlist.addToWatchlist(uid, symbol, 'From signal alert');
      await answerCb(query.id, `👀 Added ${symbol} to watchlist`);
      return;
    }

    if (data.startsWith('sig_skip_')) {
      await edit(uid, mid, `❌ Skipped. I'll keep scanning.`);
      return;
    }

    // ── ENTRY CONFIRMATION ───────────────────────────────────────────────────
    if (data.startsWith('enter_market_')) {
      const symbol = data.replace('enter_market_', '');
      await handleMarketEntry(uid, symbol, mid);
      return;
    }

    if (data.startsWith('enter_custom_')) {
      const symbol = data.replace('enter_custom_', '');
      setState(uid, { awaitingCustomPrice: symbol });
      await send(uid, `📝 Type your entry price for *${symbol}*:\n_(Just the number, e.g. 0.4521)_`);
      return;
    }

    // ── TP1 CALLBACKS ────────────────────────────────────────────────────────
    if (data.startsWith('tp1_done_')) {
      const tradeId = data.replace('tp1_done_', '');
      store.updateTrade(tradeId, { partialExited: true, partialExitPct: 50, stopMovedToEntry: true });
      await edit(uid, mid, `✅ Noted! 50% sold, stop moved to entry.\n\nYour remaining position is now *risk-free*. Let it run.`);
      return;
    }

    if (data.startsWith('tp1_hold_')) {
      await edit(uid, mid, `🚀 Holding all in. I'll watch closely and alert you at TP2 or if signals weaken.`);
      return;
    }

    if (data.startsWith('tp1_exit_')) {
      const tradeId = data.replace('tp1_exit_', '');
      const trade   = store.getTradeById(tradeId);
      if (trade) {
        const price = await getPrice(trade.symbol) ?? trade.tp1;
        const closed = store.closeTrade(tradeId, price, 'tp1');
        await edit(uid, mid, `💰 Full exit recorded. +${closed.pnlPct}%\n\n` + perf.buildPostTradeDebrief(closed));
      }
      return;
    }

    // ── TP2 CALLBACKS ────────────────────────────────────────────────────────
    if (data.startsWith('tp2_exit_')) {
      const tradeId = data.replace('tp2_exit_', '');
      const trade   = store.getTradeById(tradeId);
      if (trade) {
        const price  = await getPrice(trade.symbol) ?? trade.tp2;
        const closed = store.closeTrade(tradeId, price, 'tp2');
        await edit(uid, mid, `💰 Excellent! Full exit at TP2. *+${closed.pnlPct}%*\n\n` + perf.buildPostTradeDebrief(closed));
      }
      return;
    }

    // ── EXIT CALLBACKS ────────────────────────────────────────────────────────
    if (data.startsWith('exit_done_')) {
      const tradeId = data.replace('exit_done_', '');
      const trade   = store.getTradeById(tradeId);
      if (trade) {
        const price  = await getPrice(trade.symbol) ?? trade.entry;
        const closed = store.closeTrade(tradeId, price, 'signal_exit');
        await edit(uid, mid, `✅ Exit recorded.\n\n` + perf.buildPostTradeDebrief(closed));
      }
      return;
    }

    if (data.startsWith('exit_wait_')) {
      await edit(uid, mid, `⏳ Okay. I'll check again in 15 minutes. Keep your stop in place.`);
      return;
    }

    if (data.startsWith('exit_explain_')) {
      const tradeId = data.replace('exit_explain_', '');
      const trade   = store.getTradeById(tradeId);
      if (trade) {
        await send(uid,
          `*Why I said exit for ${trade.symbol}:*\n\n` +
          `The institutional analysis detected one or more of:\n` +
          ` · Market Maker Trap — a fake breakout designed to trap buyers\n` +
          ` · Hidden seller — a large entity selling into every push\n` +
          ` · Timeframe conflict — 4H structure turned bearish\n` +
          ` · Trend stop — price broke below key support\n\n` +
          `_These are high-probability exit signals. Missing them costs more than small early exits._`
        );
      }
      return;
    }

    // ── DEBRIEF ───────────────────────────────────────────────────────────────
    if (data.startsWith('debrief_')) {
      const tradeId = data.replace('debrief_', '');
      const trade   = store.getTradeById(tradeId);
      if (trade) await send(uid, perf.buildPostTradeDebrief(trade));
      return;
    }

    // ── PORTFOLIO / STATS ─────────────────────────────────────────────────────
    if (data === 'show_stats')     { await send(uid, perf.buildStatsSummary(uid));       return; }
    if (data === 'show_watchlist') { await send(uid, watchlist.buildWatchlistSummary(uid)); return; }
    if (data === 'show_heat')      { await send(uid, risk.buildHeatSummary(uid));           return; }
    if (data === 'show_sectors')   { await send(uid, sector.buildSectorCard());             return; }

    // ── PROFILE EDITS ─────────────────────────────────────────────────────────
    if (data === 'profile_edit_risk') {
      await send(uid, 'Choose new risk per trade:', {
        inline_keyboard: [
          [{ text: '1% (very safe)',    callback_data: 'set_risk_0.01' }],
          [{ text: '2% (conservative)', callback_data: 'set_risk_0.02' }],
          [{ text: '3% (moderate)',     callback_data: 'set_risk_0.03' }],
          [{ text: '5% (aggressive)',   callback_data: 'set_risk_0.05' }],
        ],
      });
      return;
    }
    if (data.startsWith('set_risk_')) {
      const val = parseFloat(data.replace('set_risk_', ''));
      profile.updateProfile(uid, { riskPct: val });
      await send(uid, `✅ Risk per trade updated to ${(val * 100).toFixed(0)}%.`);
      return;
    }
    if (data === 'profile_edit_filter') {
      await send(uid, 'Minimum signal grade to receive:', {
        inline_keyboard: [
          [{ text: 'A+ only (highest quality)',     callback_data: 'set_filter_A+' }],
          [{ text: 'A and above (recommended)',     callback_data: 'set_filter_A'  }],
          [{ text: 'B and above (more signals)',    callback_data: 'set_filter_B'  }],
          [{ text: 'All signals (advanced)',        callback_data: 'set_filter_C'  }],
        ],
      });
      return;
    }
    if (data.startsWith('set_filter_')) {
      const val = data.replace('set_filter_', '');
      profile.updateProfile(uid, { signalFilter: val });
      await send(uid, `✅ Signal filter set to Grade ${val} and above.`);
      return;
    }

    // ── HELP CALLBACK ─────────────────────────────────────────────────────────
    if (data === 'help_sl') {
      await send(uid,
        `*How to set a Stop Loss on Binance:*\n\n` +
        `1. Open Binance → Trade → [your coin]\n` +
        `2. On the order form, select *Stop-Limit*\n` +
        `3. Set *Stop* = your SL price (e.g. 0.4420)\n` +
        `4. Set *Limit* = SL price minus 0.2% (to ensure fill)\n` +
        `5. Set *Amount* = your full position size\n` +
        `6. Tap *Sell* → Confirm\n\n` +
        `Your position is now protected. ✅`
      );
      return;
    }

  } catch (e) {
    console.error('[Callback]', data, e.message);
  }
});

// ─── TEXT MESSAGE HANDLER (custom price input, etc.) ─────────────────────────

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // commands handled above
  const uid   = msg.chat.id;
  const state = getState(uid);

  if (state.awaitingCustomPrice) {
    const symbol = state.awaitingCustomPrice;
    const price  = parseFloat(msg.text?.trim());
    clearState(uid);

    if (isNaN(price) || price <= 0) {
      await send(uid, '⚠️ Invalid price. Try again or use /status to cancel.');
      return;
    }
    await handleMarketEntry(uid, symbol, null, price);
    return;
  }
});

// ─── ENTRY HANDLER ───────────────────────────────────────────────────────────

async function handleMarketEntry(uid, symbol, msgId, customPrice = null) {
  const cached = signalCache.get(symbol);
  const sizes  = profile.calcPositionSizes(uid);
  if (!sizes) { await send(uid, '⚠️ Profile not found. Use /start to set up.'); return; }

  const gate = risk.gateCheck(uid, sizes.recommended, symbol);
  if (!gate.allowed) {
    await send(uid, `⛔ ${gate.reason}`);
    return;
  }
  for (const w of gate.warnings) {
    await send(uid, w);
    await sleep(300);
  }

  const entryPrice = customPrice ?? cached?.entry ?? null;
  if (!entryPrice) { await send(uid, '⚠️ Could not determine entry price. Use /track SYMBOL PRICE manually.'); return; }

  const signalData = cached
    ? { ...cached, entry: entryPrice }
    : {
        symbol,
        entry  : entryPrice,
        sl     : entryPrice * 0.975,
        tp1    : entryPrice * 1.025,
        tp2    : entryPrice * 1.055,
        moon   : entryPrice * 1.15,
        signalGrade: 'B',
      };

  const trade = store.openTrade(uid, sizes.recommended, signalData);

  const checklist = (
    `✅ *Trade ${trade.id} opened — ${symbol}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Entry: \`${bridge.fmtPrice(entryPrice)}\`\n` +
    `Size:  $${sizes.recommended}\n` +
    `SL:    \`${bridge.fmtPrice(trade.sl)}\`  (-${((Math.abs(entryPrice - trade.sl) / entryPrice) * 100).toFixed(1)}%)\n` +
    `TP1:   \`${bridge.fmtPrice(trade.tp1)}\`\n` +
    `TP2:   \`${bridge.fmtPrice(trade.tp2)}\`\n\n` +
    `*Your checklist:*\n` +
    ` ☐ Set stop loss at \`${bridge.fmtPrice(trade.sl)}\` on Binance NOW\n` +
    ` ☐ Don't check price every 5 minutes — I'll alert you\n` +
    ` ☐ Trust the plan and your stop\n\n` +
    `_I'm watching this for you._`
  );

  await send(uid, checklist, {
    inline_keyboard: [[
      { text: '✅ Stop set',        callback_data: `ack_${trade.id}` },
      { text: '❓ How to set stop', callback_data: 'help_sl'         },
    ]],
  });
}

// ─── SIGNAL CACHE ─────────────────────────────────────────────────────────────
// Holds the latest scanner result per symbol so callback handlers can reference it.
// Signals expire after 30 min.

const signalCache = new Map();

function cacheSignal(scannerResult) {
  signalCache.set(scannerResult.symbol, { ...scannerResult, _cachedAt: Date.now() });
  // Auto-expire after 30 min
  setTimeout(() => signalCache.delete(scannerResult.symbol), 30 * 60 * 1000);
}

// ─── SCANNER INTEGRATION ─────────────────────────────────────────────────────
// This function is called by the scanner loop in scanner_v6.js
// (or from the scan loop below) once a valid signal is produced.

async function broadcastSignal(scannerResult) {
  try {
    cacheSignal(scannerResult);
    sector.recordSignal(scannerResult.symbol, scannerResult.instGrade?.iScore ?? 50);

    // Check for dangerous news before broadcasting
    const dangerCheck = await news.checkDangerousNews(scannerResult.symbol);
    if (dangerCheck.danger) {
      console.warn(`[Broadcast] Blocked ${scannerResult.symbol} — dangerous news: ${dangerCheck.reason}`);
      return;
    }

    // Fetch async extras once — shared across all recipients
    const [newsSummary, rotationLine] = await Promise.all([
      news.buildNewsSummary(scannerResult.symbol),
      Promise.resolve(sector.buildRotationLine(scannerResult.symbol)),
    ]);
    const extras = { newsSummary, rotationLine };

    // Post to channel first (shared, no personal sizes)
    if (channelId) {
      try {
        const channelPost = bridge.buildChannelPost(scannerResult, extras, CONFIG.BOT_USERNAME);
        await bot.sendMessage(channelId, channelPost.text, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('[Channel]', e.message);
      }
    }

    const recipients = bridge.getEligibleUsers(scannerResult);
    for (const { userId, isWatched, alertType } of recipients) {
      const alert = alertType === 'accumulation'
        ? bridge.buildAccumulationAlert(scannerResult, userId, isWatched, extras)
        : bridge.buildSignalAlert(scannerResult, userId, isWatched, extras);
      await send(userId, alert.text, alert.inlineKeyboard);
      if (isWatched && alertType !== 'accumulation') {
        watchlist.markTriggered(userId, scannerResult.symbol);
      }
      await sleep(200);
    }
  } catch (e) {
    console.error('[Broadcast]', e.message);
  }
}

// ─── INST ANALYSIS (lightweight — for monitor) ────────────────────────────────

async function getLightInstAnalysis(symbol) {
  try {
    const [c15, c1h] = await Promise.all([
      getCandles(symbol, '15m', 80),
      getCandles(symbol, '1h',  40),
    ]);
    if (!c15) return null;

    const { closes, highs, lows, volumes } = c15;
    const n = closes.length;
    const rsi = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0] ?? 50;

    const e7   = EMA.calculate({ values: closes, period: 7  }).slice(-1)[0];
    const e25  = EMA.calculate({ values: closes, period: 25 }).slice(-1)[0];
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volTrend = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

    const macdArr = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const m1 = macdArr[macdArr.length - 1];
    const m0 = macdArr[macdArr.length - 2];
    const macdRising = (m1?.histogram ?? 0) > (m0?.histogram ?? 0);

    let contScore = 50;
    const warnings = [];

    if (rsi > 75)           { contScore -= 15; warnings.push(`RSI overbought (${rsi.toFixed(0)})`); }
    else if (rsi > 50)      { contScore += 10; }
    if (e7 > e25)           { contScore += 15; }
    else                    { contScore -= 10; warnings.push('EMA bearish crossover'); }
    if (macdRising)         { contScore += 10; }
    else                    { contScore -= 10; warnings.push('MACD declining'); }
    if (volTrend < 0.7)     { contScore -= 10; warnings.push('Volume declining'); }

    const hlBroken = closes[n-1] < Math.min(...lows.slice(-5, -1));
    if (hlBroken)           { contScore -= 20; warnings.push('Price broke below recent lows'); }

    // Check 1h
    if (c1h) {
      const rsi1h = RSI.calculate({ values: c1h.closes, period: 14 }).slice(-1)[0] ?? 50;
      const e7_1h  = EMA.calculate({ values: c1h.closes, period: 7  }).slice(-1)[0];
      const e25_1h = EMA.calculate({ values: c1h.closes, period: 25 }).slice(-1)[0];
      if (e7_1h < e25_1h) { contScore -= 15; warnings.push('1H EMA bearish'); }
      if (rsi1h > 72)      { contScore -= 10; warnings.push(`1H RSI overbought (${rsi1h.toFixed(0)})`); }
    }

    contScore = Math.max(0, Math.min(100, contScore));
    let verdict;
    if (contScore >= 70)      verdict = 'BUY';
    else if (contScore >= 50) verdict = 'WATCH';
    else if (contScore >= 35) verdict = 'WAIT';
    else                      verdict = 'AVOID';

    const trendStatus = hlBroken ? 'Trend Stop'
      : e7 < e25 ? 'Weakening'
      : 'Continuation Moderate';

    return { contScore, warnings, verdict, trendStatus, mmTrap: false, tfConflict: 'UNKNOWN' };
  } catch { return null; }
}

// ─── MONITOR LOOP ─────────────────────────────────────────────────────────────

async function runMonitorLoop() {
  await monitor.runMonitor(
    (userId, text, kb) => send(userId, text, kb),
    getPrice,
    getLightInstAnalysis
  );
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function normalizeSymbol(s) {
  const up = s.toUpperCase();
  return up.endsWith('USDT') ? up : up + 'USDT';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function guardOnboarded(uid) {
  if (!profile.isOnboarded(uid)) {
    send(uid, `⚠️ Please complete setup first. Type /start`);
    return false;
  }
  return true;
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  CRYPTO TRADING GUIDE BOT — Starting');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Start monitor loop every 5 minutes
setInterval(runMonitorLoop, CONFIG.SCAN_INTERVAL_MS);

// Run once immediately on startup
runMonitorLoop().catch(e => console.error('[Monitor startup]', e.message));

console.log('  Bot polling started. Waiting for users...\n');

// ─── EXPORTS (for scanner_v6.js integration) ─────────────────────────────────
module.exports = { broadcastSignal, cacheSignal };
