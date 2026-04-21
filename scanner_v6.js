/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           INSTITUTIONAL CRYPTO SCANNER v6.0                             ║
 * ║   Original v5.0 + Institutional Intelligence Layer v2.0                 ║
 * ║                                                                          ║
 * ║  WHAT'S NEW IN v6.0:                                                    ║
 * ║  + Engine Conflict Resolver (DISTRIBUTION vs ABSORBING explained)       ║
 * ║  + Hidden Buyer / Hidden Seller Detector                                 ║
 * ║  + Weak-Hand Shakeout Detector                                           ║
 * ║  + Market Maker Trap Detector                                            ║
 * ║  + 4H Timeframe Hierarchy (15m + 1h + 4h alignment)                    ║
 * ║  + Market Regime Detector (trending / ranging / volatile)               ║
 * ║  + Institutional Final Verdict — single clear decision                  ║
 * ║  + Smart Tracker Upgrade — CONTINUING / DIP / DISTRIBUTION / EXIT       ║
 * ║  + Cleaner Telegram signals with conflict explanations                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
'use strict';

const axios = require('axios');
const { RSI, MACD, EMA, ATR } = require('technicalindicators');
const fs = require('fs');
const { forwardSignal } = require('./src/scannerPatch');

process.on('uncaughtException',  e => console.error('[Crash]',     e.message));
process.on('unhandledRejection', e => console.error('[Rejection]', e?.message ?? e));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
    TELEGRAM_TOKEN       : 'YOUR_SCANNER_TOKEN_HERE',    // ← replace
    CHAT_ID              : 'YOUR_CHAT_ID_HERE',           // ← replace

    SCAN_INTERVAL_MS     : 5 * 60 * 1000,
    CANDLE_LIMIT         : 120,
    INTERVAL_PRIMARY     : '15m',
    INTERVAL_CONFIRM     : '1h',
    BATCH_SIZE           : 8,
    BATCH_DELAY_MS       : 600,
    MAX_RESULTS          : 8,
    ALERT_COOLDOWN       : 1 * 60 * 60 * 1000,
    UPDATE_COOLDOWN      : 7 * 60 * 1000,

    MIN_VOLUME_USDT      : 300_000,
    MAX_VOLUME_USDT      : 300_000_000,
    TOP_PAIRS            : 200,

    MIN_SCORE            : 9,
    MIN_CONT_PROB        : 35,
    MIN_ATR_PCT          : 0.3,
    MIN_MOMENTUM         : 2,

    // Targets
    MIN_TP1_PCT          : 0.03,
    MIN_TP2_PCT          : 0.07,
    MIN_MOON_PCT         : 0.15,
    MAX_MOON_PCT         : 0.40,
    MIN_SL_PCT           : 0.025,
    TP1_ATR              : 2.5,
    TP2_ATR              : 5.0,
    MOON_ATR             : 10.0,
    SL_ATR               : 1.5,

    OB_LEVELS            : 20,
    BUY_WALL_RATIO       : 3.0,
    SELL_WALL_RATIO      : 3.0,

    // Gann
    GANN_CYCLES          : [7, 9, 12, 21, 27],
    GANN_TOLERANCE       : 1,

    // Pre-pump detection thresholds
    PREPUMP_VOL_Z        : 2.0,
    PREPUMP_VOL_RATIO    : 2.0,       // volume ratio threshold (was 3.0 — lowered to catch stealth accumulation)
    PREPUMP_MIN_SCORE    : 7,

    // VPIN toxicity
    VPIN_TOXIC           : 0.60,
    VPIN_EXTREME         : 0.75,

    // Tracker config
    TRACKER_FILE         : './tracker_v5.json',
    TRACKER_REVIEW_MS    : 5 * 60 * 1000,
    TRACKER_MAX_AGE_DAYS : 7,
};

const HEAVY_COINS = new Set([
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    'USDCUSDT','BUSDUSDT','FDUSDUSDT','WBTCUSDT',
    'DOGEUSDT','ADAUSDT','TRXUSDT','LTCUSDT',
    'AVAXUSDT','SHIBUSDT','DOTUSDT','LINKUSDT','TONUSDT',
]);

// ─── GLOBAL STATE ────────────────────────────────────────────────────────────
const alertCache  = new Map();
const updateCache = new Map();
let _btcMomCache  = null;
let _btcMomTime   = 0;

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
    const parts = splitMsg(text);
    for (const p of parts) {
        try {
            await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CONFIG.CHAT_ID, text: p, parse_mode: 'Markdown',
            });
        } catch (e) {
            const status = e.response?.status;
            const tgErr  = e.response?.data?.description ?? e.message;
            if (status === 400) {
                console.error(`[TG] Markdown rejected (${tgErr}) — retrying as plain text`);
                try {
                    const plain = p.replace(/[*_`\[\]]/g, '');
                    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
                        chat_id: CONFIG.CHAT_ID, text: plain,
                    });
                } catch (e2) {
                    console.error('[TG] Plain-text retry also failed:', e2.response?.data?.description ?? e2.message);
                }
            } else {
                console.error(`[TG] HTTP ${status ?? '?'}:`, tgErr);
            }
        }
        if (parts.length > 1) await sleep(400);
    }
}
function splitMsg(text, max = 2800) {
    const parts = []; let cur = '';
    for (const line of text.split('\n')) {
        if ((cur+'\n'+line).length > max) { if (cur) parts.push(cur.trim()); cur = line; }
        else cur += (cur ? '\n' : '') + line;
    }
    if (cur) parts.push(cur.trim());
    return parts;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeTxt(s) { return String(s ?? '').replace(/[*_`\[\]]/g, ''); }

// ─── BINANCE ─────────────────────────────────────────────────────────────────
const BINANCE_HOSTS = [
    'https://data-api.binance.vision',
    'https://api4.binance.com',
    'https://api3.binance.com',
];
async function safeGet(path) {
    for (const host of BINANCE_HOSTS) {
        for (let i = 0; i < 8; i++) {
            try {
                return await axios.get(host + path, {
                    timeout: 25000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (CryptoScanner/6.0)' },
                });
            } catch { await sleep(1000 * (i + 1)); }
        }
    }
    return null;
}
async function getCandles(symbol, interval, limit = CONFIG.CANDLE_LIMIT) {
    const res = await safeGet(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res) return null;
    return {
        opens   : res.data.map(c => parseFloat(c[1])),
        highs   : res.data.map(c => parseFloat(c[2])),
        lows    : res.data.map(c => parseFloat(c[3])),
        closes  : res.data.map(c => parseFloat(c[4])),
        volumes : res.data.map(c => parseFloat(c[5])),
    };
}
async function getOrderBook(symbol) {
    const res = await safeGet(`/api/v3/depth?symbol=${symbol}&limit=${CONFIG.OB_LEVELS}`);
    if (!res) return null;
    try {
        const bids = (res.data.bids ?? []).map(([p,q]) => ({ price: +p, qty: +q })).filter(b => isFinite(b.price) && b.qty > 0);
        const asks = (res.data.asks ?? []).map(([p,q]) => ({ price: +p, qty: +q })).filter(a => isFinite(a.price) && a.qty > 0);
        if (!bids.length || !asks.length) return null;
        return { bids, asks };
    } catch { return null; }
}
async function getPrice(symbol) {
    const res = await safeGet(`/api/v3/ticker/price?symbol=${symbol}`);
    return res ? parseFloat(res.data.price) : null;
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────
function fmt(v) {
    const n = Number(v);
    if (!isFinite(n) || n === 0) return 'N/A';
    if (n < 0.001)  return n.toFixed(8);
    if (n < 0.01)   return n.toFixed(6);
    if (n < 1)      return n.toFixed(5);
    if (n >= 1000)  return n.toFixed(2);
    return n.toFixed(4);
}
function pct(a, b) {
    if (!a || !b || !isFinite(a) || !isFinite(b)) return 'N/A';
    return (((b - a) / a) * 100).toFixed(1);
}
function calcStdDev(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const mean = arr.reduce((a,b)=>a+b,0) / n;
    return Math.sqrt(arr.reduce((s,x)=>s+(x-mean)**2,0) / n);
}
function utcHour() { return new Date().getUTCHours(); }

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 1 — VOLUME Z-SCORE PRE-PUMP DETECTOR
// ═══════════════════════════════════════════════════════════════════════════
function volumeZScore(volumes) {
    const n      = volumes.length;
    const recent = volumes[n - 1];
    const window = volumes.slice(-21, -1);
    const mean   = window.reduce((a,b)=>a+b,0) / window.length;
    const std    = calcStdDev(window);
    const z      = std > 0 ? (recent - mean) / std : 0;
    const ratio  = mean > 0 ? recent / mean : 1;
    const vol3d  = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const vol14d = volumes.slice(-14).reduce((a,b)=>a+b,0) / 14;
    const stealth = vol3d > vol14d * 1.5;
    return {
        z           : +z.toFixed(2),
        ratio       : +ratio.toFixed(2),
        stealth,
        highAnomaly : z > CONFIG.PREPUMP_VOL_Z && ratio > CONFIG.PREPUMP_VOL_RATIO,
        medAnomaly  : z > 1.2 && ratio > 1.5,
        isPrePump   : z > CONFIG.PREPUMP_VOL_Z && ratio > CONFIG.PREPUMP_VOL_RATIO,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 2 — WYCKOFF SPRING DETECTOR
// ═══════════════════════════════════════════════════════════════════════════
function detectWyckoffSpring(closes, highs, lows, volumes) {
    const n = closes.length;
    if (n < 20) return { spring: false, score: 0 };
    const rangeHigh  = Math.max(...highs.slice(-15));
    const rangeLow   = Math.min(...lows.slice(-15));
    const rangeSize  = (rangeHigh - rangeLow) / closes[n-1];
    const inRange    = rangeSize < 0.08;
    const recentLow  = Math.min(...lows.slice(-3));
    const springDip  = recentLow < rangeLow * 0.998;
    const volAvg20   = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const lowVolDip  = volumes[n-1] < volAvg20 * 0.8;
    const recovered  = closes[n-1] > rangeLow;
    const cRange     = highs[n-1] - lows[n-1];
    const rejTail    = lows[n-1] < rangeLow ? (closes[n-1] - lows[n-1]) / (cRange || 1) > 0.5 : false;
    const postVol    = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const volExpand  = postVol > volAvg20;
    let score = 0;
    if (inRange)    score += 20;
    if (springDip)  score += 25;
    if (lowVolDip)  score += 20;
    if (recovered)  score += 20;
    if (rejTail)    score += 10;
    if (volExpand)  score += 5;
    return { spring: score >= 70, score, inRange, springDip, lowVolDip, recovered, rejTail };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 3 — VPIN TOXICITY METER
// ═══════════════════════════════════════════════════════════════════════════
function calcVPIN(closes, volumes, buckets = 10) {
    const n = closes.length;
    if (n < buckets + 1) return { vpin: 0.5, toxic: false, extreme: false };
    let imbalanceSum = 0;
    const bucketSize = volumes.slice(-buckets).reduce((a,b)=>a+b,0) / buckets;
    for (let i = n - buckets; i < n; i++) {
        const ret = closes[i] - closes[i-1];
        const std = calcStdDev(closes.slice(Math.max(0,i-10),i)) || 0.001;
        const phi = 1 / (1 + Math.exp(-1.7 * (ret / std)));
        const imb = Math.abs(volumes[i] * phi - volumes[i] * (1-phi)) / (bucketSize || 1);
        imbalanceSum += Math.min(imb, 1);
    }
    const vpin = imbalanceSum / buckets;
    return { vpin: +vpin.toFixed(3), toxic: vpin > CONFIG.VPIN_TOXIC, extreme: vpin > CONFIG.VPIN_EXTREME };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 4 — HURST EXPONENT REGIME
// ═══════════════════════════════════════════════════════════════════════════
function calcHurst(prices) {
    const n = prices.length;
    if (n < 22) return { hurst: 0.5, regime: 'UNKNOWN' };
    const lags = [], logRS = [];
    for (let lag = 2; lag <= Math.min(20, n-2); lag++) {
        const chunks = [];
        for (let start = 0; start + lag <= n; start += lag) {
            const chunk = prices.slice(start, start + lag);
            const mean  = chunk.reduce((a,b)=>a+b,0) / chunk.length;
            const devs  = chunk.map(p => p - mean);
            let cum = 0, maxD = -Infinity, minD = Infinity;
            devs.forEach(d => { cum += d; if (cum>maxD) maxD=cum; if (cum<minD) minD=cum; });
            const std = calcStdDev(chunk) || 1e-10;
            chunks.push((maxD - minD) / std);
        }
        const avgRS = chunks.reduce((a,b)=>a+b,0) / chunks.length;
        if (avgRS > 0) { lags.push(Math.log(lag)); logRS.push(Math.log(avgRS)); }
    }
    if (lags.length < 3) return { hurst: 0.5, regime: 'UNKNOWN' };
    const n2 = lags.length;
    const xM = lags.reduce((a,b)=>a+b,0)/n2;
    const yM = logRS.reduce((a,b)=>a+b,0)/n2;
    let num=0, den=0;
    for (let i=0; i<n2; i++) { num+=(lags[i]-xM)*(logRS[i]-yM); den+=(lags[i]-xM)**2; }
    const h = Math.max(0.1, Math.min(0.9, den>0 ? num/den : 0.5));
    const regime = h > 0.55 ? 'TRENDING' : h < 0.45 ? 'MEAN_REV' : 'RANDOM';
    return { hurst: +h.toFixed(3), regime };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 5 — TSMOM SIGNAL
// ═══════════════════════════════════════════════════════════════════════════
function calcTSMOM(closes) {
    const n = closes.length;
    const lookbacks = [1, 7, 14, 30];
    const weights   = [0.40, 0.30, 0.20, 0.10];
    let signal = 0, totalW = 0;
    for (let i = 0; i < lookbacks.length; i++) {
        const bars = Math.min(lookbacks[i] * 4, n - 1);
        if (n <= bars) continue;
        signal += weights[i] * Math.sign(closes[n-1] - closes[n-1-bars]);
        totalW += weights[i];
    }
    const normalized = totalW > 0 ? signal / totalW : 0;
    return { signal: +normalized.toFixed(3), bullish: normalized > 0.2, bearish: normalized < -0.2 };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 6 — BTC CROSS-ASSET MOMENTUM
// ═══════════════════════════════════════════════════════════════════════════
async function getBTCMomentum() {
    if (_btcMomCache && Date.now() - _btcMomTime < 5 * 60 * 1000) return _btcMomCache;
    const c = await getCandles('BTCUSDT', '1h', 50);
    if (!c) return { bullish: null };
    const closes = c.closes;
    const e50    = EMA.calculate({ values: closes, period: 50 }).slice(-1)[0];
    const price  = closes[closes.length-1];
    const rsi    = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
    const tsmom  = calcTSMOM(closes);
    const result = { bullish: price > e50 && rsi > 45 && tsmom.bullish, btcRSI: rsi };
    _btcMomCache = result;
    _btcMomTime  = Date.now();
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 7 — PARABOLIC MOVE DETECTOR
// ═══════════════════════════════════════════════════════════════════════════
function detectParabolicMove(closes, highs, lows) {
    const n = closes.length;
    if (n < 20) return { parabolic: false, phase: 'NORMAL', atrExp: 1 };
    const atrFn  = (h,l,c,p) => { const a = ATR.calculate({high:h,low:l,close:c,period:p}); return a[a.length-1] ?? 0; };
    const atrNow  = atrFn(highs.slice(-5),      lows.slice(-5),      closes.slice(-5),      5);
    const atrBase = atrFn(highs.slice(-20,-5),  lows.slice(-20,-5),  closes.slice(-20,-5),  14);
    const atrExp  = atrBase > 0 ? atrNow / atrBase : 1;
    const ema9    = EMA.calculate({ values: closes, period: 9 });
    const ema21   = EMA.calculate({ values: closes, period: 21 });
    const eLen    = Math.min(ema9.length, ema21.length);
    const delta   = ema9.slice(-eLen).map((v,i) => v - ema21.slice(-eLen)[i]);
    const dSlope  = delta.length > 2 ? delta[delta.length-1] - delta[delta.length-2] : 0;
    const dAccel  = delta.length > 3 ? dSlope - (delta[delta.length-2] - delta[delta.length-3]) : 0;
    const parabolic = atrExp > 2.0 && dSlope > 0 && dAccel > 0;
    const blowoff   = atrExp > 3.0;
    let phase = 'NORMAL';
    if (blowoff)          phase = 'BLOWOFF';
    else if (parabolic)   phase = 'PARABOLIC';
    else if (atrExp > 1.5) phase = 'EXPANDING';
    return { parabolic, blowoff, phase, atrExp: +atrExp.toFixed(2), dSlope: +dSlope.toFixed(4), dAccel: +dAccel.toFixed(4) };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUEPRINT ENGINE 8 — FAKE BREAKOUT DISCRIMINATOR
// ═══════════════════════════════════════════════════════════════════════════
function calcVWAP(highs, lows, closes, volumes) {
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < closes.length; i++) {
        const tp = (highs[i] + lows[i] + closes[i]) / 3;
        cumPV   += tp * volumes[i];
        cumVol  += volumes[i];
    }
    return cumVol > 0 ? cumPV / cumVol : closes[closes.length-1];
}
function fakeBreakoutCheck(closes, highs, lows, volumes, ob) {
    const n          = closes.length;
    const price      = closes[n-1];
    const vAvg20     = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const vRatio     = vAvg20 > 0 ? volumes[n-1] / vAvg20 : 1;
    const recent20High = Math.max(...highs.slice(-20,-1));
    const brokeHigh  = price > recent20High;
    const vwap       = calcVWAP(highs.slice(-30), lows.slice(-30), closes.slice(-30), volumes.slice(-30));
    const aboveVWAP  = price > vwap;
    const cRange     = highs[n-1] - lows[n-1];
    const uWick      = highs[n-1] - Math.max(closes[n-1], closes[n-2] ?? closes[n-1]);
    const wickRatio  = cRange > 0 ? uWick / cRange : 0;
    const strongClose = cRange > 0 ? (closes[n-1] - lows[n-1]) / cRange > 0.60 : false;
    const h = utcHour();
    const offHours = h < 6 || h > 22;
    let fakeReasons = [];
    if (brokeHigh && vRatio < 2.0 && (ob ? (ob.bids.reduce((s,b)=>s+b.qty,0)/(ob.bids.length||1)) < 1.5 : true)) fakeReasons.push('Low volume breakout');
    if (brokeHigh && !aboveVWAP) fakeReasons.push('Breakout below VWAP');
    if (wickRatio > 0.6)         fakeReasons.push('Rejection wick');
    if (brokeHigh && !strongClose) fakeReasons.push('Weak candle close');
    if (brokeHigh && offHours)   fakeReasons.push('Off-hours breakout');
    return { isFake: fakeReasons.length >= 2, fakeReasons, brokeHigh, aboveVWAP, strongClose, wickRatio: +wickRatio.toFixed(2), vwap };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXCLUDED TOKENS
// ═══════════════════════════════════════════════════════════════════════════
const EXCLUDED_TOKENS = new Set([
    'XAUTUSDT','XAGUSDT','PAXGUSDT',
    'DAIUSDT','TUSDUSDT','USDPUSDT','USDDUSDT','FRAXUSDT',
    'USTUSDT','CUSDUSDT','ALUSDUSDT','SUSDUSDT',
    'EURUSDT','GBPUSDT','AUDUSDT','TRYUSDT','BRLUSDT',
    'RUBUSDT','BIDRUSDT','IDRTUSDT','BVNDUSDT',
    'WBTCUSDT','WETHUSDT','STETHUSDT','RETHUSDT','CBETHUSDT',
    'BETHUSDT','WEETHUSDT',
    'BTCDOMUSDT','DEFIUSDT',
]);

function passesGate(ticker) {
    const vol    = parseFloat(ticker.quoteVolume);
    const change = parseFloat(ticker.priceChangePercent);
    if (HEAVY_COINS.has(ticker.symbol))       return false;
    if (EXCLUDED_TOKENS.has(ticker.symbol))   return false;
    if (vol < CONFIG.MIN_VOLUME_USDT)         return false;
    if (vol > CONFIG.MAX_VOLUME_USDT)         return false;
    if (change > 25 || change < -18)          return false;
    if (!/^[A-Z0-9]+USDT$/.test(ticker.symbol)) return false;
    if (/^(EUR|GBP|AUD|TRY|BRL|RUB|XAU|XAG|PAX|DAI|FRAX|SUSD|UST|CUSD)/.test(ticker.symbol)) return false;
    return true;
}

function passesEarlyGate(ticker, c15) {
    if (!c15) return false;
    const { highs, lows, closes, volumes } = c15;
    const n      = closes.length;
    const avgVol = volumes.slice(-20,-1).reduce((a,b)=>a+b,0) / 19;
    const vr     = volumes[n-1] / avgVol;
    if (vr > 1.15) return true;
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    if ((atrArr[atrArr.length-1] / closes[n-1]) * 100 > 1.0) return true;
    const range15  = (Math.max(...highs.slice(-15)) - Math.min(...lows.slice(-15))) / closes[n-1] * 100;
    const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    if (range15 < 6 && avgVol5 > avgVol20 * 1.3) return true;
    return false;
}

function detectSuddenVolumeIgnition(ticker, c15) {
    if (!c15) return false;
    const { opens, closes, volumes, highs, lows } = c15;
    const n      = closes.length;
    const avgVol = volumes.slice(-20,-1).reduce((a,b)=>a+b,0) / 19;
    const vr     = volumes[n-1] / avgVol;
    const bodyPct = Math.abs(closes[n-1]-opens[n-1]) / opens[n-1] * 100;
    return vr > 1.9 && bodyPct > 0.45 && closes[n-1] > closes[n-2] && closes[n-1] > opens[n-1];
}

function calcSmartTargets(entry, highs, lows, closes, momScore = 0, volRatio = 1) {
    const atrArr  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr     = atrArr[atrArr.length - 1];
    const atrPct  = (atr / entry) * 100;
    let tp2Mult = CONFIG.TP2_ATR, moonMult = CONFIG.MOON_ATR, moonCap = CONFIG.MAX_MOON_PCT;
    if (momScore >= 10 && volRatio > 2.2 && atrPct > 2)         { tp2Mult = 10; moonMult = 20; moonCap = 0.50; }
    else if (momScore >= 8 && volRatio > 1.8 && atrPct > 1.2)   { tp2Mult = 8;  moonMult = 15; moonCap = 0.45; }
    const tp1   = Math.max(entry + atr * CONFIG.TP1_ATR, entry * (1 + CONFIG.MIN_TP1_PCT));
    const tp2   = Math.max(entry + atr * tp2Mult,        entry * (1 + CONFIG.MIN_TP2_PCT));
    const moonP = Math.min(Math.max(entry + atr * moonMult, entry * (1 + CONFIG.MIN_MOON_PCT)), entry * (1 + moonCap));
    const sl    = Math.min(entry - atr * CONFIG.SL_ATR, entry * (1 - CONFIG.MIN_SL_PCT));
    return { tp1, tp2, moonP, sl, atr, atrPct };
}

function confirmHTF(htfCandles) {
    const { closes } = htfCandles;
    const n      = closes.length;
    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    const htfRSI = rsiArr[rsiArr.length - 1];
    if (htfRSI > 68 || htfRSI < 22) return { confirmed: false, reason: htfRSI > 68 ? '1h OB' : '1h OS', htfRSI: htfRSI.toFixed(1) };
    const e7    = EMA.calculate({ values: closes, period: 7 }).slice(-1)[0];
    const e25   = EMA.calculate({ values: closes, period: 25 }).slice(-1)[0];
    const e99   = EMA.calculate({ values: closes, period: 99 }).slice(-1)[0];
    const macd  = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const m1    = macd[macd.length - 1];
    const m0    = macd[macd.length - 2];
    const price = closes[n - 1];
    let htfScore = 0;
    if (e7 > e25)                                    htfScore++;
    if ((m1?.histogram ?? 0) > (m0?.histogram ?? 0)) htfScore++;
    if (price > e25)                                 htfScore++;
    if (price > e99 * 0.95)                          htfScore++;
    if (htfScore === 0) return { confirmed: false, reason: '1h No Structure', htfRSI: htfRSI.toFixed(1) };
    return { confirmed: htfScore >= 2, htfRSI: htfRSI.toFixed(1), htfScore, reason: htfScore < 2 ? '1h Partial' : '1h Bullish' };
}

function analyzeOrderBook(ob) {
    const empty = { signals: [], obScore: 0, buyWall: false, sellWall: false, imbalance: 0.5 };
    if (!ob?.bids?.length || !ob?.asks?.length) return empty;
    const avgBid  = ob.bids.reduce((s,b)=>s+b.qty,0) / ob.bids.length;
    const avgAsk  = ob.asks.reduce((s,a)=>s+a.qty,0) / ob.asks.length;
    const maxBid  = ob.bids.reduce((m,b)=>b.qty>m.qty?b:m, ob.bids[0]);
    const maxAsk  = ob.asks.reduce((m,a)=>a.qty>m.qty?a:m, ob.asks[0]);
    const bwr     = maxBid.qty / avgBid;
    const awr     = maxAsk.qty / avgAsk;
    const bw      = bwr >= CONFIG.BUY_WALL_RATIO;
    const sw      = awr >= CONFIG.SELL_WALL_RATIO;
    const totalBid = ob.bids.reduce((s,b)=>s+b.qty,0);
    const totalAsk = ob.asks.reduce((s,a)=>s+a.qty,0);
    const imb      = totalBid / (totalBid + totalAsk);
    const signals = []; let obScore = 0;
    if (bw)  { obScore += 3; signals.push(`Buy Wall ${bwr.toFixed(1)}x`); }
    if (sw)  { obScore -= 2; signals.push(`Sell Wall ${awr.toFixed(1)}x`); }
    if (imb > 0.65)                     { obScore += 2; signals.push(`OB Bullish ${(imb*100).toFixed(0)}%`); }
    if (totalBid / avgBid / 5 >= 2)     { obScore += 1; signals.push('Deep Liquidity'); }
    if (bwr > 10)                        { obScore -= 1; signals.push('Possible Spoof'); }
    if (awr > 10)                        { obScore -= 3; signals.push('Heavy Sell Pressure'); }
    return { signals, obScore, buyWall: bw, sellWall: sw, imbalance: imb, bwr: +bwr.toFixed(1), awr: +awr.toFixed(1) };
}

function detectGannWindow(lows) {
    let idx = -1;
    for (let i = lows.length - 4; i >= 5; i--) {
        if (lows[i]<lows[i-1] && lows[i]<lows[i-2] && lows[i]<lows[i+1] && lows[i]<lows[i+2]) {
            idx = i; break;
        }
    }
    if (idx === -1) return { active: false };
    const since = (lows.length - 1) - idx;
    for (const c of CONFIG.GANN_CYCLES) {
        if (Math.abs(since - c) <= CONFIG.GANN_TOLERANCE) return { active: true, cycle: c };
    }
    return { active: false };
}

function analyzeLiquidityFlow(closes, highs, lows, volumes) {
    const n = closes.length;
    let pos = 0, neg = 0;
    for (let i = n - 14; i < n; i++) {
        const tp  = (highs[i]+lows[i]+closes[i]) / 3;
        const tp0 = (highs[i-1]+lows[i-1]+closes[i-1]) / 3;
        const raw = tp * volumes[i];
        if (tp > tp0) pos += raw; else neg += raw;
    }
    const mfRatio   = neg === 0 ? 100 : pos / neg;
    const mfiValue  = 100 - (100 / (1 + mfRatio));
    const flowRecent = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const flowAvg    = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const flowRatio  = flowAvg > 0 ? flowRecent / flowAvg : 1;
    let lfScore = 0; const lfSignals = [];
    if (mfiValue > 60 && mfiValue < 80)    { lfScore += 3; lfSignals.push(`MFI Bullish ${mfiValue.toFixed(0)}`); }
    else if (mfiValue >= 40)               { lfScore += 1; lfSignals.push(`MFI Neutral ${mfiValue.toFixed(0)}`); }
    else if (mfiValue > 85)                { lfScore -= 2; lfSignals.push(`MFI Overbought ${mfiValue.toFixed(0)}`); }
    else                                   { lfScore -= 1; lfSignals.push(`MFI Weak ${mfiValue.toFixed(0)}`); }
    if (flowRatio >= 2.5)                  { lfScore += 4; lfSignals.push(`Liquidity Surge ${flowRatio.toFixed(1)}x`); }
    else if (flowRatio >= 1.5)             { lfScore += 2; lfSignals.push(`Liquidity Rising ${flowRatio.toFixed(1)}x`); }
    else if (flowRatio < 0.8)              { lfScore -= 1; lfSignals.push('Liquidity Leaving'); }
    if (closes[n-1] < closes[n-4] && flowRatio > 1.2) { lfScore += 3; lfSignals.push('Bullish Money Flow Divergence'); }
    return { lfScore, lfSignals, mfi: mfiValue.toFixed(1), flowRatio: flowRatio.toFixed(2), mfiValue };
}

function classifyVolumeIntent(closes, highs, lows, volumes, opens) {
    const n = closes.length;
    if (n < 6) return { intent: 'UNKNOWN', emoji: '❓', detail: 'Insufficient data', score: 0, line: '❓ Volume Intent: UNKNOWN' };

    let cvdRunning = 0;
    const cvdArr = [];
    const opns = opens ?? closes.map((c,i) => i > 0 ? closes[i-1] : c);
    for (let i = n - 20; i < n; i++) {
        const idx = Math.max(0, i);
        cvdRunning += closes[idx] > opns[idx] ? volumes[idx] : -volumes[idx];
        cvdArr.push(cvdRunning);
    }
    const cvdNow    = cvdArr[cvdArr.length - 1];
    const cvd5ago   = cvdArr[Math.max(0, cvdArr.length - 6)];
    const cvdRising  = cvdNow > cvd5ago;
    const cvdFalling = cvdNow < cvd5ago;

    const priceUp   = closes[n-1] > closes[n-6];
    const priceFlat = Math.abs((closes[n-1] - closes[n-6]) / closes[n-6] * 100) < 1.5;

    let buyScore = 0, sellScore = 0;
    let strongCloses = 0, rejectionWicks = 0, lowerWicks = 0;

    for (let i = n - 5; i < n; i++) {
        const o      = opns[i];
        const body   = closes[i] - o;
        const range  = highs[i] - lows[i];
        const uWick  = highs[i] - Math.max(closes[i], o);
        const lWick  = Math.min(closes[i], o) - lows[i];
        const bodyR  = range > 0 ? Math.abs(body) / range : 0;
        const uWickR = range > 0 ? uWick / range : 0;
        const lWickR = range > 0 ? lWick / range : 0;
        const volW   = volumes[i] / (volumes.slice(Math.max(0,i-10),i).reduce((a,b)=>a+b,0) / 10 || 1);

        if (body > 0) {
            if (bodyR > 0.5 && uWickR < 0.3) { buyScore += 2 * volW; strongCloses++; }
            else if (uWickR > 0.5)            { sellScore += 1 * volW; rejectionWicks++; }
            else                              { buyScore += 1 * volW; }
        } else {
            if (bodyR > 0.5 && lWickR < 0.3) { sellScore += 2 * volW; }
            else if (lWickR > 0.5)            { buyScore += 1 * volW; lowerWicks++; }
            else                              { sellScore += 1 * volW; }
        }
    }

    const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const avgVol10 = volumes.slice(-10,-5).reduce((a,b)=>a+b,0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const volTrend = avgVol10 > 0 ? avgVol5 / avgVol10 : 1;
    const volVsAvg = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

    let volTrendLabel, volTrendEmoji;
    if (volTrend > 1.5)      { volTrendLabel = `RISING FAST ${volTrend.toFixed(1)}x`; volTrendEmoji = '🔥'; }
    else if (volTrend > 1.1) { volTrendLabel = `RISING ${volTrend.toFixed(1)}x`;       volTrendEmoji = '📈'; }
    else if (volTrend < 0.7) { volTrendLabel = `FALLING ${volTrend.toFixed(1)}x`;      volTrendEmoji = '📉'; }
    else                     { volTrendLabel = `STABLE ${volTrend.toFixed(1)}x`;       volTrendEmoji = '➡️'; }

    const isAbsorption = volVsAvg > 1.5 && priceFlat;

    let cvdNote = '';
    if (priceUp && cvdRising)   cvdNote = 'Price up + CVD up — genuine buy pressure confirmed';
    if (priceUp && cvdFalling)  cvdNote = 'Price up but CVD falling — WARNING: distribution into rally';
    if (priceFlat && cvdRising) cvdNote = 'Price flat + CVD rising — absorption: buyers taking supply quietly';
    if (!priceUp && cvdRising)  cvdNote = 'Price down + CVD rising — hidden buying at lows (bullish divergence)';
    if (!priceUp && cvdFalling) cvdNote = 'Price down + CVD down — selling pressure dominant';

    const ratio = sellScore > 0 ? buyScore / sellScore : buyScore > 0 ? 10 : 1;
    let intent, emoji, detail, intentScore, explanation, actionHint;

    if (isAbsorption && cvdRising) {
        intent = 'ABSORPTION'; emoji = '🧲';
        detail = `Vol ${volVsAvg.toFixed(1)}x avg but price flat — sellers absorbed by buyers`;
        intentScore = 75;
        explanation = 'Whales quietly buying all sell orders. Price not moving yet because sellers keep providing. Classic pre-pump.';
        actionHint  = 'Strong pre-pump signal — hold or accumulate';
    } else if (isAbsorption) {
        intent = 'ABSORPTION'; emoji = '🧲';
        detail = `Vol ${volVsAvg.toFixed(1)}x avg, price flat — absorption underway`;
        intentScore = 60;
        explanation = 'High volume with no price movement = large buyer absorbing sells. Watch for breakout.';
        actionHint  = 'Wait for breakout confirmation';
    } else if (priceUp && cvdFalling) {
        intent = 'DISTRIBUTION'; emoji = '🔴';
        detail = `Price rising but CVD falling — smart money selling into retail buying`;
        intentScore = 20;
        explanation = 'DANGER: Price looks good but large players are SELLING. CVD measures real traded volume direction.';
        actionHint  = 'Tighten stop — consider partial exit';
    } else if (ratio >= 2.5 && cvdRising) {
        intent = 'STRONG BUYING'; emoji = '🟢';
        detail = `${ratio.toFixed(1)}:1 buy/sell + CVD rising — institutional buying confirmed`;
        intentScore = 90;
        explanation = `Strong candle closes (${strongCloses}/5 strong) + CVD rising = real money entering.`;
        actionHint  = 'High conviction entry — continuation likely';
    } else if (ratio >= 1.4 && cvdRising) {
        intent = 'BUYING'; emoji = '🟢';
        detail = `${ratio.toFixed(1)}:1 buy/sell ratio + CVD confirming`;
        intentScore = 65;
        explanation = `More buying than selling. ${lowerWicks > 2 ? `${lowerWicks} lower wicks defending price.` : ''}`;
        actionHint  = 'Moderate confidence — watch volume on next candle';
    } else if (ratio <= 0.4) {
        intent = 'STRONG DISTRIBUTION'; emoji = '🔴';
        detail = `${(1/ratio).toFixed(1)}:1 sell/buy — distribution dominant${cvdFalling ? ' + CVD falling' : ''}`;
        intentScore = 10;
        explanation = `${rejectionWicks > 2 ? `${rejectionWicks} rejection wicks detected.` : ''} Selling dominant.`;
        actionHint  = 'Exit or avoid — strong sell pressure';
    } else if (ratio <= 0.7) {
        intent = 'DISTRIBUTION'; emoji = '🔴';
        detail = `More selling than buying — ${(1/ratio).toFixed(1)}:1 sell/buy ratio`;
        intentScore = 30;
        explanation = 'Selling pressure outweighs buying. Not necessarily a reversal but risky for new entries.';
        actionHint  = 'Caution — tighten stop';
    } else {
        intent = 'NEUTRAL'; emoji = '⚪';
        detail = `Balanced — ${ratio.toFixed(1)}:1 buy/sell ratio`;
        intentScore = 50;
        explanation = 'No clear directional bias. Wait for volume spike with directional close.';
        actionHint  = 'Wait for clearer signal';
    }

    const line = (
        `${emoji} *Volume Intent: ${intent}*\n` +
        ` · ${detail}\n` +
        ` · ${volTrendEmoji} Volume ${volTrendLabel} (${volVsAvg.toFixed(1)}x 20-bar avg)\n` +
        (cvdNote ? ` · CVD: ${cvdNote}\n` : '') +
        ` · ${explanation}\n` +
        ` · Action: ${actionHint}`
    );

    return {
        intent, emoji, detail, intentScore, explanation, actionHint, cvdNote,
        volTrend: volTrendLabel, volTrendEmoji,
        volVsAvg: +volVsAvg.toFixed(2), volTrendRatio: +volTrend.toFixed(2),
        buyScore: +buyScore.toFixed(1), sellScore: +sellScore.toFixed(1),
        isAbsorption, cvdRising, cvdFalling,
        strongCloses, rejectionWicks, lowerWicks,
        line,
    };
}

function analyzeMomentum(closes, highs, lows, volumes) {
    const n = closes.length;
    let ms = 0; const signals = [];
    const roc3  = (closes[n-1]-closes[n-4]) / closes[n-4] * 100;
    const roc5  = (closes[n-1]-closes[n-6]) / closes[n-6] * 100;
    const roc10 = (closes[n-1]-closes[n-11]) / closes[n-11] * 100;
    if (roc3 > 1.5 && roc5 > 2) { ms += 3; signals.push(`ROC Accelerating +${roc3.toFixed(1)}%`); }
    else if (roc5 > 1.5)        { ms += 2; signals.push(`ROC Positive +${roc5.toFixed(1)}%`); }
    else if (roc5 > 0)          { ms += 1; signals.push('Slow ROC'); }
    else                        { ms -= 1; signals.push('ROC Negative'); }
    if (roc3 > roc10 * 1.5 && roc3 > 0) { ms += 2; signals.push('Momentum Accelerating'); }
    const v5  = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const v20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const vt  = v5 / v20;
    if (vt > 2.0)      { ms += 3; signals.push(`Volume Surge ${vt.toFixed(1)}x`); }
    else if (vt > 1.4) { ms += 2; signals.push(`Volume Expanding ${vt.toFixed(1)}x`); }
    else if (vt > 1.0) { ms += 1; signals.push('Volume Stable'); }
    else               { ms -= 2; signals.push('Volume Declining'); }
    const ema7arr = EMA.calculate({ values: closes, period: 7 });
    const slope   = (ema7arr[ema7arr.length-1] - ema7arr[ema7arr.length-4]) / ema7arr[ema7arr.length-4] * 100;
    if (slope > 1.5)       { ms += 2; signals.push(`EMA7 Rising Fast +${slope.toFixed(1)}%`); }
    else if (slope > 0.3)  { ms += 1; signals.push('EMA7 Rising'); }
    else if (slope < -0.5) { ms -= 1; signals.push('EMA7 Falling'); }
    let cons = 0;
    for (let i = n-1; i >= n-6; i--) { if (closes[i] > closes[i-1]) cons++; else break; }
    if (cons >= 4)    { ms += 2; signals.push(`${cons} Consecutive Closes`); }
    else if (cons>=2) { ms += 1; signals.push(`${cons} Green Closes`); }
    const label    = ms >= 12 ? 'EXPLOSIVE' : ms >= 8 ? 'STRONG' : ms >= 5 ? 'MODERATE' : ms >= 2 ? 'BUILDING' : 'WEAK';
    const contProb = Math.min(92, Math.max(25, 35 + ms * 4));
    return { momScore: ms, signals, label, contProb };
}

function detectStrongAccumulation(closes, volumes, highs, lows) {
    const n        = closes.length;
    const range15  = (Math.max(...highs.slice(-15)) - Math.min(...lows.slice(-15))) / closes[n-1] * 100;
    const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const priceChange5 = ((closes[n-1] - closes[n-6]) / closes[n-6]) * 100;
    let score = 0; const signals = [];
    if (range15 < 6)                              { score += 2; signals.push('Tight Range'); }
    if (avgVol5 > avgVol20 * 1.3)                 { score += 3; signals.push('Volume Building'); }
    if (priceChange5 > 0 && priceChange5 < 3)     { score += 2; signals.push('Controlled Rise'); }
    if (avgVol5 > avgVol20 * 2)                   { score += 2; signals.push('Whale Loading'); }
    return { score, signals, strong: score >= 5 };
}

function detectSmartMoneyEntry(closes, volumes, highs, lows) {
    const n        = closes.length;
    const avgVol3  = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const priceMove3  = ((closes[n-1] - closes[n-4]) / closes[n-4]) * 100;
    const wick        = Math.min(closes[n-1], closes[n-2]) - lows[n-1];
    const candleRange = highs[n-1] - lows[n-1];
    let score = 0; const signals = [];
    if (avgVol3 > avgVol20 * 1.8 && priceMove3 < 2)       { score += 3; signals.push('Silent Volume Surge'); }
    if (candleRange > 0 && wick > candleRange * 0.4)       { score += 2; signals.push('Long Lower Wick'); }
    if (avgVol3 > avgVol20 * 2.5)                          { score += 3; signals.push('Whale Entry'); }
    return { score, signals, active: score >= 4 };
}

function gannShortEngine(lows, closes, volumes) {
    const n = closes.length;
    let swingLowIdx = -1;
    for (let i = n - 4; i >= Math.max(0, n - 30); i--) {
        if (lows[i] < lows[i-1] && lows[i] < lows[i+1]) { swingLowIdx = i; break; }
    }
    let angleStatus = 'N/A';
    if (swingLowIdx !== -1) {
        const bars  = n - 1 - swingLowIdx;
        const sLow  = lows[swingLowIdx];
        const l1x1  = sLow * (1 + bars * 0.01);
        const l1x2  = sLow * (1 + bars * 0.005);
        if (closes[n-1] >= l1x1)      angleStatus = 'Above 1x1 — Strong';
        else if (closes[n-1] >= l1x2) angleStatus = 'Between 1x2-1x1';
        else                           angleStatus = 'Below 1x2 — Weak';
    }
    const cycles = [7, 9, 12, 21, 27, 45];
    let cycleStatus = '';
    let swingLowI2 = -1;
    for (let i = n - 4; i >= 5; i--) {
        if (lows[i]<lows[i-1] && lows[i]<lows[i-2] && lows[i]<lows[i+1] && lows[i]<lows[i+2]) {
            swingLowI2 = i; break;
        }
    }
    if (swingLowI2 !== -1) {
        const since = n - 1 - swingLowI2;
        const match = cycles.find(c => Math.abs(since - c) <= 1);
        cycleStatus = match ? `${match}-Candle Gann Window ACTIVE` : `${since} candles from swing low`;
    }
    const vRecent = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const vAvg    = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const vr      = vRecent / (vAvg || 1);
    const volAlign = vr >= 1.5 ? 'Confirmed' : vr >= 1.1 ? 'Weak' : 'Missing';
    return { angleStatus, cycleStatus, volAlign };
}

function analyzeLiquidityTracker(closes, highs, lows, volumes, ob, lf) {
    const n   = closes.length;
    const mfi = lf.mfiValue;
    const fr  = parseFloat(lf.flowRatio);
    const vR  = volumes.slice(-5).reduce((a,b)=>a+b,0)/5 / (volumes.slice(-10,-5).reduce((a,b)=>a+b,0)/5 || 1);
    let status = 'Healthy Flow';
    const notes = [];
    if (vR > 1.8 && fr > 1.4) {
        if (fr > 2.5) { status = 'Futures Hot Inflow'; notes.push('Volume surge + liquidity'); }
        else          { status = 'Spot Liquidity Rising'; notes.push('Capital entering quietly'); }
    } else if (fr > 1.3 && mfi > 55) { status = 'Speculative Inflow'; notes.push('Capital flowing in'); }
    const bodyPct  = Math.abs(closes[n-1]-closes[n-2]) / closes[n-2] * 100;
    const maxAsk   = ob?.asks?.reduce((m,a)=>a.qty>m.qty?a:m, ob.asks[0]);
    const avgAskQ  = ob?.asks ? ob.asks.reduce((s,a)=>s+a.qty,0)/ob.asks.length : 1;
    const sellHeavy = maxAsk && (maxAsk.qty/avgAskQ) > 8;
    let liqRisk = 'Low';
    if (bodyPct > 4 && mfi > 78 && sellHeavy) { liqRisk = 'High'; notes.push('Price vertical into sell wall'); }
    else if (bodyPct > 2.5 || mfi > 72)        { liqRisk = 'Medium'; }
    return { status, liqRisk, notes };
}

function analyzeTrendConfirmation(closes, highs, lows, volumes, ob, momentum, lf) {
    const n        = closes.length;
    const fr       = parseFloat(lf.flowRatio);
    const sellWall = ob?.sellWall ?? false;
    const higherLow = lows[n-1] > lows[n-4];
    const vR       = volumes.slice(-3).reduce((a,b)=>a+b,0)/3 / (volumes.slice(-8,-3).reduce((a,b)=>a+b,0)/5 || 1);
    const volStable  = vR >= 0.8;
    const hlBroken   = closes[n-1] < Math.min(...lows.slice(-5,-1));
    let trendStatus = 'Continuation Moderate';
    if (hlBroken || (fr < 0.7 && momentum.momScore < 3))          trendStatus = 'Trend Stop';
    else if (!volStable || sellWall || momentum.momScore < 4)      trendStatus = 'Weakening';
    else if (higherLow && volStable && fr > 1.0 && !sellWall)     trendStatus = 'Continuation Strong';
    return { trendStatus, higherLow };
}

function analyzeMoonPotential(closes, highs, lows, volumes, ticker, ob, momScore, atrPct) {
    const n = closes.length;
    let ms = 0; const signals = [];
    const histRange = (Math.max(...highs.slice(-60)) - Math.min(...lows.slice(-60))) / Math.min(...lows.slice(-60)) * 100;
    if (histRange > 40)       { ms += 3; signals.push(`High Range ${histRange.toFixed(0)}%`); }
    else if (histRange > 20)  { ms += 2; signals.push(`Decent Range ${histRange.toFixed(0)}%`); }
    else { ms -= 1; }
    if (atrPct > 3.0)         { ms += 3; signals.push(`High ATR ${atrPct.toFixed(1)}%`); }
    else if (atrPct > 1.5)    { ms += 1; }
    else                      { ms -= 2; }
    const rw  = (Math.max(...highs.slice(-15)) - Math.min(...lows.slice(-15))) / closes[n-1] * 100;
    const v15 = volumes.slice(-15).reduce((a,b)=>a+b,0) / 15;
    const v30 = volumes.slice(-30,-15).reduce((a,b)=>a+b,0) / 15;
    if (v30 > 0 && rw < 8 && v15/v30 > 1.2) { ms += 4; signals.push(`Accumulation Base ${rw.toFixed(1)}%`); }
    else if (rw < 12) { ms += 2; signals.push('Consolidation Pattern'); }
    if (ob?.bids?.length) {
        const bidUSDT = ob.bids.reduce((s,b)=>s+b.price*b.qty,0);
        const askUSDT = ob.asks.reduce((s,a)=>s+a.price*a.qty,0);
        if (bidUSDT > askUSDT * 1.5) { ms += 3; signals.push(`OB Depth $${(bidUSDT/1000).toFixed(0)}K`); }
        else if (bidUSDT > askUSDT)  { ms += 1; signals.push('OB Slightly Bullish'); }
        const maxA = Math.max(...ob.asks.map(a=>a.qty));
        const avgA = ob.asks.reduce((s,a)=>s+a.qty,0) / ob.asks.length;
        if (maxA / avgA < 2.5) { ms += 2; signals.push('No Major Resistance'); }
    }
    if (momScore >= 12)       { ms += 3; signals.push('Explosive Momentum'); }
    else if (momScore >= 8)   { ms += 2; signals.push('Strong Momentum'); }
    else if (momScore < 3)    { ms -= 2; }
    const qv = parseFloat(ticker.quoteVolume);
    if (qv < 200_000_000) { ms += 2; signals.push('Mid-Cap — High Move Potential'); }
    let label, moonPct;
    if (ms >= 14)        { label = 'HIGH';        moonPct = '30–40%'; }
    else if (ms >= 9)    { label = 'MEDIUM';      moonPct = '20–30%'; }
    else if (ms >= 5)    { label = 'LOW-MEDIUM';  moonPct = '10–20%'; }
    else                 { label = 'LOW';         moonPct = '3–10%'; }
    return { moonScore: ms, signals, label, pct: moonPct };
}

function detectMultiLeg(closes, highs, lows, volumes, targets, lf, ob) {
    const n        = closes.length;
    const fr       = parseFloat(lf.flowRatio);
    const recentHigh = Math.max(...highs.slice(-10));
    const recentLow  = Math.min(...lows.slice(-10));
    const midpoint   = (recentHigh + recentLow) / 2;
    const isMultiLeg = targets.atrPct > 2.0 && fr > 1.3 && closes[n-1] > midpoint && !ob?.sellWall;
    return { isMultiLeg, label: isMultiLeg ? 'Multi-Leg Candidate | High Expansion Potential' : '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// v5.5 EXPLOSION READINESS ENGINES
// ═══════════════════════════════════════════════════════════════════════════
function detectVolumeSpring(volumes) {
    const n = volumes.length;
    if (n < 14) return { dryUp: false, dryUpRatio: 1, explosion: false, explosionRatio: 1, springReady: false };
    const recent3      = volumes.slice(-4, -1).reduce((a,b)=>a+b,0) / 3;
    const prior10      = volumes.slice(-13, -3).reduce((a,b)=>a+b,0) / 10;
    const current      = volumes[n - 1];
    const dryUpRatio   = prior10 > 0 ? +(recent3 / prior10).toFixed(2) : 1;
    const explosionRatio = recent3 > 0 ? +(current / recent3).toFixed(2) : 1;
    const dryUp        = dryUpRatio < 0.6;
    const explosion    = explosionRatio > 3.0;
    const springReady  = dryUp && explosion;
    return { dryUp, dryUpRatio, explosion, explosionRatio, springReady };
}

function detectLiquidityVacuum(ob, currentPrice) {
    const empty = { vacuum: false, resistanceThin: false, askDepthAbove2pct: 0, bidSupportDepth: 0, vacuumRatio: 1 };
    if (!ob?.asks?.length || !ob?.bids?.length || !currentPrice) return empty;
    const upperBound = currentPrice * 1.02;
    const asksNear   = ob.asks.filter(a => a.price <= upperBound);
    const askDepthAbove2pct = asksNear.reduce((s, a) => s + a.price * a.qty, 0);
    const top10Bids  = ob.bids.slice(0, 10);
    const bidSupportDepth = top10Bids.reduce((s, b) => s + b.price * b.qty, 0);
    const vacuum     = bidSupportDepth > 0 && askDepthAbove2pct < bidSupportDepth * 0.3;
    const resistanceThin = askDepthAbove2pct < currentPrice * 10000;
    const vacuumRatio = bidSupportDepth > 0 ? +(askDepthAbove2pct / bidSupportDepth).toFixed(2) : 1;
    return { vacuum, resistanceThin, askDepthAbove2pct: +askDepthAbove2pct.toFixed(0), bidSupportDepth: +bidSupportDepth.toFixed(0), vacuumRatio };
}

function calcCVD(opens, closes, volumes) {
    const n = closes.length;
    if (n < 12) return { cvd: 0, divergence: false, strongDivergence: false, cvdTrend: 'FLAT' };
    const window = Math.min(20, n);
    let running = 0;
    const cvdArr = [];
    for (let i = n - window; i < n; i++) {
        running += closes[i] > opens[i] ? volumes[i] : -volumes[i];
        cvdArr.push(running);
    }
    const cvdNow    = cvdArr[cvdArr.length - 1];
    const cvd5ago   = cvdArr[Math.max(0, cvdArr.length - 6)];
    const cvd10ago  = cvdArr[Math.max(0, cvdArr.length - 11)];
    const priceDown        = closes[n-1] < closes[n-6];
    const cvdUp            = cvdNow > cvd5ago;
    const divergence       = priceDown && cvdUp;
    const priceLower10     = closes[n-1] < closes[n-11];
    const cvdHigher10      = cvdNow > cvd10ago;
    const strongDivergence = priceLower10 && cvdHigher10;
    const cvdTrend = cvdNow > cvd5ago * 1.05 ? 'RISING' : cvdNow < cvd5ago * 0.95 ? 'FALLING' : 'FLAT';
    return { cvd: +cvdNow.toFixed(2), divergence, strongDivergence, cvdTrend };
}

function calcCompressionScore(highs, lows, closes) {
    const n = closes.length;
    if (n < 10) return { compressed: false, bars: 0, avgRange: '0%', currentRange: '0%', explosionPotential: 'LOW' };
    const window = Math.min(30, n);
    const ranges = [];
    for (let i = n - window; i < n; i++) {
        ranges.push(closes[i] > 0 ? (highs[i] - lows[i]) / closes[i] : 0);
    }
    const avgRange     = ranges.reduce((a,b)=>a+b,0) / ranges.length;
    const currentRange = ranges[ranges.length - 1];
    const threshold    = avgRange * 0.5;
    let compressionBars = 0;
    for (let i = ranges.length - 1; i >= 0; i--) {
        if (ranges[i] < threshold) compressionBars++;
        else break;
    }
    const compressed = currentRange < threshold;
    const explosionPotential = compressionBars >= 5 ? 'HIGH' : compressionBars >= 3 ? 'MEDIUM' : 'LOW';
    return { compressed, bars: compressionBars, avgRange: (avgRange * 100).toFixed(2) + '%', currentRange: (currentRange * 100).toFixed(2) + '%', explosionPotential };
}

function detectMFIDivergence(closes, highs, lows, volumes) {
    const n = closes.length;
    if (n < 12) return { divergence: false, shortDivergence: false, strength: 'NONE' };
    const mfiWindow = Math.min(15, n - 1);
    const mfiArr = [];
    for (let i = n - mfiWindow; i < n; i++) {
        let pos = 0, neg = 0;
        const period = Math.min(3, i);
        for (let j = i - period; j < i; j++) {
            const tp  = (highs[j] + lows[j] + closes[j]) / 3;
            const tp0 = (highs[j-1] + lows[j-1] + closes[j-1]) / 3;
            const raw = tp * volumes[j];
            if (tp > tp0) pos += raw; else neg += raw;
        }
        const ratio = neg === 0 ? 100 : pos / neg;
        mfiArr.push(100 - (100 / (1 + ratio)));
    }
    const mn      = mfiArr.length;
    const mfiNow  = mfiArr[mn - 1];
    const mfi5ago = mfiArr[Math.max(0, mn - 6)];
    const mfi10ago = mfiArr[Math.max(0, mn - 11)];
    const mfi3ago  = mfiArr[Math.max(0, mn - 4)];
    const priceLowerLow  = closes[n-1] < closes[n-6]  && closes[n-6]  < closes[n-11];
    const mfiHigherLow   = mfiNow      > mfi5ago       && mfi5ago      > mfi10ago;
    const divergence     = priceLowerLow && mfiHigherLow;
    const shortPriceDown = closes[n-1] < closes[n-4];
    const shortMFIUp     = mfiNow > mfi3ago;
    const shortDivergence = shortPriceDown && shortMFIUp;
    const strength = divergence ? 'STRONG' : shortDivergence ? 'MODERATE' : 'NONE';
    return { divergence, shortDivergence, strength };
}

function calcExplosionReadiness(data) {
    const { volRatio = 1, volumeSpring = {}, sellWall = false, buyWall = false,
            liquidityVacuum = {}, wyckoffSpring = false, atrExpansion = 1,
            cvdDivergence = {}, mfiDivergence = {}, compression = {} } = data;
    let score = 0;
    const signals = [];
    if (volRatio >= 3.0)             { score += 20; signals.push(`Vol ${volRatio.toFixed(1)}x — Whale volume`); }
    else if (volRatio >= 2.5)        { score += 14; signals.push(`Vol ${volRatio.toFixed(1)}x — High`); }
    else if (volRatio >= 2.0)        { score += 8;  signals.push(`Vol ${volRatio.toFixed(1)}x — Rising`); }
    if (volumeSpring.springReady)    { score += 15; signals.push(`Vol Spring READY (${volumeSpring.dryUpRatio}x dry-up)`); }
    else if (volumeSpring.dryUp)     { score += 7;  signals.push(`Vol Dry-Up (${volumeSpring.dryUpRatio}x)`); }
    if (!sellWall)                   { score += 12; signals.push('No sell wall — path clear'); }
    if (buyWall)                     { score += 8;  signals.push('Buy wall — strong support'); }
    if (liquidityVacuum.vacuum)      { score += 15; signals.push(`Liquidity vacuum (ratio ${liquidityVacuum.vacuumRatio})`); }
    else if (liquidityVacuum.resistanceThin) { score += 7; signals.push('Resistance thin above'); }
    if (wyckoffSpring)               { score += 18; signals.push('Wyckoff Spring confirmed'); }
    if (atrExpansion >= 2.5)         { score += 12; signals.push(`ATR expanding ${atrExpansion}x`); }
    else if (atrExpansion >= 2.0)    { score += 6;  signals.push(`ATR expanding ${atrExpansion}x`); }
    if (cvdDivergence.strongDivergence) { score += 12; signals.push('CVD strong divergence — buyers hidden'); }
    else if (cvdDivergence.divergence)  { score += 6;  signals.push('CVD divergence — buy pressure'); }
    if (mfiDivergence.strength === 'STRONG')   { score += 10; signals.push('MFI strong divergence'); }
    else if (mfiDivergence.strength === 'MODERATE') { score += 5; signals.push('MFI moderate divergence'); }
    if (compression.bars >= 5)       { score += 10; signals.push(`Compressed ${compression.bars} bars`); }
    else if (compression.bars >= 3)  { score += 5;  signals.push(`Compressed ${compression.bars} bars`); }
    score = Math.min(score, 100);
    const potential = score >= 70 ? 'EXPLOSIVE (40%+)' : score >= 50 ? 'STRONG (20-40%)' : score >= 30 ? 'MODERATE (10-20%)' : 'WEAK (<10%)';
    return { score, potential, signals, maxScore: 100 };
}

function detectSmartMoneyAbsorption(closes, highs, lows, volumes, ob) {
    const n = closes.length;
    if (n < 10) return { absorbing: false, absorptionScore: 0, absorptionNote: 'Insufficient data' };
    const rangeHigh  = Math.max(...highs.slice(-10));
    const rangeLow   = Math.min(...lows.slice(-10));
    const price      = closes[n - 1];
    const rangePct   = price > 0 ? ((rangeHigh - rangeLow) / price) * 100 : 999;
    const tightRange = rangePct < 5.0;
    const avgVol10   = volumes.slice(-10).reduce((a,b)=>a+b,0) / 10;
    const avgVol20   = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const volAbsorbing = avgVol10 > avgVol20 * 0.85;
    const rangePosition = (rangeHigh - rangeLow) > 0 ? (price - rangeLow) / (rangeHigh - rangeLow) : 0.5;
    const holdingHigh = rangePosition > 0.6;
    const obData    = ob ? analyzeOrderBook(ob) : null;
    const bidDom    = obData ? parseFloat(obData.imbalance) > 0.55 : false;
    const buyWall   = obData?.buyWall ?? false;
    const noSellWall = !(obData?.sellWall ?? true);
    let lowerWickCount = 0;
    for (let i = n - 5; i < n; i++) {
        const lWick = Math.min(closes[i], closes[i-1]) - lows[i];
        const range = highs[i] - lows[i];
        if (range > 0 && lWick / range > 0.3) lowerWickCount++;
    }
    const defendedBySellers = lowerWickCount >= 3;
    let absorptionScore = 0;
    const notes = [];
    if (tightRange)         { absorptionScore += 25; notes.push(`Tight range ${rangePct.toFixed(1)}%`); }
    if (volAbsorbing)       { absorptionScore += 20; notes.push('Volume stable during consolidation'); }
    if (holdingHigh)        { absorptionScore += 20; notes.push(`Price in top ${Math.round(rangePosition*100)}% of range`); }
    if (bidDom)             { absorptionScore += 15; notes.push('Bid dominant OB'); }
    if (buyWall)            { absorptionScore += 10; notes.push('Buy wall present'); }
    if (noSellWall)         { absorptionScore += 5;  notes.push('No sell wall overhead'); }
    if (defendedBySellers)  { absorptionScore += 5;  notes.push('Lower wicks — buyers defending'); }
    const absorbing = absorptionScore >= 55;
    const absorptionNote = absorbing
        ? `Absorption confirmed (${absorptionScore}/100) — ${notes.slice(0,2).join(', ')}`
        : `Partial absorption (${absorptionScore}/100) — ${notes[0] ?? 'weak signals'}`;
    return { absorbing, absorptionScore, absorptionNote, tightRange, holdingHigh, bidDom, rangePct };
}

function detectMultiTimeframeMomentum(c15, c1h) {
    const result = { aligned: false, alignScore: 0, alignNote: 'No HTF data' };
    if (!c15 || !c1h) return result;
    const rsi15   = RSI.calculate({ values: c15.closes, period: 14 }).slice(-1)[0] ?? 50;
    const rsi1h   = RSI.calculate({ values: c1h.closes, period: 14 }).slice(-1)[0] ?? 50;
    const e7_15   = EMA.calculate({ values: c15.closes, period: 7  }).slice(-1)[0];
    const e25_15  = EMA.calculate({ values: c15.closes, period: 25 }).slice(-1)[0];
    const e7_1h   = EMA.calculate({ values: c1h.closes, period: 7  }).slice(-1)[0];
    const e25_1h  = EMA.calculate({ values: c1h.closes, period: 25 }).slice(-1)[0];
    const macd15  = MACD.calculate({ values: c15.closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const m1_15   = macd15[macd15.length - 1];
    const m0_15   = macd15[macd15.length - 2];
    let alignScore = 0;
    const notes = [];
    if (e7_1h > e25_1h)             { alignScore += 25; notes.push('1h EMA bullish'); }
    if (rsi15 > 45 && rsi15 < 70)   { alignScore += 20; notes.push(`15m RSI ${rsi15.toFixed(0)}`); }
    if (rsi1h > 40 && rsi1h < 68)   { alignScore += 20; notes.push(`1h RSI ${rsi1h.toFixed(0)}`); }
    if ((m1_15?.histogram ?? 0) > (m0_15?.histogram ?? 0) && (m1_15?.histogram ?? 0) > 0)
        { alignScore += 20; notes.push('15m MACD bullish'); }
    if (e7_15 > e25_15)             { alignScore += 15; notes.push('15m EMA aligned'); }
    const aligned    = alignScore >= 60;
    const alignNote  = `MTF ${alignScore}/100 — ${notes.slice(0,2).join(', ')}`;
    return { aligned, alignScore, alignNote, rsi15: +rsi15.toFixed(1), rsi1h: +rsi1h.toFixed(1) };
}

function detectBreakoutAcceptance(closes, highs, lows, volumes, ob) {
    const n = closes.length;
    if (n < 5) return { acceptance: 'UNKNOWN', acceptanceScore: 0 };
    const rangeHigh20 = Math.max(...highs.slice(-20, -3));
    const price       = closes[n - 1];
    const brokeOut    = price > rangeHigh20;
    if (!brokeOut) return { acceptance: 'NOT_YET', acceptanceScore: 0, brokeOut: false };
    const stayedAbove = [closes[n-1], closes[n-2], closes[n-3]].every(c => c > rangeHigh20);
    const avgVol20    = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const volPost     = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const volSustained = volPost > avgVol20 * 0.9;
    const bidDom      = ob ? parseFloat(analyzeOrderBook(ob).imbalance) > 0.52 : true;
    const cRange      = highs[n-1] - lows[n-1];
    const midpoint    = lows[n-1] + cRange / 2;
    const strongClose = cRange > 0 && closes[n-1] > midpoint;
    let acceptanceScore = 0;
    if (stayedAbove)   acceptanceScore += 30;
    if (volSustained)  acceptanceScore += 25;
    if (bidDom)        acceptanceScore += 25;
    if (strongClose)   acceptanceScore += 20;
    let acceptance;
    if (acceptanceScore >= 70)       acceptance = 'ACCEPTED';
    else if (acceptanceScore >= 40)  acceptance = 'WEAK';
    else                             acceptance = 'FAILED';
    return { acceptance, acceptanceScore, brokeOut: true, stayedAbove, volSustained, bidDom, strongClose, breakoutLevel: +rangeHigh20.toFixed(8) };
}

function detectATRShift(closes, highs, lows, volumes) {
    const n = closes.length;
    if (n < 20) return { atrBehavior: 'UNKNOWN', atrBehaviorScore: 0 };
    const _atr5     = (h, l, c) => { const a = ATR.calculate({ high: h, low: l, close: c, period: 5 }); return a[a.length-1] ?? 0; };
    const atrNow    = _atr5(highs.slice(-5),       lows.slice(-5),       closes.slice(-5));
    const atrPrev   = _atr5(highs.slice(-15,-5),   lows.slice(-15,-5),   closes.slice(-15,-5));
    const atrBase   = _atr5(highs.slice(-20,-10),  lows.slice(-20,-10),  closes.slice(-20,-10));
    const price     = closes[n-1];
    const atrExpansion = atrPrev > 0 ? atrNow / atrPrev : 1;
    const atrVsBase    = atrBase > 0 ? atrNow / atrBase : 1;
    const uWick     = highs[n-1] - Math.max(closes[n-1], closes[n-2] ?? closes[n-1]);
    const cRange    = highs[n-1] - lows[n-1];
    const wickRatio = cRange > 0 ? uWick / cRange : 0;
    let atrBehavior, atrBehaviorScore, atrNote;
    if (atrExpansion > 3.0 && wickRatio > 0.4)       { atrBehavior = 'FAKE_SPIKE';          atrBehaviorScore = 10; atrNote = `ATR spiked ${atrExpansion.toFixed(1)}x + rejection wick — fake expansion`; }
    else if (atrExpansion > 2.5 && wickRatio < 0.25) { atrBehavior = 'EXPLOSIVE';           atrBehaviorScore = 90; atrNote = `ATR exploding ${atrExpansion.toFixed(1)}x cleanly — strong move`; }
    else if (atrExpansion > 1.5 && wickRatio < 0.3)  { atrBehavior = 'HEALTHY_EXPANSION';   atrBehaviorScore = 75; atrNote = `ATR expanding ${atrExpansion.toFixed(1)}x with clean candles`; }
    else if (atrExpansion > 1.5 && wickRatio > 0.4)  { atrBehavior = 'DANGEROUS_SPIKE';     atrBehaviorScore = 20; atrNote = `ATR spike ${atrExpansion.toFixed(1)}x + wick — danger zone`; }
    else if (atrVsBase < 0.6)                         { atrBehavior = 'COILING';             atrBehaviorScore = 70; atrNote = `ATR low (${((atrNow/price)*100).toFixed(2)}%) — coiling for explosion`; }
    else                                               { atrBehavior = 'STABLE';              atrBehaviorScore = 55; atrNote = `ATR stable — normal conditions`; }
    return { atrBehavior, atrBehaviorScore, atrNote, atrExpansion: +atrExpansion.toFixed(2), atrVsBase: +atrVsBase.toFixed(2), wickRatio: +wickRatio.toFixed(2) };
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTITUTIONAL INDICATORS (v5.5)
// ═══════════════════════════════════════════════════════════════════════════
function getNarrativeBonus(symbol) {
    const s = symbol.replace('USDT', '').toUpperCase();
    const AI_TOKENS   = new Set(['FET','AGIX','OCEAN','RENDER','TAO','NMR','GRT','GLM','AIOZ','PAAL','MYRIA','OLAS','VELA','ARKM','WLD','VIRT','VIRTUAL']);
    const MEME_TOKENS = new Set(['DOGE','SHIB','PEPE','FLOKI','BONK','WIF','MEME','BABYDOGE','LUNC','SAMO','MOG','TURBO','BRETT','NEIRO','PNUT','GOAT']);
    const RWA_TOKENS  = new Set(['ONDO','POLYX','RIO','PROPS','CFG','TELLER','REALT']);
    const DEFI_TOKENS = new Set(['UNI','AAVE','COMP','MKR','SNX','CAKE','1INCH','SUSHI','CRV','CVX','BAL','PENDLE','LDO','RPL','GMX','GNS','DYDX']);
    const L1_TOKENS   = new Set(['SOL','AVAX','ADA','DOT','ATOM','NEAR','APT','SUI','SEI','TIA','INJ','FTM','ONE','ALGO','EGLD','XTZ','EOS','VET','ZIL']);
    const L2_TOKENS   = new Set(['MATIC','OP','ARB','IMX','STRK','MANTA','BLAST','SCROLL','ZKSYNC','METIS','BOBA','CELO']);
    const GAME_TOKENS = new Set(['AXS','SAND','MANA','ENJ','GALA','ILV','MAGIC','GMX','BEAM','PIXEL','RONIN','YGG','PYR']);
    let category = 'OTHER'; let narrativeBonus = 0; let maxTargetMultiplier = 1.0;
    if (AI_TOKENS.has(s) || /AI$|GPT$|AGI$|^AI/.test(s))                        { category = 'AI';     narrativeBonus = 15; maxTargetMultiplier = 2.0; }
    else if (MEME_TOKENS.has(s) || /DOGE|PEPE|MOON|INU$|ELON|BABY|CAT$|DOG$|FROG|PNUT|MEME/.test(s)) { category = 'MEME'; narrativeBonus = 15; maxTargetMultiplier = 2.0; }
    else if (RWA_TOKENS.has(s) || /RWA$/.test(s))                               { category = 'RWA';    narrativeBonus = 5;  maxTargetMultiplier = 1.3; }
    else if (DEFI_TOKENS.has(s) || /SWAP$|FI$|LEND$|EARN$/.test(s))            { category = 'DEFI';   narrativeBonus = 8;  maxTargetMultiplier = 1.5; }
    else if (L1_TOKENS.has(s))                                                   { category = 'L1';     narrativeBonus = 8;  maxTargetMultiplier = 1.5; }
    else if (L2_TOKENS.has(s) || /L2$|ZK$/.test(s))                             { category = 'L2';     narrativeBonus = 8;  maxTargetMultiplier = 1.5; }
    else if (GAME_TOKENS.has(s) || /GAME$|PLAY$|NFT$/.test(s))                  { category = 'GAMEFI'; narrativeBonus = 0;  maxTargetMultiplier = 1.0; }
    const categoryEmoji = { AI: '🤖', MEME: '🐸', RWA: '🏛', DEFI: '💰', L1: '⛓', L2: '🔗', GAMEFI: '🎮', OTHER: '💎' }[category] ?? '💎';
    return { category, categoryEmoji, narrativeBonus, maxTargetMultiplier };
}

function calcTokenAge(c15) {
    if (!c15?.closes?.length) return { ageDays: 999, ageCategory: 'ESTABLISHED', targetMultiplier: 1.0 };
    const candleCount = c15.closes.length;
    const estDays     = Math.round(candleCount * 15 / 1440);
    const ageDays     = Math.max(1, estDays);
    let ageCategory, targetMultiplier;
    if (ageDays <= 7)          { ageCategory = 'SEED (0-7d)';    targetMultiplier = 2.5; }
    else if (ageDays <= 30)    { ageCategory = 'NEW (8-30d)';    targetMultiplier = 2.0; }
    else if (ageDays <= 90)    { ageCategory = 'YOUNG (31-90d)'; targetMultiplier = 1.5; }
    else if (ageDays <= 180)   { ageCategory = 'MID (91-180d)';  targetMultiplier = 1.2; }
    else                       { ageCategory = 'ESTABLISHED';    targetMultiplier = 1.0; }
    return { ageDays, ageCategory, targetMultiplier };
}

function getSectorMomentum(symbol, ticker, allTickers) {
    const narrative = getNarrativeBonus(symbol);
    const change24h = parseFloat(ticker?.priceChangePercent ?? 0);
    const sectorCoins = {
        AI    : ['FETUSDT','AGIXUSDT','RENDERUSDT','WLDUSDT','ARKMUSDT','VIRTUAUSDT'],
        MEME  : ['DOGEUSDT','SHIBUSDT','PEPEUSDT','BONKUSDT','WIFUSDT','FLOKIUSDT'],
        DEFI  : ['UNIUSDT','AAVEUSDT','CRVUSDT','LDOUSDT','PENDLEUSDT','SNXUSDT'],
        L1    : ['SOLUSDT','AVAXUSDT','NEARUSDT','APTUSDT','SUIUSDT','INJUSDT'],
        L2    : ['MATICUSDT','OPUSDT','ARBUSDT','IMXUSDT','STRKUSDT'],
        RWA   : ['ONDOUSDT','POLYXUSDT'],
        GAMEFI: ['AXSUSDT','SANDUSDT','GALAUSDT'],
    };
    const peers = sectorCoins[narrative.category] ?? [];
    let sectorAvg = 0; let count = 0;
    for (const peer of peers) {
        if (allTickers?.[peer]) { sectorAvg += parseFloat(allTickers[peer].priceChangePercent ?? 0); count++; }
    }
    sectorAvg = count > 0 ? sectorAvg / count : 0;
    const coinVsSector = +(change24h - sectorAvg).toFixed(2);
    const sectorStrong = sectorAvg > 5;
    const coinOutperforming = coinVsSector > 5;
    let sectorBonus = 0; let sectorLabel = '';
    if (coinOutperforming && sectorStrong) { sectorBonus = 15; sectorLabel = 'Leading sector + sector strong'; }
    else if (coinOutperforming)            { sectorBonus = 10; sectorLabel = `Outperforming sector by +${coinVsSector}%`; }
    else if (sectorStrong)                 { sectorBonus = 8;  sectorLabel = `Sector up ${sectorAvg.toFixed(1)}%`; }
    return { sector: narrative.category, sectorAvg: +sectorAvg.toFixed(2), coinVsSector, sectorBonus, sectorLabel, sectorStrong, coinOutperforming };
}

function calcVolumeToMCap(ticker) {
    const vol24h       = parseFloat(ticker?.quoteVolume ?? 0);
    const price        = parseFloat(ticker?.lastPrice ?? ticker?.price ?? 1);
    let ratioCategory  = 'UNKNOWN';
    let liquidityBonus = 0;
    let liquidityMultiplier = 1.0;
    if (vol24h <= 0) return { volumeToMCap: 0, ratioCategory: 'UNKNOWN', liquidityBonus: 0, liquidityMultiplier: 1.0, vol24hUSDT: 0 };
    if (vol24h > 50_000_000)      { ratioCategory = 'EXPLOSIVE LIQUIDITY'; liquidityBonus = 20; liquidityMultiplier = 1.5; }
    else if (vol24h > 20_000_000) { ratioCategory = 'STRONG INTEREST';      liquidityBonus = 12; liquidityMultiplier = 1.3; }
    else if (vol24h > 5_000_000)  { ratioCategory = 'NORMAL';               liquidityBonus = 5;  liquidityMultiplier = 1.1; }
    else                          { ratioCategory = 'WEAK';                liquidityBonus = 0;  liquidityMultiplier = 1.0; }
    return { volumeToMCap: 0, ratioCategory, liquidityBonus, liquidityMultiplier, vol24hUSDT: Math.round(vol24h) };
}

function calcGreenStreakDays(closes, opens) {
    const n = closes.length;
    if (n < 2) return { greenStreak: 0, streakBonus: 0, streakLabel: 'Insufficient data', isExtended: false };
    let streak = 0;
    for (let i = n - 1; i >= Math.max(0, n - 14); i--) {
        if (closes[i] > opens[i]) streak++;
        else break;
    }
    const dayEquiv = Math.max(1, Math.round(streak / 4));
    let streakBonus = 0; let streakLabel = '';
    const isExtended = dayEquiv >= 5;
    if (dayEquiv >= 8)        { streakBonus = 20; streakLabel = 'PARABOLIC READY'; }
    else if (dayEquiv >= 5)   { streakBonus = 15; streakLabel = 'STRONG UPTREND'; }
    else if (dayEquiv >= 3)   { streakBonus = 8;  streakLabel = 'MOMENTUM BUILDING'; }
    else                      { streakBonus = 0;  streakLabel = 'EARLY TREND'; }
    return { greenStreak: dayEquiv, greenCandleCount: streak, streakBonus, streakLabel, isExtended };
}

async function checkWeeklyBreakout(symbol, currentPrice) {
    if (!currentPrice) return { weeklyBreakout: false, monthlyBreakout: false, breakoutBonus: 0, breakoutLabel: '' };
    try {
        const res = await safeGet(`/api/v3/klines?symbol=${symbol}&interval=1w&limit=27`);
        if (!res?.data?.length) return { weeklyBreakout: false, monthlyBreakout: false, breakoutBonus: 0, breakoutLabel: '' };
        const wHighs = res.data.map(c => parseFloat(c[2]));
        const high4w  = Math.max(...wHighs.slice(-5, -1));
        const high12w = Math.max(...wHighs.slice(-13, -1));
        const high26w = Math.max(...wHighs.slice(-27, -1));
        const weeklyBreakout   = currentPrice > high4w;
        const monthlyBreakout  = currentPrice > high12w;
        const allTimeZone      = currentPrice > high26w;
        let breakoutBonus = 0; let breakoutLabel = ''; let breakoutLevel = null;
        if (allTimeZone)          { breakoutBonus = 35; breakoutLabel = 'ALL-TIME ZONE BREAKOUT'; breakoutLevel = high26w; }
        else if (monthlyBreakout) { breakoutBonus = 25; breakoutLabel = 'MAJOR BREAKOUT (12w high)'; breakoutLevel = high12w; }
        else if (weeklyBreakout)  { breakoutBonus = 15; breakoutLabel = 'WEEKLY BREAKOUT (4w high)'; breakoutLevel = high4w; }
        return { weeklyBreakout, monthlyBreakout, allTimeZone, breakoutBonus, breakoutLabel, breakoutLevel };
    } catch {
        return { weeklyBreakout: false, monthlyBreakout: false, breakoutBonus: 0, breakoutLabel: '' };
    }
}

function detectVolumeFading(closes, volumes) {
    const n = closes.length;
    if (n < 6) return { volumeFading: false, fadingCount: 0, exitUrgency: 'NONE', shouldTightenStop: false };
    let fadingCount = 0;
    for (let i = n - 1; i >= n - 8; i--) {
        const priceUp = closes[i] > closes[i-1];
        const volDown = volumes[i] < volumes[i-1] * 0.85;
        if (priceUp && volDown) fadingCount++;
        else break;
    }
    const vAvg   = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const vNow   = volumes[n-1];
    const climax = vNow > vAvg * 5;
    let exitUrgency = 'NONE'; let shouldTightenStop = false;
    if (fadingCount >= 5 || climax) { exitUrgency = 'HIGH';   shouldTightenStop = true; }
    else if (fadingCount >= 3)      { exitUrgency = 'MEDIUM'; shouldTightenStop = true; }
    else if (fadingCount >= 2)      { exitUrgency = 'LOW';    shouldTightenStop = false; }
    return { volumeFading: fadingCount >= 2, fadingCount, exitUrgency, shouldTightenStop, climax };
}

function calcWhaleActivity(ob, volumes) {
    if (!ob?.bids?.length || !ob?.asks?.length) return { whaleScore: 0, whaleActivity: 'NEUTRAL', whaleImbalance: 0, whaleBonus: 0 };
    const avgBidQty   = ob.bids.reduce((s,b)=>s+b.qty,0) / ob.bids.length;
    const avgAskQty   = ob.asks.reduce((s,a)=>s+a.qty,0) / ob.asks.length;
    const largeBids   = ob.bids.filter(b => b.qty > avgBidQty * 10).length;
    const largeAsks   = ob.asks.filter(a => a.qty > avgAskQty * 10).length;
    const whaleScore  = (largeBids - largeAsks) * 5;
    const whaleImbalance = largeBids + largeAsks > 0 ? +((largeBids / (largeBids + largeAsks)) - 0.5).toFixed(2) : 0;
    const vAvg5       = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const vAvg20      = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const volConfirm  = vAvg5 > vAvg20 * 1.5;
    let whaleActivity = 'NEUTRAL'; let whaleBonus = 0;
    if (whaleScore > 20 && volConfirm) { whaleActivity = 'WHALES ACCUMULATING'; whaleBonus = 20; }
    else if (whaleScore > 20)          { whaleActivity = 'WHALE BIDS STACKING'; whaleBonus = 10; }
    else if (whaleScore < -15)         { whaleActivity = 'WHALES DISTRIBUTING'; whaleBonus = -15; }
    else if (whaleImbalance > 0.3)     { whaleActivity = 'BID PRESSURE';        whaleBonus = 5; }
    return { whaleScore, whaleActivity, whaleImbalance, whaleBonus, largeBids, largeAsks };
}

function calcTargetMultiplier(narrative, tokenAge, volToMCap, weeklyBreakout) {
    const mult =
        (narrative.maxTargetMultiplier    * 0.25) +
        (tokenAge.targetMultiplier        * 0.25) +
        (volToMCap.liquidityMultiplier    * 0.25) +
        ((weeklyBreakout.breakoutBonus / 100 + 1) * 0.25);
    return +mult.toFixed(2);
}

function getSessionWeight() {
    const h = new Date().getUTCHours();
    if (h >= 14 && h <= 21) return { session: 'US OPEN',    weight: +2, emoji: '🇺🇸', note: 'High liquidity' };
    if (h >= 13 && h < 14)  return { session: 'US PRE-OPEN',weight: +1, emoji: '⏰',  note: 'Pre-market activity' };
    if (h >= 7  && h < 15)  return { session: 'EUROPE',     weight: +1, emoji: '🇪🇺', note: 'EU market hours' };
    if (h >= 0  && h < 7)   return { session: 'ASIA',       weight:  0, emoji: '🌏', note: 'Asian hours — lower volume' };
    return                          { session: 'DEAD HOURS', weight: -1, emoji: '😴', note: 'Low liquidity period' };
}

function detectLateEntryRisk(closes, highs, lows, volumes, rsi, atrPct, mfi) {
    const n = closes.length;
    const _atr = (h, l, c, p) => { const a = ATR.calculate({ high: h, low: l, close: c, period: p }); return a[a.length-1] ?? 0; };
    const atrNow  = _atr(highs.slice(-5),    lows.slice(-5),    closes.slice(-5),   5);
    const atrPrev = _atr(highs.slice(-15,-5),lows.slice(-15,-5),closes.slice(-15,-5),5);
    const atrSpeed = atrPrev > 0 ? atrNow / atrPrev : 1;
    const vRecent  = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const vPrev    = volumes.slice(-8,-3).reduce((a,b)=>a+b,0) / 5;
    const volFading = vPrev > 0 && vRecent < vPrev * 0.75;
    let lateScore = 0;
    const lateReasons = [];
    let greenCount = 0;
    for (let i = n - 1; i >= n - 7; i--) { if (closes[i] > closes[i-1]) greenCount++; else break; }
    if (rsi > 75 && greenCount >= 5)           { lateScore += 6; lateReasons.push(`RSI ${rsi.toFixed(0)} + 5 green candles`); }
    if (parseFloat(mfi) > 85 && atrSpeed > 2.0){ lateScore += 5; lateReasons.push(`MFI ${mfi} overbought + ATR explosion`); }
    if (rsi > 78 && volFading)                  { lateScore += 4; lateReasons.push('RSI high + volume fading'); }
    if (rsi > 68 && rsi <= 75)                  { lateScore += 3; lateReasons.push(`RSI ${rsi.toFixed(0)} elevated`); }
    if (greenCount >= 4)                        { lateScore += 2; lateReasons.push(`${greenCount} consecutive green candles`); }
    if (atrSpeed > 2.5 && atrPct > 2.0)        { lateScore += 2; lateReasons.push('ATR expanding aggressively'); }
    const realBreakout = atrSpeed > 1.5 && vRecent > vPrev * 1.2 && rsi < 78;
    if (realBreakout) { lateScore = Math.max(0, lateScore - 4); lateReasons.push('ATR+Vol expanding together — real breakout'); }
    lateScore = Math.min(lateScore, 15);
    let lateRisk = 'LOW';
    if (lateScore >= 8)      lateRisk = 'HIGH';
    else if (lateScore >= 4) lateRisk = 'MEDIUM';
    return { lateRisk, lateScore, lateReasons, greenCount, atrSpeed: +atrSpeed.toFixed(2), realBreakout };
}

function calcTriggerDistance(price, highs) {
    const breakoutLevel = Math.max(...highs.slice(-20, -1));
    const distPct       = ((breakoutLevel - price) / price) * 100;
    let triggerClass = 'DELAYED'; let confidenceAdj = 0;
    if (distPct <= 0)        { triggerClass = 'ALREADY_BROKEN'; confidenceAdj = +5; }
    else if (distPct < 1.0)  { triggerClass = 'IMMEDIATE';      confidenceAdj = +10; }
    else if (distPct < 2.5)  { triggerClass = 'NEAR';           confidenceAdj = 0; }
    else                     { triggerClass = 'DELAYED';         confidenceAdj = -5; }
    return {
        triggerDistancePct : +distPct.toFixed(2),
        triggerLevel       : +breakoutLevel.toFixed(8),
        triggerClass,
        confidenceAdj,
        label: distPct <= 0 ? 'Already broken out' : `${distPct.toFixed(1)}% to breakout (${triggerClass})`,
    };
}

async function marketContextScore(btcMom) {
    const btcBullish    = btcMom?.bullish ?? null;
    const btcRSI        = btcMom?.btcRSI ?? 50;
    const h             = new Date().getUTCHours();
    const inPrimeSession = (h >= 13 && h <= 22);
    let contextScore    = 10;
    const contextReasons = [];
    if (btcBullish === true && btcRSI >= 45 && btcRSI <= 68)  { contextScore += 6; contextReasons.push('BTC stable and healthy'); }
    if (btcBullish === true && btcRSI > 72)                    { contextScore -= 5; contextReasons.push('BTC overbought — may drain alt liquidity'); }
    if (btcBullish === false && btcRSI < 45)                   { contextScore -= 7; contextReasons.push('BTC weak — risk-off environment'); }
    if (inPrimeSession) { contextScore += 4; contextReasons.push(`Prime session (${h}:00 UTC)`); }
    else                { contextScore -= 2; }
    contextScore = Math.max(0, Math.min(20, contextScore));
    let context = 'NEUTRAL';
    if (contextScore >= 14)                          context = 'ALT_FRIENDLY';
    else if (btcBullish === true && btcRSI > 70)     context = 'BTC_DOMINANT';
    else if (btcBullish === false || contextScore < 6) context = 'RISK_OFF';
    const emoji = context === 'ALT_FRIENDLY' ? '🟢' : context === 'BTC_DOMINANT' ? '🔶' : '🔴';
    return { context, contextScore, contextReasons, emoji };
}

function classifyExpansionPersonality(atrPct, hurst, obData, lf, candleEnergy, parab) {
    const flowRatio = parseFloat(lf?.flowRatio ?? '1');
    const imb       = parseFloat(obData?.imbalance ?? '0.5');
    const energy    = candleEnergy?.energyScore ?? 5;
    if (atrPct > 2.5 && parab?.phase === 'PARABOLIC' && energy >= 7)
        return { personality: 'PARABOLIC', emoji: '🚀', note: 'High ATR + aggressive volume — ride momentum' };
    if (atrPct < 1.2 && flowRatio > 1.8 && energy < 6)
        return { personality: 'DELAYED', emoji: '⏳', note: 'Low ATR + strong flow + quiet candles — 0G pattern' };
    if (atrPct >= 1.2 && imb > 0.55 && energy >= 5)
        return { personality: 'FAST', emoji: '⚡', note: 'Medium ATR + OB support — expect quick move' };
    if (atrPct >= 2.0) return { personality: 'PARABOLIC', emoji: '🚀', note: 'High volatility setup' };
    if (atrPct < 1.0)  return { personality: 'DELAYED',   emoji: '⏳', note: 'Quiet setup — may take time to develop' };
    return               { personality: 'FAST',      emoji: '⚡', note: 'Standard momentum setup' };
}

function calcInstitutionalGrade(score, expansion, lateRisk, trigger, context, whale) {
    let iScore = 0;
    iScore += Math.round((score / 24) * 30);
    const expBonus = { MOON: 20, DELAYED: 15, STRONG: 12, CONTROLLED: 8, MICRO: 3 };
    iScore += expBonus[expansion?.expansionTypeKey ?? 'CONTROLLED'] ?? 8;
    iScore += trigger?.confidenceAdj ?? 0;
    if (context?.context === 'ALT_FRIENDLY') iScore += 10;
    else if (context?.context === 'RISK_OFF') iScore -= 10;
    else if (context?.context === 'BTC_DOMINANT') iScore -= 5;
    if (lateRisk?.lateRisk === 'HIGH')        iScore -= 15;
    else if (lateRisk?.lateRisk === 'MEDIUM') iScore -= 5;
    if (whale?.whalePersistence) iScore += 8;
    iScore = Math.max(0, Math.min(100, iScore));
    let grade, gradeEmoji;
    if (iScore >= 80)      { grade = 'A+'; gradeEmoji = '⭐⭐⭐'; }
    else if (iScore >= 65) { grade = 'A';  gradeEmoji = '⭐⭐'; }
    else if (iScore >= 45) { grade = 'B';  gradeEmoji = '⭐'; }
    else                   { grade = 'C';  gradeEmoji = '⚠️'; }
    return { grade, gradeEmoji, iScore };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPANSION PROBABILITY ENGINE
// ═══════════════════════════════════════════════════════════════════════════
function calcCandleEnergy(closes, highs, lows, volumes) {
    const n = closes.length;
    if (n < 6) return { energyScore: 5, detail: 'Insufficient data' };
    let score = 0;
    const notes = [];
    for (let i = n - 5; i < n; i++) {
        const body      = Math.abs(closes[i] - closes[i-1]);
        const range     = highs[i] - lows[i];
        const uWick     = highs[i] - Math.max(closes[i], closes[i-1]);
        const bodyRatio = range > 0 ? body / range : 0;
        const wickRatio = range > 0 ? uWick / range : 0;
        if (bodyRatio > 0.6 && closes[i] > closes[i-1]) score += 2;
        else if (bodyRatio > 0.4 && closes[i] > closes[i-1]) score += 1;
        if (wickRatio > 0.5) score -= 1;
    }
    const bodies = [];
    for (let i = n - 4; i < n; i++) bodies.push(Math.abs(closes[i] - closes[i-1]));
    const accelerating = bodies[1] > bodies[0] && bodies[2] > bodies[1] && bodies[3] > bodies[2];
    if (accelerating) { score += 3; notes.push('Body acceleration'); }
    const vRecent3 = volumes.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const vAvg10   = volumes.slice(-10).reduce((a,b)=>a+b,0) / 10;
    if (vRecent3 > vAvg10 * 1.3) { score += 2; notes.push('Vol rising with price'); }
    const energyScore = Math.max(0, Math.min(10, score));
    return { energyScore, accelerating, detail: notes.join(', ') || 'Steady' };
}

function buildBarrierMap(closes, highs, lows, ob, price) {
    const barriers = [];
    const n = closes.length;
    const e25 = EMA.calculate({ values: closes, period: 25 }).slice(-1)[0];
    const e99 = EMA.calculate({ values: closes, period: Math.min(99, n-1) }).slice(-1)[0];
    if (e25 > price) barriers.push({ level: e25, type: 'EMA25', strength: 'MEDIUM' });
    if (e99 > price) barriers.push({ level: e99, type: 'EMA99', strength: 'HIGH' });
    for (let i = n - 30; i < n - 2; i++) {
        if (highs[i] > price && highs[i] > highs[i-1] && highs[i] > highs[i+1]) {
            const dist = ((highs[i] - price) / price) * 100;
            if (dist > 0.5 && dist < 25) {
                barriers.push({ level: highs[i], type: 'Swing High', strength: dist < 5 ? 'HIGH' : 'MEDIUM' });
            }
        }
    }
    if (ob?.asks?.length) {
        const avgAskQty = ob.asks.reduce((s,a)=>s+a.qty,0) / ob.asks.length;
        for (const ask of ob.asks) {
            if (ask.price > price && ask.qty > avgAskQty * 3) {
                const dist = ((ask.price - price) / price) * 100;
                barriers.push({ level: ask.price, type: 'Ask Wall', strength: ask.qty > avgAskQty * 6 ? 'HIGH' : 'MEDIUM' });
            }
        }
    }
    barriers.sort((a, b) => a.level - b.level);
    const nearest = barriers.slice(0, 3);
    const highBarriers = nearest.filter(b => b.strength === 'HIGH').length;
    let barrierStrength = 'LOW';
    if (highBarriers >= 2) barrierStrength = 'HIGH';
    else if (highBarriers >= 1 || nearest.length >= 2) barrierStrength = 'MEDIUM';
    const nearestDist = nearest.length > 0 ? ((nearest[0].level - price) / price * 100).toFixed(1) : '20+';
    return {
        barriers: nearest, barrierStrength, nearestDist,
        nearestLevel: nearest[0]?.level ?? null,
        nearestType: nearest[0]?.type ?? 'None detected',
        interpretation: barrierStrength === 'HIGH'
            ? `Strong resistance at ${nearestDist}% — TP1 likely, TP2 conditional`
            : barrierStrength === 'MEDIUM'
            ? `Moderate resistance at ${nearestDist}% — watch for slowdown`
            : `Path relatively clear to ${nearestDist}%+ — expansion possible`,
    };
}

function detectWhalePersistence(closes, highs, lows, volumes, ob) {
    const n        = closes.length;
    const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const volRatioNow = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
    const whaleVolume = volRatioNow > 1.8;
    let bidWallStrong = false;
    if (ob?.bids?.length) {
        const avgBidQty = ob.bids.reduce((s,b)=>s+b.qty,0) / ob.bids.length;
        const maxBid    = ob.bids.reduce((m,b)=>b.qty>m.qty?b:m, ob.bids[0]);
        bidWallStrong   = maxBid.qty > avgBidQty * 3;
    }
    const recentLow      = Math.min(...lows.slice(-3));
    const swing5Low      = Math.min(...lows.slice(-5));
    const holdingStructure = recentLow > swing5Low * 0.995;
    let thinAsks = false;
    if (ob?.asks?.length) {
        const avgAskQty = ob.asks.reduce((s,a)=>s+a.qty,0) / ob.asks.length;
        const maxAsk    = ob.asks.reduce((m,a)=>a.qty>m.qty?a:m, ob.asks[0]);
        thinAsks = maxAsk.qty < avgAskQty * 2.5;
    }
    const whalePersistence = whaleVolume && (bidWallStrong || holdingStructure);
    const persistenceScore = [whaleVolume, bidWallStrong, holdingStructure, thinAsks].filter(Boolean).length;
    return {
        whalePersistence, persistenceScore, whaleVolume, bidWallStrong, holdingStructure, thinAsks,
        interpretation: whalePersistence
            ? persistenceScore >= 3 ? 'Strong whale presence — expansion can extend' : 'Whale support present'
            : 'Whale activity weakening — reduce expectation',
    };
}

function predictExpansionType(r, candle, barrier, whale) {
    const atrPct    = r.atrPct ?? 1;
    const volZ      = r.volZ ?? {};
    const hurst     = r.hurst ?? {};
    const tsmom     = r.tsmom ?? {};
    const lf        = r.lf ?? {};
    const ob        = r.obData ?? {};
    const momentum  = r.momentum ?? {};
    const flowRatio = parseFloat(lf.flowRatio ?? '1');
    const mfi       = parseFloat(lf.mfi ?? '50');
    const volRatio  = parseFloat(r.volRatio ?? '1');
    let scores = { MICRO: 0, CONTROLLED: 0, STRONG: 0, DELAYED: 0, MOON: 0 };
    if (atrPct < 0.8)               scores.MICRO += 3;
    if (volRatio < 1.3)             scores.MICRO += 2;
    if (ob.obScore < 1)             scores.MICRO += 2;
    if (flowRatio < 1.2)            scores.MICRO += 2;
    if (candle.energyScore < 4)     scores.MICRO += 2;
    if (atrPct >= 0.8 && atrPct < 2.0)            scores.CONTROLLED += 3;
    if (volRatio >= 1.2 && volRatio < 2)           scores.CONTROLLED += 2;
    if (mfi > 50 && mfi < 75)                      scores.CONTROLLED += 2;
    if (momentum.momScore >= 4 && momentum.momScore < 8) scores.CONTROLLED += 2;
    if (barrier.barrierStrength === 'MEDIUM')      scores.CONTROLLED += 1;
    if (volZ.z > 2 || volZ.highAnomaly)            scores.STRONG += 3;
    if (ob.buyWall && !ob.sellWall)                scores.STRONG += 2;
    if (tsmom.bullish)                             scores.STRONG += 2;
    if (hurst.hurst > 0.55)                        scores.STRONG += 2;
    if (flowRatio > 1.5)                           scores.STRONG += 2;
    if (whale.whalePersistence)                    scores.STRONG += 2;
    if (candle.energyScore >= 7)                   scores.STRONG += 1;
    if (momentum.momScore >= 8)                    scores.STRONG += 2;
    if (barrier.barrierStrength === 'LOW')         scores.STRONG += 2;
    if (atrPct < 1.0)                              scores.DELAYED += 3;
    if (flowRatio > 2.0)                           scores.DELAYED += 3;
    if (ob.absorption)                             scores.DELAYED += 2;
    if (hurst.hurst > 0.58)                        scores.DELAYED += 2;
    if (r.spring?.spring)                          scores.DELAYED += 3;
    if (volZ.stealth)                              scores.DELAYED += 3;
    if (candle.energyScore < 6 && flowRatio > 1.8) scores.DELAYED += 2;
    if (r.volZ?.z > 0 && r.volZ?.z < 2 && flowRatio > 2) scores.DELAYED += 2;
    if (volZ.z > 3 || (volZ.highAnomaly && volRatio > 3)) scores.MOON += 4;
    if (ob.thinAsks || (!ob.sellWall && ob.buyWall))       scores.MOON += 3;
    if (whale.persistenceScore >= 3)               scores.MOON += 3;
    if (hurst.hurst > 0.60)                        scores.MOON += 2;
    if (flowRatio > 2.5)                           scores.MOON += 2;
    if (r.spring?.spring && volZ.highAnomaly)      scores.MOON += 3;
    if (barrier.barrierStrength === 'LOW')         scores.MOON += 2;
    if (momentum.momScore >= 10)                   scores.MOON += 2;
    const winner  = Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a);
    const typeKey = winner[0];
    const typeScore = winner[1];
    const typeMap = {
        MICRO     : { label: '📉 MICRO MOVE',         maxMove: '2-4%',    emoji: '📉' },
        CONTROLLED: { label: '📊 CONTROLLED MOVE',    maxMove: '4-8%',    emoji: '📊' },
        STRONG    : { label: '💪 STRONG EXPANSION',   maxMove: '8-18%',   emoji: '💪' },
        DELAYED   : { label: '⏳ DELAYED EXPLOSION',  maxMove: '15-60%',  emoji: '⏳' },
        MOON      : { label: '🌙 MOON SETUP',         maxMove: '20%+',    emoji: '🌙' },
    };
    const typeInfo = typeMap[typeKey];
    const maxPossible = { MICRO: 11, CONTROLLED: 10, STRONG: 18, DELAYED: 18, MOON: 21 };
    const rawProb = Math.round((typeScore / (maxPossible[typeKey] || 10)) * 100);
    const expansionProbability = Math.max(20, Math.min(92, rawProb));
    const interpretations = [];
    if (typeKey === 'DELAYED') {
        interpretations.push('Moves slowly at first then explodes — similar to 0G');
        if (flowRatio > 2) interpretations.push(`Flow ${flowRatio}x = quiet stealth accumulation`);
        if (ob.absorption)  interpretations.push('OB Absorption = real buyers present');
        if (r.spring?.spring) interpretations.push('Wyckoff Spring = end of accumulation phase');
    } else if (typeKey === 'MOON') {
        interpretations.push('Moon setup conditions are present');
        if (ob.thinAsks) interpretations.push('Thin asks = weak resistance above price');
        if (whale.whalePersistence) interpretations.push('Whale still present = position still open');
    } else if (typeKey === 'STRONG') {
        if (hurst.hurst > 0.55) interpretations.push(`Hurst=${hurst.hurst} = trending market`);
        if (tsmom.bullish) interpretations.push('TSMOM bullish = momentum continuing');
        if (flowRatio > 1.5) interpretations.push(`Flow ${flowRatio}x = liquidity flowing in`);
    } else if (typeKey === 'CONTROLLED') {
        interpretations.push('Controlled move — TP1 clear, TP2 possible with confirmation');
        if (barrier.barrierStrength === 'MEDIUM') interpretations.push(`Resistance at ${barrier.nearestDist}%`);
    } else {
        interpretations.push('Low ATR + weak volume = limited move expected');
        interpretations.push('Take TP1 only if entering here');
    }
    interpretations.push(barrier.interpretation);
    interpretations.push(whale.interpretation);
    return {
        expansionType       : typeInfo.label,
        expansionTypeKey    : typeKey,
        expansionProbability,
        expectedMaxMove     : typeInfo.maxMove,
        scores,
        canBeLike0G         : typeKey === 'DELAYED' && scores.DELAYED >= 8,
        moonSetupPossible   : typeKey === 'MOON' || (scores.MOON >= 8 && typeKey === 'STRONG'),
        interpretations,
    };
}

function estimateSignalTimeline(atrPct, trigger, expansion, candleEnergy, lf, volRatio) {
    const flowRatio = parseFloat(lf?.flowRatio ?? '1');
    const energy    = candleEnergy?.energyScore ?? 5;
    const trigClass = trigger?.triggerClass ?? 'NEAR';
    const expType   = expansion?.expansionTypeKey ?? 'CONTROLLED';
    const trigDist  = trigger?.triggerDistancePct ?? 2;
    let minH = 1, maxH = 12;
    let basis = [];
    if (expType === 'MICRO')        { minH = 0.5; maxH = 4;   basis.push('low ATR setup'); }
    if (expType === 'CONTROLLED')   { minH = 1;   maxH = 8;   basis.push('controlled move'); }
    if (expType === 'STRONG')       { minH = 0.5; maxH = 6;   basis.push('strong momentum'); }
    if (expType === 'DELAYED')      { minH = 4;   maxH = 48;  basis.push('delayed explosion pattern'); }
    if (expType === 'MOON')         { minH = 2;   maxH = 24;  basis.push('moon setup building'); }
    if (trigClass === 'IMMEDIATE' || trigClass === 'ALREADY_BROKEN') {
        minH = Math.max(0.25, minH * 0.3); maxH = Math.max(1, maxH * 0.4);
        basis.push('near/at breakout level');
    } else if (trigClass === 'DELAYED') {
        minH *= 2; maxH *= 2;
        basis.push(`${trigDist.toFixed(1)}% to breakout level`);
    }
    if (energy >= 7) { minH *= 0.6; maxH *= 0.6; basis.push('strong candle energy'); }
    else if (energy <= 3) { minH *= 1.5; maxH *= 1.5; basis.push('low candle energy'); }
    if (flowRatio > 2.5) { minH *= 0.7; maxH *= 0.7; basis.push('liquidity surging'); }
    else if (flowRatio < 0.9) { minH *= 1.5; maxH *= 1.5; basis.push('flow weak'); }
    if (parseFloat(volRatio) > 2.5) { minH *= 0.6; maxH *= 0.6; basis.push(`volume ${volRatio}x`); }
    minH = Math.max(0.25, +minH.toFixed(1));
    maxH = Math.max(minH + 0.5, +maxH.toFixed(0));
    const fmt2 = h => h < 1 ? `${Math.round(h*60)}m` : h < 24 ? `${h}h` : `${(h/24).toFixed(1)}d`;
    const timeLabel  = `${fmt2(minH)}–${fmt2(maxH)}`;
    const speedLabel = maxH <= 2 ? 'FAST — move likely within hours'
        : maxH <= 8  ? 'MEDIUM — expect move today'
        : maxH <= 24 ? 'PATIENT — may take 1 day'
        : 'DELAYED — accumulating, wait for trigger';
    const speedEmoji = maxH <= 2 ? '⚡' : maxH <= 8 ? '🏃' : maxH <= 24 ? '🚶' : '⏳';
    return { timeLabel, minH, maxH, speedLabel, speedEmoji, basis: basis.join(', ') };
}

function formatExpansionBlock(r) {
    const ex   = r.expansion;
    const bar  = r.barrier;
    const wh   = r.whale;
    const cand = r.candleEnergy;
    if (!ex) return '';
    const whereToSell = ex.expansionTypeKey === 'MICRO'
        ? `Take profit at TP1 (${(r.atrPct*2.5).toFixed(1)}%) — do not wait longer`
        : ex.expansionTypeKey === 'CONTROLLED'
        ? `Exit 50% at TP1 — hold 50% for TP2`
        : ex.expansionTypeKey === 'STRONG'
        ? `Exit 30% at TP1 — let 70% run with trailing stop`
        : ex.expansionTypeKey === 'DELAYED'
        ? `Be patient — may consolidate first then explode. Let it run.`
        : `Hold and take profits gradually — Moon setup`;
    const barrierLine = bar.barrierStrength === 'HIGH'
        ? `⚠️ Strong resistance at ${bar.nearestDist}% (${bar.nearestType})`
        : bar.barrierStrength === 'MEDIUM'
        ? `⚡ Moderate resistance at ${bar.nearestDist}% (${bar.nearestType})`
        : `✅ Path relatively clear — no nearby resistance (${bar.nearestDist}%+)`;
    return (
`\n━━━━━━━━━━━━━━━━━━
*Expansion Engine*
${ex.expansionType} (${ex.expansionProbability}%)
Expected Move: ${ex.expectedMaxMove}
${whereToSell}

${ex.interpretations.slice(0, 3).map(i => ` · ${safeTxt(i)}`).join('\n')}

*Barrier Map:* ${barrierLine}
*Candle Energy:* ${cand?.energyScore ?? '?'}/10 — ${safeTxt(cand?.detail ?? '')}
*Whale:* ${safeTxt(wh?.interpretation ?? 'Unknown')}
${ex.canBeLike0G ? '\n*May behave like 0G — slow accumulation then delayed explosion*' : ''}${ex.moonSetupPossible ? '\n*Moon Setup possible — conditions present*' : ''}`
    );
}

function formatV55Block(r) {
    const lr   = r.lateRisk;
    const trig = r.trigger;
    const pers = r.personality;
    const gr   = r.instGrade;
    const ctx  = r.mktCtx;
    if (!lr && !trig && !pers) return '';
    const lateEmoji = lr?.lateRisk === 'HIGH' ? '🔴' : lr?.lateRisk === 'MEDIUM' ? '🟡' : '🟢';
    const trigEmoji = trig?.triggerClass === 'IMMEDIATE' ? '⚡' : trig?.triggerClass === 'NEAR' ? '🎯' : '⏳';
    const lateNote  = lr?.lateRisk === 'HIGH'
        ? `HIGH — ${safeTxt(lr.lateReasons[0] ?? 'extended move')}`
        : lr?.lateRisk === 'MEDIUM'
        ? `MEDIUM — ${safeTxt(lr.lateReasons[0] ?? 'watch RSI')}`
        : 'LOW — safe entry zone';
    const ctxLine   = ctx ? `${ctx.emoji} Market: ${safeTxt(ctx.context)} (${ctx.contextScore}/20)` : '';
    const gradeLine = gr  ? `${gr.gradeEmoji} Institutional Grade: *${gr.grade}* (${gr.iScore}/100)` : '';
    const timeline  = estimateSignalTimeline(r.atrPct, trig, r.expansion, r.candleEnergy, r.lf, r.volRatio);
    return (
`
━━━━━━━━━━━━━━━━━━
*v6.0 Intelligence*
${ctxLine}
${timeline.speedEmoji} *Expected Timeline: ${timeline.timeLabel}* — ${safeTxt(timeline.speedLabel)}
 · Based on: ${safeTxt(timeline.basis)}
${trigEmoji} Trigger: ${safeTxt(trig?.label ?? 'N/A')}
${lateEmoji} Late Entry Risk: ${lateNote}
${pers?.emoji ?? '⚡'} Expansion Personality: *${pers?.personality ?? 'FAST'}* — ${safeTxt(pers?.note ?? '')}
${gradeLine}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN TOKEN ANALYZER
// ═══════════════════════════════════════════════════════════════════════════
function analyzeToken(symbol, c15, c1h, ticker, ob, btcMom) {
    if (!c15 || !c1h || !ticker) return null;
    const { closes, highs, lows, volumes, opens } = c15;
    const n         = closes.length;
    const last      = closes[n - 1];
    if (!isFinite(last) || last <= 0) return null;
    const rsiArr    = RSI.calculate({ values: closes, period: 14 });
    const rsi       = rsiArr[rsiArr.length - 1];
    const rsiP      = rsiArr[rsiArr.length - 2] ?? rsi;
    const e99       = EMA.calculate({ values: closes, period: Math.min(99, n-1) }).slice(-1)[0];
    const change24h = parseFloat(ticker.priceChangePercent ?? 0);
    const avgVol    = volumes.slice(-20,-1).reduce((a,b)=>a+b,0) / 19;
    const volRatio  = avgVol > 0 ? volumes[n-1] / avgVol : 1;

    // Blueprint engines
    const volZ    = volumeZScore(volumes);
    const vpin    = calcVPIN(closes, volumes);
    const spring  = detectWyckoffSpring(closes, highs, lows, volumes);
    const hurst   = calcHurst(closes.slice(-60));
    const tsmom   = calcTSMOM(closes);
    const parab   = detectParabolicMove(closes, highs, lows);
    const fbCheck = fakeBreakoutCheck(closes, highs, lows, volumes, ob);
    if (vpin.extreme) return null;
    if (btcMom?.bullish === false && rsi < 50) return null;
    const hurstPenalty = hurst.regime === 'MEAN_REV' ? -2 : 0;

    const htf      = confirmHTF(c1h);
    const obR      = analyzeOrderBook(ob);
    const lf       = analyzeLiquidityFlow(closes, highs, lows, volumes);
    const momentum = analyzeMomentum(closes, highs, lows, volumes);
    const accum    = detectStrongAccumulation(closes, volumes, highs, lows);
    const sm       = detectSmartMoneyEntry(closes, volumes, highs, lows);
    const gann     = detectGannWindow(lows);
    const targets  = calcSmartTargets(last, highs, lows, closes, momentum.momScore, volRatio);
    if (targets.atrPct < 0.1) return null;

    let score = 0; let signals = [];

    if (htf.confirmed)          { score += 3; signals.push(`1h Confirmed RSI ${htf.htfRSI}`); }
    else if (htf.htfScore===0)  { score -= 2; signals.push('1h No Structure'); }
    else                        { score -= 1; signals.push(`1h Weak ${htf.reason}`); }

    if (rsi < 35)                               { score += 3; signals.push('RSI Oversold'); }
    else if (rsi >= 35 && rsi < 45 && rsi > rsiP) { score += 2; signals.push('RSI Recovering'); }
    else if (rsi >= 45 && rsi < 58)             { score += 2; signals.push('RSI Sweet Zone'); }

    const e7  = EMA.calculate({ values: closes, period: 7 }).slice(-1)[0];
    const e25 = EMA.calculate({ values: closes, period: 25 }).slice(-1)[0];
    if (e7 > e25 && e25 > e99)           { score += 2; signals.push('EMA Bullish Alignment'); }
    if (Math.abs(e7-e25)/e25 < 0.005)    { score += 2; signals.push('EMA Compression'); }
    if (last > e99)                      { score += 1; signals.push('Above EMA99'); }

    const macdArr = MACD.calculate({ values: closes, fastPeriod:12, slowPeriod:26, signalPeriod:9 });
    const m1 = macdArr[macdArr.length-1], m0 = macdArr[macdArr.length-2];
    if (m0?.histogram < 0 && m1?.histogram > 0)                                         { score += 4; signals.push('MACD Bullish Cross'); }
    else if ((m1?.histogram??0) > (m0?.histogram??0) && (m1?.histogram??0) > 0)          { score += 2; signals.push('MACD Rising'); }

    if (volRatio >= 3.0)      { score += 4; signals.push(`Whale Volume ${volRatio.toFixed(1)}x`); }
    else if (volRatio >= 2.0) { score += 3; signals.push(`Volume Anomaly ${volRatio.toFixed(1)}x`); }
    else if (volRatio >= 1.5) { score += 2; signals.push(`Volume Rising ${volRatio.toFixed(1)}x`); }
    else                      { score += 1; signals.push(`Volume Active ${volRatio.toFixed(1)}x`); }

    const recentRange = (Math.max(...highs.slice(-5)) - Math.min(...lows.slice(-5))) / last;
    if (recentRange < 0.025 && volRatio > 1.4) { score += 3; signals.push('Pre-Breakout Compression'); }
    const body = Math.abs(last - opens[n-1]);
    const lw   = Math.min(last, opens[n-1]) - lows[n-1];
    if (body > 0 && lw > body * 1.5 && volRatio > 1.3) { score += 3; signals.push('Hidden Whale Entry'); }
    if (accum.strong) { score += 4; signals.push(...accum.signals); }
    if (sm.active)    { score += 4; signals.push(...sm.signals); }

    score += obR.obScore; signals.push(...obR.signals);
    score += lf.lfScore;  signals.push(...lf.lfSignals);

    if (gann.active && closes[n-1] > closes[n-2] && parseFloat(lf.flowRatio) > 1.15 && momentum.momScore >= 5) {
        score += 3; signals.push(`Gann ${gann.cycle}-Candle Window`);
        if (accum.strong) { score += 2; signals.push('Gann + Accumulation'); }
    }

    if (targets.atrPct > 2.0)        { score += 3; signals.push(`Explosive ATR ${targets.atrPct.toFixed(1)}%`); }
    else if (targets.atrPct > 1.2)   { score += 2; signals.push(`Fast ATR ${targets.atrPct.toFixed(1)}%`); }
    if (targets.atrPct < 0.3) return null;

    const breakoutConfirmed = last > Math.max(...highs.slice(-10,-1)) && volRatio > 1.4 && parseFloat(lf.flowRatio) > 1.2;
    if (breakoutConfirmed) { score += 3; signals.push('Breakout Confirmed'); }

    const bodyPct = Math.abs(closes[n-1]-opens[n-1]) / opens[n-1] * 100;
    if (bodyPct > 2 && volRatio > 2)    { score += 4; signals.push('Expansion Candle'); }
    if (bodyPct > 3 && volRatio > 2.5)  { score += 2; signals.push('Institutional Expansion'); }

    if (obR.signals.some(s=>s.includes('Buy Wall')) && accum.strong) {
        score += 3; signals.push('Institutional Entry Confirmed');
    }

    if (volZ.highAnomaly)          { score += 4; signals.push(`Vol Z-Score Anomaly z=${volZ.z}`); }
    else if (volZ.medAnomaly)      { score += 2; signals.push(`Vol Anomaly z=${volZ.z}`); }
    if (volZ.stealth)              { score += 2; signals.push('Stealth Accumulation'); }
    if (spring.spring)             { score += 5; signals.push(`Wyckoff Spring ${spring.score}/100`); }
    if (tsmom.bullish)             { score += 2; signals.push(`TSMOM Bullish ${tsmom.signal}`); }
    if (hurst.regime === 'TRENDING') { score += 2; signals.push(`Hurst Trending ${hurst.hurst}`); }
    if (vpin.toxic)                { score -= 3; signals.push(`VPIN Toxic ${vpin.vpin}`); }
    if (fbCheck.isFake)            { score -= 4; signals.push('FAKE BREAKOUT DETECTED'); }
    if (parab.phase === 'PARABOLIC') { score += 2; signals.push('Parabolic Move Active'); }
    if (parab.phase === 'BLOWOFF')   { score -= 3; signals.push('Blowoff Risk'); }
    score += hurstPenalty;

    if (momentum.momScore < 3) score -= 1;
    if (parseFloat(lf.flowRatio) < 0.7) score -= 1;
    if (targets.atrPct < 0.8) score -= 1;
    if (obR.sellWall && volRatio < 2.0 && momentum.momScore < 7) score -= 1;

    if (volRatio > 1.30 && parseFloat(lf.flowRatio) > 1.30 && momentum.momScore >= 5 && rsi < 65) {
        score += 3; signals.push('Explosion Trigger');
    }
    if (volRatio > 1.4 && parseFloat(lf.flowRatio) > 1.3 && momentum.momScore >= 4 && accum.strong) {
        score += 2; signals.push('Early Institutional Pressure');
    }

    signals = [...new Set(signals)];
    score   = Math.min(score, 24);

    const mfiNum = parseFloat(lf.mfi);
    if (mfiNum < 35 && volRatio < 1.5 && momentum.momScore < 4) return null;
    if (obR.sellWall && !obR.buyWall && obR.obScore < 0) return null;
    if (volRatio < 0.5 && change24h < -8) return null;
    if (score < CONFIG.MIN_SCORE && momentum.momScore < 5) return null;
    if (momentum.contProb < CONFIG.MIN_CONT_PROB && volRatio < 1.2) return null;

    let classification;
    if (score >= 17 && momentum.momScore >= 8 && targets.atrPct > 1.2 && volRatio > 1.8)
        classification = '🔥 EXPLOSIVE BREAKOUT';
    else if (score >= 16 && momentum.momScore >= 7 && parseFloat(lf.flowRatio) > 1.5 && volRatio > 1.5)
        classification = '💪 STRONG BREAKOUT';
    else if (score >= 14 && momentum.momScore >= 5 && parseFloat(lf.flowRatio) > 1.25 && volRatio > 1.3)
        classification = '📈 EARLY BREAKOUT';
    else if (score >= 12 && momentum.momScore >= 4 && parseFloat(lf.flowRatio) > 1.1)
        classification = '🔍 ACCUMULATION SETUP';
    else return null;

    const liqTracker = analyzeLiquidityTracker(closes, highs, lows, volumes, ob, lf);
    const trendConf  = analyzeTrendConfirmation(closes, highs, lows, volumes, obR, momentum, lf);
    const multiLeg   = detectMultiLeg(closes, highs, lows, volumes, targets, lf, obR);
    const moonData   = analyzeMoonPotential(closes, highs, lows, volumes, ticker, ob, momentum.momScore, targets.atrPct);

    const candleEnergy = calcCandleEnergy(closes, highs, lows, volumes);
    const barrier      = buildBarrierMap(closes, highs, lows, ob, last);
    const whale        = detectWhalePersistence(closes, highs, lows, volumes, ob);
    const lateRisk     = detectLateEntryRisk(closes, highs, lows, volumes, rsi, targets.atrPct, lf.mfi);
    const trigger      = calcTriggerDistance(last, highs);
    const personality  = classifyExpansionPersonality(targets.atrPct, hurst, obR, lf, candleEnergy, parab);
    const partialR     = { atrPct: targets.atrPct, volZ, hurst, tsmom, lf, obData: obR, momentum, spring, volRatio };
    const expansion    = predictExpansionType(partialR, candleEnergy, barrier, whale);
    const volIntent    = classifyVolumeIntent(closes, highs, lows, volumes, opens);

    const volumeSpringR  = detectVolumeSpring(volumes);
    const liquidityVacuum = detectLiquidityVacuum(ob, last);
    const cvd            = calcCVD(opens, closes, volumes);
    const compression    = calcCompressionScore(highs, lows, closes);
    const mfiDivergence  = detectMFIDivergence(closes, highs, lows, volumes);
    const explosionReadiness = calcExplosionReadiness({
        volRatio: +volRatio.toFixed(2), volumeSpring: volumeSpringR, sellWall: obR.sellWall,
        buyWall: obR.buyWall, liquidityVacuum, wyckoffSpring: spring.spring,
        atrExpansion: parab.atrExp, cvdDivergence: cvd, mfiDivergence, compression,
    });

    const narrative      = getNarrativeBonus(symbol);
    const tokenAge       = calcTokenAge(c15);
    const volToMCap      = calcVolumeToMCap(ticker);
    const greenStreak    = calcGreenStreakDays(closes, opens);
    const volumeFading   = detectVolumeFading(closes, volumes);
    const whaleActivity  = calcWhaleActivity(ob, volumes);
    const weeklyBODefault = { weeklyBreakout: false, monthlyBreakout: false, breakoutBonus: 0, breakoutLabel: '' };
    const sectorMomDefault = getSectorMomentum(symbol, ticker, null);
    const targetMultiplier = calcTargetMultiplier(narrative, tokenAge, volToMCap, weeklyBODefault);
    const adjustedTargets  = {
        tp1  : last * (1 + CONFIG.MIN_TP1_PCT  * targetMultiplier),
        tp2  : last * (1 + CONFIG.MIN_TP2_PCT  * targetMultiplier),
        moon : last * (1 + CONFIG.MIN_MOON_PCT * targetMultiplier),
        targetMultiplier,
    };

    return {
        symbol, classification, score,
        entry: last, tp1: targets.tp1, tp2: targets.tp2, moonPrice: targets.moonP,
        sl: targets.sl, atr: targets.atr, atrPct: targets.atrPct,
        rsi: rsi.toFixed(1), signals, momentum, moonData, htf, gann,
        lf, liqTracker, trendConf, multiLeg,
        change24h: change24h.toFixed(2), volRatio: volRatio.toFixed(2),
        volZ, spring, vpin, hurst, tsmom, parab, fbCheck,
        gannRaw: { lows, closes, volumes },
        expansion, barrier, whale, candleEnergy,
        lateRisk, trigger, personality, volIntent,
        explosionReadiness, volumeSpringR, liquidityVacuum, cvd, compression, mfiDivergence,
        narrative, tokenAge, volToMCap, greenStreak, volumeFading, whaleActivity,
        sectorMom: sectorMomDefault, weeklyBreakout: weeklyBODefault, adjustedTargets,
        quality: last > Math.max(...highs.slice(-20,-1)) && volRatio > 1.5 ? 'Real Breakout Candidate' : 'Developing',
        get rank() {
            let r = this.score + (this.momentum?.momScore ?? 0) + parseFloat(this.lf?.flowRatio ?? 0)
                + (this.signals?.some(s=>s.includes('Explosion Trigger')) ? 4 : 0)
                + (this.signals?.some(s=>s.includes('Institutional Entry')) ? 3 : 0)
                + (this.volZ?.highAnomaly ? 3 : 0)
                + (this.spring?.spring ? 4 : 0)
                + (this.expansion?.expansionTypeKey === 'MOON' ? 5 : 0)
                + (this.expansion?.expansionTypeKey === 'DELAYED' ? 4 : 0)
                + (this.expansion?.canBeLike0G ? 3 : 0)
                + (this.trigger?.triggerClass === 'IMMEDIATE' ? 3 : 0)
                + (this.lateRisk?.lateRisk === 'HIGH' ? -4 : 0)
                + (this.explosionReadiness?.score >= 70 ? 6 : this.explosionReadiness?.score >= 50 ? 3 : 0)
                + (this.narrative?.narrativeBonus ?? 0) / 3
                + (this.greenStreak?.streakBonus ?? 0) / 5
                + (this.weeklyBreakout?.breakoutBonus ?? 0) / 7;
            return r;
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-PUMP DETECTOR
// ═══════════════════════════════════════════════════════════════════════════
function checkPrePumpConditions(symbol, c15, ob) {
    if (!c15) return null;
    const { closes, highs, lows, volumes, opens } = c15;
    const n      = closes.length;
    const volZ   = volumeZScore(volumes);
    const spring = detectWyckoffSpring(closes, highs, lows, volumes);
    const vpin   = calcVPIN(closes, volumes);
    const hurst  = calcHurst(closes.slice(-60));
    const tsmom  = calcTSMOM(closes);
    const parab  = detectParabolicMove(closes, highs, lows);
    const obR    = analyzeOrderBook(ob);
    const lf     = analyzeLiquidityFlow(closes, highs, lows, volumes);
    const vi     = classifyVolumeIntent(closes, highs, lows, volumes, opens);
    const atrShift = detectATRShift(closes, highs, lows, volumes);
    const session  = getSessionWeight();
    const volSpring = detectVolumeSpring(volumes);
    const smAbsorb  = detectSmartMoneyAbsorption(closes, highs, lows, volumes, ob);
    const rsi       = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];

    if (vpin.extreme) return null;
    if (rsi > 72)     return null;
    if (vi.intent === 'STRONG DISTRIBUTION') return null;

    let prePumpScore = 0;
    const prePumpSignals = [];

    if (volZ.highAnomaly)        { prePumpScore += 4; prePumpSignals.push('Vol Z=' + volZ.z + ' HIGH ANOMALY'); }
    else if (volZ.medAnomaly)    { prePumpScore += 2; prePumpSignals.push('Vol Z=' + volZ.z + ' MODERATE'); }
    if (volZ.stealth)            { prePumpScore += 3; prePumpSignals.push('Stealth Accumulation'); }

    if (vi.intent === 'STRONG BUYING')  { prePumpScore += 3; prePumpSignals.push('Vol Intent: Strong Buying'); }
    else if (vi.intent === 'BUYING')    { prePumpScore += 1; prePumpSignals.push('Vol Intent: Buying'); }
    else if (vi.intent === 'ABSORPTION'){ prePumpScore += 2; prePumpSignals.push('Vol Intent: Absorption'); }
    else if (vi.intent === 'DISTRIBUTION') { prePumpScore -= 2; prePumpSignals.push('Vol Intent: Distribution — caution'); }

    if (spring.spring) { prePumpScore += 4; prePumpSignals.push('Wyckoff Spring ' + spring.score + '/100'); }

    if (obR.buyWall && !obR.sellWall && obR.imbalance > 0.60) {
        prePumpScore += 3;
        prePumpSignals.push('Buy Wall + Bid Dom ' + (obR.imbalance*100).toFixed(0) + '%');
    }
    if (obR.imbalance > 0.65 && !obR.sellWall) { prePumpScore += 2; prePumpSignals.push('Heavy bid imbalance'); }

    if (tsmom.signal >= 0.8)      { prePumpScore += 4; prePumpSignals.push('TSMOM Max ' + tsmom.signal); }
    else if (tsmom.bullish)       { prePumpScore += 2; prePumpSignals.push('TSMOM Bullish ' + tsmom.signal); }

    if (hurst.hurst > 0.85)             { prePumpScore += 5; prePumpSignals.push('Hurst ' + hurst.hurst + ' — exceptional trending'); }
    else if (hurst.hurst > 0.75)        { prePumpScore += 3; prePumpSignals.push('Hurst ' + hurst.hurst + ' — strong trending'); }
    else if (hurst.regime === 'TRENDING'){ prePumpScore += 1; prePumpSignals.push('Hurst ' + hurst.hurst + ' (Trending)'); }

    if (atrShift.atrBehavior === 'COILING')            { prePumpScore += 3; prePumpSignals.push('ATR Coiling — compressed'); }
    else if (atrShift.atrBehavior === 'EXPLOSIVE')     { prePumpScore += 3; prePumpSignals.push('ATR Explosive ' + atrShift.atrExpansion + 'x'); }
    else if (atrShift.atrBehavior === 'HEALTHY_EXPANSION') { prePumpScore += 2; prePumpSignals.push('ATR Healthy Expansion'); }
    else if (atrShift.atrBehavior === 'FAKE_SPIKE' || atrShift.atrBehavior === 'DANGEROUS_SPIKE') { prePumpScore -= 2; prePumpSignals.push('ATR Spike — possible fake move'); }
    else if (parab.phase === 'EXPANDING')              { prePumpScore += 2; prePumpSignals.push('ATR Expanding ' + parab.atrExp + 'x'); }

    if (rsi >= 35 && rsi <= 55) { prePumpScore += 1; prePumpSignals.push('RSI Sweet Zone ' + rsi.toFixed(0)); }
    if (session.weight > 0)     { prePumpScore += session.weight; prePumpSignals.push(session.session + ' — ' + session.note); }
    else if (session.weight < 0) { prePumpScore += session.weight; }

    const rangeHigh   = Math.max(...highs.slice(-20));
    const distToHigh  = (rangeHigh - closes[n-1]) / closes[n-1] * 100;
    if (distToHigh < 1.0 && distToHigh > 0)        { prePumpScore += 4; prePumpSignals.push('Imminent Breakout (' + distToHigh.toFixed(1) + '% away)'); }
    else if (distToHigh < 2.0 && distToHigh > 0)   { prePumpScore += 2; prePumpSignals.push('Near Range High (' + distToHigh.toFixed(1) + '% away)'); }
    else if (distToHigh < 3.0 && distToHigh > 0)   { prePumpScore += 1; prePumpSignals.push('Approaching High (' + distToHigh.toFixed(1) + '% away)'); }

    const baResult = detectBreakoutAcceptance(closes, highs, lows, volumes, ob);
    if (baResult.acceptance === 'ACCEPTED')   { prePumpScore += 4; prePumpSignals.push('Breakout Accepted'); }
    else if (baResult.acceptance === 'FAILED') { prePumpScore -= 3; prePumpSignals.push('Breakout Failed'); }

    if (volSpring.springReady) { prePumpScore += 5; prePumpSignals.push('Volume Spring READY'); }
    else if (volSpring.dryUp)  { prePumpScore += 2; prePumpSignals.push('Volume Dry-Up detected'); }

    if (smAbsorb.absorbing)              { prePumpScore += 4; prePumpSignals.push('Smart Money Absorption — ' + smAbsorb.absorptionNote); }
    else if (smAbsorb.absorptionScore >= 35) { prePumpScore += 2; prePumpSignals.push('Partial Absorption (' + smAbsorb.absorptionScore + '/100)'); }

    const cvdPP    = calcCVD(opens, closes, volumes);
    const comprPP  = calcCompressionScore(highs, lows, closes);
    const mfiDivPP = detectMFIDivergence(closes, highs, lows, volumes);
    const liqVacPP = detectLiquidityVacuum(ob, closes[closes.length - 1]);
    const ppExplosionR = calcExplosionReadiness({
        volRatio: (volumes[volumes.length-1] / (volumes.slice(-20,-1).reduce((a,b)=>a+b,0)/19 || 1)),
        volumeSpring: volSpring, sellWall: obR.sellWall, buyWall: obR.buyWall,
        liquidityVacuum: liqVacPP, wyckoffSpring: spring.spring, atrExpansion: parab.atrExp,
        cvdDivergence: cvdPP, mfiDivergence: mfiDivPP, compression: comprPP,
    });
    if (ppExplosionR.score >= 70)      { prePumpScore += 8; prePumpSignals.push('Explosion Readiness HIGH ' + ppExplosionR.score + '/100'); }
    else if (ppExplosionR.score >= 50) { prePumpScore += 5; prePumpSignals.push('Explosion Readiness ' + ppExplosionR.score + '/100'); }

    prePumpScore = Math.min(prePumpScore, 20);
    if (prePumpScore < CONFIG.PREPUMP_MIN_SCORE) return null;
    if (prePumpSignals.length < 3) return null;

    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr    = atrArr[atrArr.length - 1];
    const price  = closes[n-1];
    const bidDepthUSDT = ob && ob.bids ? ob.bids.reduce((s,b) => s + b.price * b.qty, 0) : 0;
    const askDepthUSDT = ob && ob.asks ? ob.asks.reduce((s,a) => s + a.price * a.qty, 0) : 0;
    const obRatio      = askDepthUSDT > 0 ? bidDepthUSDT / askDepthUSDT : 1;
    const avgVol20     = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const avgVol5      = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
    const volMult      = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

    const strongIndicators = [
        hurst.hurst > 0.75, tsmom.signal >= 0.6, volZ.highAnomaly, volZ.stealth, spring.spring,
        vi.intent === 'STRONG BUYING' || vi.intent === 'ABSORPTION',
        atrShift.atrBehavior === 'COILING' || atrShift.atrBehavior === 'EXPLOSIVE',
        obR.buyWall && !obR.sellWall,
    ].filter(Boolean).length;

    let ppExpansion = 'CONTROLLED MOVE';
    if (hurst.hurst > 0.85 && tsmom.signal >= 0.8 && distToHigh < 2.0) ppExpansion = 'STRONG EXPANSION';
    else if (volZ.highAnomaly && hurst.hurst > 0.75 && bidDepthUSDT > askDepthUSDT * 1.5) ppExpansion = 'STRONG EXPANSION';
    if (volZ.stealth && obR.absorption && hurst.hurst > 0.6) ppExpansion = 'DELAYED EXPLOSION (0G pattern)';
    if (atrShift.atrBehavior === 'COILING' && volZ.stealth && hurst.hurst > 0.7) ppExpansion = 'DELAYED EXPLOSION (0G pattern)';
    if (volZ.highAnomaly && volMult > 3 && !obR.sellWall && vi.intent === 'STRONG BUYING') ppExpansion = 'MOON SETUP';

    const instConfidence = Math.min(100, Math.max(0,
        prePumpScore * 4 + session.weight * 5 + (vi.intentScore || 50) * 0.2 + atrShift.atrBehaviorScore * 0.2
    ));
    const instClass = instConfidence >= 80 ? 'EXPLOSIVE' : instConfidence >= 65 ? 'CLEAN' : instConfidence >= 45 ? 'RISKY' : 'TRAP';

    return {
        symbol, price, prePumpScore, prePumpSignals,
        rsi: rsi.toFixed(1), volZ, spring, hurst, tsmom, parab, obR, lf, atr,
        atrPct: ((atr/price)*100).toFixed(2),
        nearHigh: distToHigh < 3, distToHigh: distToHigh.toFixed(1),
        bidDepthUSDT, askDepthUSDT, obRatio: obRatio.toFixed(2),
        volMult: volMult.toFixed(1), strongIndicators, ppExpansion, avgVol20,
        volIntent: vi, atrShift, session, baResult, volSpring, smAbsorb,
        instConfidence: Math.round(instConfidence), instClass,
    };
}

function formatPrePumpAlert(r) {
    const strengthLabel =
        r.strongIndicators >= 5 ? '⭐ ELITE SETUP' :
        r.strongIndicators >= 3 ? '💪 STRONG SETUP' :
        r.strongIndicators >= 2 ? '📊 MODERATE SETUP' : '📡 EARLY SIGNAL';
    const instLine   = r.instConfidence !== undefined ? `💼 Inst. Confidence: ${r.instConfidence}/100 — ${r.instClass}` : '';
    const sessionLine = r.session ? `${r.session.emoji} Session: ${r.session.session} (weight: ${r.session.weight >= 0 ? '+' : ''}${r.session.weight})` : '';
    const atrLine    = r.atrShift ? `📐 ATR: ${r.atrShift.atrBehavior} — ${r.atrShift.atrNote}` : '';
    const baLine     = r.baResult && r.baResult.acceptance !== 'NOT_YET' ? `🎯 Breakout: ${r.baResult.acceptance} (score: ${r.baResult.acceptanceScore}/100)` : '';
    const bidK = r.bidDepthUSDT > 0 ? (r.bidDepthUSDT/1000).toFixed(1) : '?';
    const askK = r.askDepthUSDT > 0 ? (r.askDepthUSDT/1000).toFixed(1) : '?';
    const obLine = r.bidDepthUSDT > 0 ? `Bids $${bidK}K vs Asks $${askK}K | Ratio ${r.obRatio}x` : 'OB data unavailable';
    const obPushEst =
        parseFloat(r.obRatio) >= 2.0 ? '10-20% move well supported by OB depth' :
        parseFloat(r.obRatio) >= 1.5 ? '5-10% move likely — good bid support' :
        parseFloat(r.obRatio) >= 1.0 ? 'Balanced — watch for seller re-entry' :
        'Sellers outweigh — risk of rejection';
    const volZLine = r.volZ?.highAnomaly ? `⚡ Vol Z=${r.volZ.z} HIGH ANOMALY` : r.volZ?.medAnomaly ? `📊 Vol Z=${r.volZ.z} MODERATE` : `📊 Vol Z=${r.volZ?.z ?? 'N/A'} normal`;
    const volMultNum = parseFloat(r.volMult ?? '1');
    const volTrendLine = volMultNum > 2.5 ? `${r.volMult}x avg 🔥 SURGING` : volMultNum > 1.5 ? `${r.volMult}x avg 📈 RISING` : volMultNum < 0.7 ? `${r.volMult}x avg 📉 WEAK` : `${r.volMult}x avg ➡️ STABLE`;
    const atrNum    = parseFloat(r.atrPct ?? '1');
    const atrDetail = r.atrShift
        ? `ATR=${r.atrPct}% [${r.atrShift.atrBehavior}] — ${r.atrShift.atrNote}`
        : atrNum < 0.8 ? `ATR=${r.atrPct}% [COILING] — compressed` : `ATR=${r.atrPct}% [NORMAL]`;
    const tsmomDetail = r.tsmom.bullish ? `TSMOM=${r.tsmom.signal} 📈 bullish` : r.tsmom.bearish ? `TSMOM=${r.tsmom.signal} 📉 weakening` : `TSMOM=${r.tsmom.signal} ⚪ neutral`;
    const hurstDetail = r.hurst.hurst > 0.8 ? `H=${r.hurst.hurst} STRONG TRENDING` : r.hurst.hurst > 0.6 ? `H=${r.hurst.hurst} TRENDING` : `H=${r.hurst.hurst} [${r.hurst.regime}]`;
    const indicatorsBlock = [
        `📊 ${hurstDetail}`, `📈 ${tsmomDetail}`, `📐 ${atrDetail}`,
        r.parab.phase !== 'NORMAL' ? `🌀 Parabolic: ${r.parab.phase} (${r.parab.atrExp}x ATR)` : '',
        r.spring.spring ? `🌱 Wyckoff Spring ${r.spring.score}/100` : '',
        volZLine,
        r.volZ?.stealth ? `🔇 Stealth Accumulation — 3d avg > 1.5x 14d avg` : '',
    ].filter(Boolean).join('\n');
    const actionLine =
        r.ppExpansion.includes('MOON')    ? 'Hold full — thin ask wall above. Let it run' :
        r.ppExpansion.includes('DELAYED') ? 'Be patient — may consolidate then explode (0G style)' :
        r.ppExpansion.includes('STRONG')  ? 'Aggressive entry on confirm — strong OB support' :
        '50% at TP1, trail rest with stop at entry';
    const confirm = fmt(r.price * 1.03);
    const stop    = fmt(r.price * (1 - 0.025));
    return (
`🚨 *PRE-PUMP DETECTED*
*${r.symbol}* @ \`${fmt(r.price)}\`
${strengthLabel} | Score: ${r.prePumpScore}/20

📊 *Indicators Breakdown:*
${indicatorsBlock}

――――――――――――――――――
*Signals Detected:*
${r.prePumpSignals.map(s => ' • ' + safeTxt(s)).join('\n')}

――――――――――――――――――
💰 *OB Depth:* ${obLine}
 • ${obPushEst}
 • Bid/Ask ratio: ${r.obRatio}x

📦 *Volume:* ${volTrendLine}
📐 *Expansion Type:* ${r.ppExpansion}
🎯 *Action:* ${actionLine}
${sessionLine ? ' • ' + sessionLine : ''}
${baLine ? ' • ' + baLine : ''}
${instLine ? ' • ' + instLine : ''}

――――――――――――――――――
*Entry Plan:*
 • Confirm above: \`${confirm}\` (+3%) on strong volume
 • Stop: \`${stop}\` (−2.5%)
 • TP1: \`${fmt(r.price*1.10)}\` (+10%) | TP2: \`${fmt(r.price*1.20)}\` (+20%) | Moon: \`${fmt(r.price*1.40)}\` (+40%)
 • ${r.nearHigh ? `${r.distToHigh}% to range breakout — imminent` : 'Not near range high yet'}
${r.ppExpansion.includes('DELAYED') ? '\n⏳ Pattern similar to 0G — delayed explosion, hold through consolidation' : ''}
${r.spring.spring ? `🌱 Wyckoff Spring ${r.spring.score}/100 — accumulation ending` : ''}${r.hurst.hurst > 0.75 ? `\n📈 Hurst H=${r.hurst.hurst} — strong trending structure` : ''}
_v6.0 Pre-Pump Engine | ${new Date().toUTCString()}_`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMAT MAIN SIGNAL MESSAGE
// ═══════════════════════════════════════════════════════════════════════════
function calcTimeToTarget(entry, target, atrPct, classification) {
    if (!entry || !target || !atrPct || atrPct <= 0) return 'Per Gann Cycle';
    const movePct = Math.abs((target - entry) / entry) * 100;
    let sf;
    if (classification?.includes('EXPLOSIVE')) sf = 2;
    else if (classification?.includes('STRONG')) sf = 4;
    else if (classification?.includes('EARLY'))  sf = 6;
    else sf = 5;
    const minC = Math.max(1, Math.round(movePct / atrPct));
    const maxC = minC * sf;
    function toTime(c) {
        const mins = c * 15;
        if (mins < 60)   return `${mins}m`;
        if (mins < 1440) return `${(mins/60).toFixed(1)}h`;
        return `${(mins/1440).toFixed(1)}d`;
    }
    return `${toTime(minC)}–${toTime(maxC)}`;
}

function formatMessage(r, isUpdate = false) {
    const m    = r.momentum    ?? {};
    const mp   = r.moonData    ?? {};
    const lt   = r.liqTracker  ?? {};
    const tc   = r.trendConf   ?? {};
    const ml   = r.multiLeg    ?? {};
    const gs   = gannShortEngine(r.gannRaw?.lows ?? [], r.gannRaw?.closes ?? [], r.gannRaw?.volumes ?? []);
    const bpLine = [
        r.volZ?.highAnomaly ? `⚡ Vol Z=${r.volZ.z}` : r.volZ?.medAnomaly ? `📊 Vol Z=${r.volZ.z}` : '',
        r.spring?.spring    ? `🌱 Wyckoff Spring ${r.spring.score}/100` : '',
        r.hurst?.regime === 'TRENDING' ? `📈 H=${r.hurst.hurst}` : '',
        r.tsmom?.bullish    ? `🚀 TSMOM ${r.tsmom.signal}` : '',
        r.parab?.phase !== 'NORMAL' ? `🌀 ${r.parab.phase} (${r.parab.atrExp}x)` : '',
        r.vpin?.toxic       ? `☣️ VPIN ${r.vpin.vpin}` : '',
        r.fbCheck?.isFake   ? `⚠️ FAKE BREAKOUT` : '',
    ].filter(Boolean).join(' | ');

    const gradeLabel = r.instGrade
        ? (r.instGrade.grade === 'A+' ? '⭐⭐⭐ STRONG SETUP' :
           r.instGrade.grade === 'A'  ? '⭐⭐ GOOD SETUP'    :
           r.instGrade.grade === 'B'  ? '⭐ MODERATE SETUP'  : '⚠️ WEAK SETUP')
        : '';
    const convictionNote = r.instGrade?.grade === 'C' ? ' — Low conviction, wait for confirmation' : '';
    const narrativeTag   = r.narrative ? ` ${r.narrative.categoryEmoji} ${r.narrative.category}` : '';

    // v6.0 Institutional block
    const instMsg = r._instLayer ? formatInstitutionalSummary(r._instLayer.verdict, r.symbol) : '';

    const header = isUpdate
        ? `🔄 *UPDATE* — ${r.symbol}\n${tc.trendStatus}\n\n`
        : `${r.classification}\n*${r.symbol}*${narrativeTag}  ${gradeLabel}${convictionNote}\n`;
    return (
        header +
        `   1h: ${r.htf?.confirmed ? `✅ RSI ${r.htf.htfRSI}` : `❌ ${r.htf?.reason}`}\n\n` +
        `   Entry: \`${fmt(r.entry)}\`\n` +
        `   SL:    \`${fmt(r.sl)}\` (−${pct(r.entry,r.sl).replace('-','')}%) | ${calcTimeToTarget(r.entry,r.sl,r.atrPct,r.classification)}\n` +
        `   TP1:   \`${fmt(r.tp1)}\` (+${pct(r.entry,r.tp1)}%) | ${calcTimeToTarget(r.entry,r.tp1,r.atrPct,r.classification)}\n` +
        `   TP2:   \`${fmt(r.tp2)}\` (+${pct(r.entry,r.tp2)}%) | ${calcTimeToTarget(r.entry,r.tp2,r.atrPct,r.classification)}\n` +
        `   Moon:  \`${fmt(r.moonPrice)}\` (+${pct(r.entry,r.moonPrice)}%)\n` +
        `   ATR: ${fmt(r.atr)} (${(r.atrPct??0).toFixed(1)}%)\n\n` +
        `   RSI: ${r.rsi} | Vol: ${r.volRatio}x | 24h: ${r.change24h}%\n` +
        `   Score: ${r.score}/24 | ${r.quality}\n` +
        (bpLine ? `\n   *Blueprint:* ${bpLine}\n` : '') +
        (r.volIntent ? `${r.volIntent.line}\n` : '') +
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `   *Momentum: ${m.label}*\n` +
        ` Continuation: *${m.contProb}%*\n` +
        `${(m.signals??[]).slice(0,3).map(s=>` · ${safeTxt(s)}`).join('\n')}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `   *Moon Potential: ${mp.label}* — ${mp.pct}\n` +
        `${(mp.signals??[]).slice(0,2).map(s=>` · ${safeTxt(s)}`).join('\n')}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `   *Liquidity* MFI: ${r.lf?.mfi} | Flow: ${r.lf?.flowRatio}x\n` +
        `${(r.lf?.lfSignals??[]).slice(0,2).map(s=>` · ${safeTxt(s)}`).join('\n')}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `   *Trend:* ${tc.trendStatus}\n` +
        ` Liq Tracker: ${lt.status} | Risk: ${lt.liqRisk}\n` +
        (ml.isMultiLeg ? `🔥 *${ml.label}*\n` : '') +
        (gs.cycleStatus ? `\n   *Gann:* ${gs.angleStatus} | ${gs.cycleStatus}\n` : '') +
        `\n━━━━━━━━━━━━━━━━━━\n` +
        `   *Signals:*\n` +
        `${r.signals.slice(0,8).map(s=>` • ${safeTxt(s)}`).join('\n')}\n\n` +
        (() => {
            const at = r.adjustedTargets;
            const na = r.narrative;
            const ta = r.tokenAge;
            const gs2 = r.greenStreak;
            const vm = r.volToMCap;
            const wb = r.weeklyBreakout;
            const wa = r.whaleActivity;
            const vf = r.volumeFading;
            if (!at || at.targetMultiplier <= 1.2) return '';
            let block = `\n━━━━━━━━━━━━━━━━━━\n🎯 *MOONSHOT POTENTIAL: ${at.targetMultiplier.toFixed(1)}x*\n`;
            if (na?.narrativeBonus > 0) block += ` · Narrative: ${na.categoryEmoji} ${na.category}\n`;
            if (ta?.ageDays)            block += ` · Age: ${ta.ageDays}d — ${ta.ageCategory}\n`;
            if (gs2?.greenStreak > 2)   block += ` · Green streak: ${gs2.greenStreak}d — ${gs2.streakLabel}\n`;
            if (vm?.ratioCategory !== 'UNKNOWN') block += ` · Liquidity: ${vm.ratioCategory}\n`;
            if (wb?.breakoutLabel)      block += ` · 🚀 ${wb.breakoutLabel}\n`;
            if (wa?.whaleScore > 15)    block += ` · 🐳 ${wa.whaleActivity}\n`;
            block += ` · Adjusted Targets: TP1 \`${fmt(at.tp1)}\` | TP2 \`${fmt(at.tp2)}\` | Moon \`${fmt(at.moon)}\``;
            if (vf?.exitUrgency === 'HIGH') block += `\n⚠️ *EXIT WARNING: Volume fading — tighten stop*`;
            return block;
        })() +
        formatExpansionBlock(r) +
        (() => {
            const er = r.explosionReadiness;
            if (!er || er.score < 30) return '';
            const erEmoji = er.score >= 70 ? '🔥' : er.score >= 50 ? '💥' : '⚡';
            return `\n━━━━━━━━━━━━━━━━━━\n${erEmoji} *Explosion Readiness: ${er.score}/100* — ${safeTxt(er.potential)}\n · ${er.signals.slice(0, 4).map(safeTxt).join(' | ')}\n`;
        })() +
        formatV55Block(r) +
        instMsg +
        `\n_v6.0 • ${new Date().toUTCString()}_`
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION TRACKER
// ═══════════════════════════════════════════════════════════════════════════
function loadTracked() {
    try {
        if (fs.existsSync(CONFIG.TRACKER_FILE)) return JSON.parse(fs.readFileSync(CONFIG.TRACKER_FILE, 'utf8'));
    } catch {}
    return {};
}
function saveTracked(data) {
    try { fs.writeFileSync(CONFIG.TRACKER_FILE, JSON.stringify(data, null, 2)); } catch {}
}

const TRACKED = loadTracked();

function trackPosition(symbol, entryPrice) {
    TRACKED[symbol] = { symbol, entry: entryPrice, openTime: Date.now(), peak: entryPrice, lastAlert: 0, alertCount: 0 };
    saveTracked(TRACKED);
}
function untrackPosition(symbol) {
    delete TRACKED[symbol];
    saveTracked(TRACKED);
}

async function calcContinuationScore(symbol, pos) {
    const [c15, c1h, ob] = await Promise.all([
        getCandles(symbol, '15m', 80),
        getCandles(symbol, '1h',  40),
        getOrderBook(symbol),
    ]);
    if (!c15) return null;
    const { closes, highs, lows, volumes, opens } = c15;
    const n       = closes.length;
    const price   = closes[n-1];
    const rsi     = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
    const volZ    = volumeZScore(volumes);
    const tsmom   = calcTSMOM(closes);
    const parab   = detectParabolicMove(closes, highs, lows);
    const obR     = analyzeOrderBook(ob);
    const lf      = analyzeLiquidityFlow(closes, highs, lows, volumes);
    const vpin    = calcVPIN(closes, volumes);
    const htf     = c1h ? confirmHTF(c1h) : null;
    const momentum   = analyzeMomentum(closes, highs, lows, volumes);
    const trendConf  = analyzeTrendConfirmation(closes, highs, lows, volumes, obR, momentum, lf);
    const volIntent  = classifyVolumeIntent(closes, highs, lows, volumes, opens);

    if (price > pos.peak) pos.peak = price;
    const pnlPct   = ((price - pos.entry) / pos.entry) * 100;
    const peakPct  = ((pos.peak - pos.entry) / pos.entry) * 100;
    const fromPeak = pos.peak > 0 ? ((price - pos.peak) / pos.peak) * 100 : 0;

    let contScore = 50;
    const verdict  = [];
    const warnings = [];

    if (trendConf.trendStatus === 'Continuation Strong')   { contScore += 20; verdict.push('✅ Trend strong'); }
    else if (trendConf.trendStatus === 'Continuation Moderate') { contScore += 10; verdict.push('📊 Trend moderate'); }
    else if (trendConf.trendStatus === 'Weakening')         { contScore -= 15; warnings.push('⚠️ Trend weakening'); }
    else if (trendConf.trendStatus === 'Trend Stop')        { contScore -= 30; warnings.push('🔴 Trend stopped'); }

    if (momentum.momScore >= 8) { contScore += 15; verdict.push('💪 Momentum strong'); }
    else if (momentum.momScore >= 5) { contScore += 5; }
    else { contScore -= 10; warnings.push('⚠️ Momentum weak'); }

    if (rsi > 50 && rsi < 70) { contScore += 10; verdict.push(`✅ RSI healthy ${rsi.toFixed(0)}`); }
    else if (rsi >= 70)        { contScore -= 15; warnings.push(`🔴 RSI overbought ${rsi.toFixed(0)}`); }

    if (parseFloat(lf.flowRatio) > 1.3) { contScore += 10; verdict.push('✅ Flow strong'); }
    else if (parseFloat(lf.flowRatio) < 0.8) { contScore -= 10; warnings.push('⚠️ Flow weak'); }

    if (obR.buyWall && !obR.sellWall) { contScore += 10; verdict.push('✅ Buy wall support'); }
    if (obR.sellWall)                  { contScore -= 10; warnings.push('⚠️ Sell wall overhead'); }

    if (tsmom.bullish) { contScore += 8; verdict.push('🚀 TSMOM bullish'); }
    if (tsmom.bearish) { contScore -= 10; warnings.push('⚠️ TSMOM bearish'); }

    if (parab.phase === 'PARABOLIC') { contScore += 5; verdict.push('🌀 Parabolic phase'); }
    if (parab.phase === 'BLOWOFF')   { contScore -= 20; warnings.push('⚠️ Blowoff risk'); }

    if (vpin.toxic)     { contScore -= 10; warnings.push('☣️ VPIN toxic flow'); }
    if (htf?.confirmed) { contScore += 8; verdict.push('✅ 1h confirmed'); }

    contScore = Math.max(0, Math.min(100, contScore));

    let projection, projEmoji;
    if (contScore >= 75)      { projection = 'Strong continuation';  projEmoji = '🟢'; }
    else if (contScore >= 60) { projection = 'Cautious continuation'; projEmoji = '🟡'; }
    else if (contScore >= 40) { projection = 'Uncertain — monitor';  projEmoji = '🟠'; }
    else                      { projection = 'Stop or reduce size';   projEmoji = '🔴'; }

    const atrArr  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr     = atrArr[atrArr.length-1] ?? 0;
    const stoProj = price + atr * (contScore / 100) * 10;
    const stoProjPct = ((stoProj - pos.entry) / pos.entry * 100).toFixed(1);

    return {
        price, pnlPct: +pnlPct.toFixed(2), peakPct: +peakPct.toFixed(2),
        fromPeak: +fromPeak.toFixed(2), contScore, projection, projEmoji,
        stoProj: +stoProj.toFixed(8), stoProjPct,
        verdict, warnings, trendStatus: trendConf.trendStatus,
        rsi: +rsi.toFixed(1), lf, momentum, parab, volIntent,
    };
}

function formatTrackerUpdate(symbol, pos, analysis, isClose = false) {
    const age      = Math.round((Date.now() - pos.openTime) / 60000);
    const pnlEmoji = analysis.pnlPct >= 0 ? '📈' : '📉';
    return (
`${analysis.projEmoji} *TRACKER: ${symbol}*
${isClose ? '🚨 *FINAL UPDATE*\n' : ''}
   Entry: \`${fmt(pos.entry)}\` → Now: \`${fmt(analysis.price)}\`
   P&L: ${analysis.pnlPct >= 0 ? '+' : ''}${analysis.pnlPct}% ${pnlEmoji}
   Peak: +${analysis.peakPct}% | From peak: ${analysis.fromPeak}%
   Age: ${age} min

━━━━━━━━━━━━━
   *Continuation: ${analysis.contScore}/100*
${analysis.projEmoji} *${analysis.projection}*

   Trend: ${analysis.trendStatus}
RSI: ${analysis.rsi} | Flow: ${analysis.lf?.flowRatio}x | Momentum: ${analysis.momentum?.label}
${analysis.volIntent ? analysis.volIntent.line : ''}
${analysis.parab?.phase !== 'NORMAL' ? `🌀 ${analysis.parab.phase} (ATR ${analysis.parab.atrExp}x)` : ''}
${analysis.verdict.slice(0,3).map(safeTxt).join(' | ')}
${analysis.warnings.length ? analysis.warnings.slice(0,2).map(safeTxt).join(' | ') : ''}

   *Projection* (STO-style):
${fmt(analysis.stoProj)} (+${analysis.stoProjPct}% from entry)
_Based on current momentum × ATR_
_v6.0 Tracker | ${new Date().toUTCString()}_`
    );
}

async function reviewTrackedPositions() {
    const symbols = Object.keys(TRACKED);
    if (!symbols.length) return;
    for (const symbol of symbols) {
        const pos = TRACKED[symbol];
        const ageDays = (Date.now() - pos.openTime) / (1000 * 60 * 60 * 24);
        if (ageDays > CONFIG.TRACKER_MAX_AGE_DAYS) {
            await sendTelegram(`🗑️ *${symbol}* tracker removed after ${CONFIG.TRACKER_MAX_AGE_DAYS}d`);
            untrackPosition(symbol);
            continue;
        }
        try {
            const analysis = await calcContinuationScore(symbol, pos);
            if (!analysis) continue;

            // v6.0 Institutional tracker upgrade
            try {
                const [c15t, c1ht, c4ht, obt] = await Promise.all([
                    getCandles(symbol, '15m', 80),
                    getCandles(symbol, '1h', 40),
                    get4hCandles(symbol),
                    getOrderBook(symbol),
                ]);
                const trackerOut = await runTrackerInstitutional(pos, c15t, c1ht, c4ht, obt);
                if (trackerOut) {
                    const instTrackerMsg = formatTrackerUpdateInstitutional(trackerOut, pos);
                    if (instTrackerMsg) analysis._instTrackerMsg = instTrackerMsg;
                }
            } catch {}

            const now      = Date.now();
            const cooldown = pos.alertCount < 3 ? 15 * 60 * 1000 : 30 * 60 * 1000;
            if (now - pos.lastAlert < cooldown) continue;

            const shouldAlert =
                analysis.contScore <= 35 ||
                analysis.trendStatus === 'Trend Stop' ||
                analysis.fromPeak < -5 ||
                analysis.pnlPct >= 20 ||
                analysis.pnlPct >= 50 ||
                analysis.pnlPct >= 100 ||
                (now - pos.lastAlert) > 30 * 60 * 1000;

            if (shouldAlert) {
                const isClose = analysis.contScore <= 30 || analysis.trendStatus === 'Trend Stop';
                const baseMsg = formatTrackerUpdate(symbol, pos, analysis, isClose);
                const fullMsg = analysis._instTrackerMsg ? baseMsg + '\n\n' + analysis._instTrackerMsg : baseMsg;
                await sendTelegram(fullMsg);
                pos.lastAlert  = now;
                pos.peak       = Math.max(pos.peak, analysis.price);
                pos.alertCount = (pos.alertCount || 0) + 1;
                saveTracked(TRACKED);
                if (isClose) {
                    await sleep(1000);
                    await sendTelegram(`🚨 *${symbol}* — Consider closing or tightening stop. Continuation: ${analysis.contScore}/100`);
                }
            }
        } catch (e) { console.error(`[Tracker] ${symbol}:`, e.message); }
        await sleep(500);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
const TelegramBotLib = require('node-telegram-bot-api');
const _standaloneMode = require.main === module;
const cmdBot = _standaloneMode
  ? new TelegramBotLib(CONFIG.TELEGRAM_TOKEN, { polling: true })
  : { onText: () => {}, sendMessage: async () => {} };

cmdBot.onText(/\/track (.+)/, async (msg, match) => {
    const parts  = match[1].trim().split(/\s+/);
    if (parts.length < 2) {
        await cmdBot.sendMessage(msg.chat.id, '⚠️ Usage: /track SYMBOL ENTRY_PRICE\nExample: /track STOUSDT 0.13');
        return;
    }
    const symbol = parts[0].toUpperCase().endsWith('USDT') ? parts[0].toUpperCase() : parts[0].toUpperCase() + 'USDT';
    const entry  = parseFloat(parts[1]);
    if (isNaN(entry) || entry <= 0) {
        await cmdBot.sendMessage(msg.chat.id, '⚠️ Invalid price. Use: /track STOUSDT 0.13');
        return;
    }
    trackPosition(symbol, entry);
    await cmdBot.sendMessage(msg.chat.id,
        `✅ *Tracking ${symbol}*\nEntry: \`${fmt(entry)}\`\nUpdates every 15–30 min\nTo stop: /untrack ${symbol}`,
        { parse_mode: 'Markdown' });
    try {
        const pos = TRACKED[symbol];
        const [analysis, c15track, c1htrack, c4htrack, obtrack] = await Promise.all([
            calcContinuationScore(symbol, pos),
            getCandles(symbol, '15m', 120),
            getCandles(symbol, '1h', 60),
            get4hCandles(symbol),
            getOrderBook(symbol),
        ]);
        if (analysis) {
            pos.lastAlert = Date.now();
            saveTracked(TRACKED);
            await cmdBot.sendMessage(msg.chat.id, formatTrackerUpdate(symbol, pos, analysis), { parse_mode: 'Markdown' });
        }
        await sleep(400);
        const deepPP = formatDeepPrePumpAnalysis(symbol, c15track, obtrack, 'PRE-PUMP STATUS');
        await cmdBot.sendMessage(msg.chat.id, deepPP, { parse_mode: 'Markdown' });
        await sleep(400);
        // v6.0 Institutional analysis on track
        const instOut = await runInstitutionalLayer(symbol, c15track, c1htrack, c4htrack, obtrack, {});
        if (instOut) {
            await cmdBot.sendMessage(msg.chat.id, formatInstitutionalSummary(instOut.verdict, symbol), { parse_mode: 'Markdown' });
        }
    } catch (e) { console.error('[Track first]', e.message); }
});

cmdBot.onText(/\/untrack (.+)/, async (msg, match) => {
    const symbol = match[1].trim().toUpperCase();
    const sym    = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
    if (TRACKED[sym]) { untrackPosition(sym); await cmdBot.sendMessage(msg.chat.id, `✅ Stopped tracking ${sym}`); }
    else               { await cmdBot.sendMessage(msg.chat.id, `❌ ${sym} not in tracked list`); }
});

cmdBot.onText(/\/tracked/, async (msg) => {
    const symbols = Object.keys(TRACKED);
    if (!symbols.length) {
        await cmdBot.sendMessage(msg.chat.id, 'No tracked positions.\nUse /track SYMBOL PRICE to start.');
        return;
    }
    const lines = await Promise.all(symbols.map(async sym => {
        const pos   = TRACKED[sym];
        const price = await getPrice(sym).catch(()=>null);
        const pnl   = price ? ((price - pos.entry) / pos.entry * 100).toFixed(1) : '?';
        const age   = Math.round((Date.now() - pos.openTime) / 60000);
        return ` • \`${sym}\` | Entry: ${fmt(pos.entry)} | Now: ${price ? fmt(price) : '?'} | ${pnl >= 0 ? '+' : ''}${pnl}% | ${age}m`;
    }));
    await cmdBot.sendMessage(msg.chat.id,
        `*Tracked Positions (${symbols.length}):*\n${lines.join('\n')}\n\nUse /track SYM PRICE to add`,
        { parse_mode: 'Markdown' });
});

function formatDeepPrePumpAnalysis(sym, c15, ob, label = 'PRE-PUMP ANALYSIS') {
    if (!c15) return `No candle data for ${sym}`;
    const { closes, highs, lows, volumes, opens } = c15;
    const n = closes.length;
    const volZ   = volumeZScore(volumes);
    const spring = detectWyckoffSpring(closes, highs, lows, volumes);
    const vpin   = calcVPIN(closes, volumes);
    const hurst  = calcHurst(closes.slice(-60));
    const tsmom  = calcTSMOM(closes);
    const parab  = detectParabolicMove(closes, highs, lows);
    const lf     = analyzeLiquidityFlow(closes, highs, lows, volumes);
    const obR    = analyzeOrderBook(ob);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr    = atrArr[atrArr.length - 1] ?? 0;
    const price  = closes[n - 1];
    const atrPct = ((atr / price) * 100).toFixed(2);
    const rsi    = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
    const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0)  / 5;
    const volMult  = avgVol20 > 0 ? (avgVol5 / avgVol20).toFixed(1) : '1.0';
    const bidUSDT  = ob?.bids ? ob.bids.reduce((s,b)=>s+b.price*b.qty,0) : 0;
    const askUSDT  = ob?.asks ? ob.asks.reduce((s,a)=>s+a.price*a.qty,0) : 0;
    const obRatio  = askUSDT > 0 ? (bidUSDT / askUSDT).toFixed(2) : 'N/A';
    const flowRatio = parseFloat(lf.flowRatio ?? '1');

    let ppScore = 0;
    const ppLines = [];

    const volStatus = volZ.highAnomaly ? `HIGH ANOMALY z=${volZ.z} (${volZ.ratio}x)` : volZ.medAnomaly ? `MODERATE z=${volZ.z} (${volZ.ratio}x)` : `Normal z=${volZ.z} (${volZ.ratio}x)`;
    if (volZ.highAnomaly) ppScore += 4; else if (volZ.medAnomaly) ppScore += 2;
    ppLines.push(`Vol Z-Score: ${volStatus}`);

    if (volZ.stealth) ppScore += 3;
    ppLines.push(`Stealth Accum: ${volZ.stealth ? 'ACTIVE — 3d avg > 1.5x 14d avg (+3)' : 'Not detected'}`);

    if (tsmom.bullish) ppScore += 2;
    ppLines.push(`TSMOM: ${tsmom.bullish ? `BULLISH ${tsmom.signal} (+2)` : `${tsmom.signal} neutral`}`);

    if (hurst.hurst > 0.75) ppScore += 2; else if (hurst.regime === 'TRENDING') ppScore += 1;
    ppLines.push(`Hurst: ${hurst.hurst > 0.75 ? `STRONG TRENDING H=${hurst.hurst} (+2)` : `H=${hurst.hurst} [${hurst.regime}]`}`);

    ppLines.push(`ATR: ${parseFloat(atrPct) < 0.8 ? `LOW ${atrPct}% — coiling` : parseFloat(atrPct) < 2.0 ? `MEDIUM ${atrPct}% — normal` : `HIGH ${atrPct}% — moving fast`}`);

    if (flowRatio > 2.5) ppScore += 3; else if (flowRatio > 1.5) ppScore += 1;
    ppLines.push(`Flow: ${flowRatio > 2.5 ? `SURGING ${flowRatio}x (+3)` : flowRatio > 1.5 ? `RISING ${flowRatio}x (+1)` : flowRatio < 0.8 ? `LEAVING ${flowRatio}x` : `Stable ${flowRatio}x`}`);

    if (parseFloat(obRatio) >= 2.0) ppScore += 2; else if (parseFloat(obRatio) >= 1.2) ppScore += 1;
    ppLines.push(`OB Depth: ${parseFloat(obRatio) >= 2.0 ? `STRONG $${(bidUSDT/1000).toFixed(1)}K vs $${(askUSDT/1000).toFixed(1)}K (+2)` : `Ratio ${obRatio}x`}`);

    if (spring.spring) { ppScore += 4; ppLines.push(`Wyckoff Spring: CONFIRMED ${spring.score}/100 (+4)`); }
    else { ppLines.push(`Wyckoff Spring: Not detected`); }

    if (vpin.extreme) ppScore -= 3;
    ppLines.push(`VPIN: ${vpin.extreme ? `EXTREME ${vpin.vpin} — toxic (-3)` : vpin.toxic ? `TOXIC ${vpin.vpin}` : `Clean ${vpin.vpin}`}`);

    if (parab.phase !== 'NORMAL') ppLines.push(`Parabolic: ${parab.phase} (ATR ${parab.atrExp}x)`);
    ppLines.push(`RSI: ${rsi.toFixed(1)} | Vol: ${volMult}x avg | MFI: ${lf.mfi}`);

    const vi = classifyVolumeIntent(closes, highs, lows, volumes, opens);
    ppLines.push(`Volume Intent: ${vi.emoji} ${vi.intent}`);
    ppLines.push(`   Detail: ${vi.detail}`);
    if (vi.cvdNote) ppLines.push(`📊 CVD Signal: ${vi.cvdNote}`);
    ppLines.push(`   ${vi.explanation}`);
    ppLines.push(`   Volume ${vi.volTrendEmoji} ${vi.volTrend} vs avg | Action: ${vi.actionHint}`);

    const vs = detectVolumeSpring(volumes);
    if (vs.springReady) { ppScore += 5; ppLines.push(`Volume Spring: READY 🌱 — dry-up ${vs.dryUpRatio}x then explosion ${vs.explosionRatio}x (+5)`); }
    else if (vs.dryUp)  { ppScore += 2; ppLines.push(`Volume Spring: Coiling ⏳ — volume dry-up ${vs.dryUpRatio}x (+2)`); }
    else { ppLines.push(`Volume Spring: Not detected (dry-up: ${vs.dryUpRatio}x, explosion: ${vs.explosionRatio}x)`); }

    const sma = detectSmartMoneyAbsorption(closes, highs, lows, volumes, ob);
    if (sma.absorbing)              { ppScore += 4; ppLines.push(`Smart Money: ABSORBING 🧲 — ${sma.absorptionNote} (+4)`); }
    else if (sma.absorptionScore >= 35) { ppScore += 2; ppLines.push(`Smart Money: Partial absorption (${sma.absorptionScore}/100) — ${sma.absorptionNote} (+2)`); }
    else { ppLines.push(`Smart Money: No absorption detected (${sma.absorptionScore}/100)`); }

    ppScore = Math.max(0, Math.min(20, ppScore));
    const verdict = ppScore >= 14 ? '🔥 STRONG PRE-PUMP CONDITIONS'
        : ppScore >= 9  ? '📊 MODERATE — accumulation likely'
        : ppScore >= 5  ? '📡 EARLY — watch for confirmation'
        : '⚪ WEAK — no strong pre-pump signals';

    const personality = classifyExpansionPersonality(parseFloat(atrPct), hurst, obR, lf, null, parab);
    const triggerDist = calcTriggerDistance(price, highs);
    const timeline    = estimateSignalTimeline(parseFloat(atrPct), triggerDist, { expansionTypeKey: 'CONTROLLED' }, null, lf, volMult);

    return (
`📊 *${label}: ${sym}*
${verdict} (${ppScore}/20)
━━━━━━━━━━━━━━━━━━
${ppLines.map(l => ` · ${l}`).join('\n')}
━━━━━━━━━━━━━━━━━━
${timeline.speedEmoji} *Timeline: ${timeline.timeLabel}* — ${timeline.speedLabel}
 · Trigger in ${triggerDist.label}
 · Personality: ${personality.personality} — ${personality.note}
━━━━━━━━━━━━━━━━━━
*Entry Plan:*
 · Wait for confirm above: \`${fmt(price * 1.025)}\` (+2.5%)
 · Stop: \`${fmt(price * (1-0.025))}\` (-2.5%)
 · TP1: \`${fmt(price * 1.10)}\` (+10%) | TP2: \`${fmt(price * 1.25)}\` (+25%)
_Pre-Pump Deep Analysis | ${new Date().toUTCString()}_`
    );
}

cmdBot.onText(/\/analyze (.+)/, async (msg, match) => {
    const symbol = match[1].trim().toUpperCase();
    const sym    = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
    await cmdBot.sendMessage(msg.chat.id, `🔍 Analyzing ${sym}...`);
    try {
        const [c15, c1h, c4h, ob, ticker] = await Promise.all([
            getCandles(sym, '15m', 120),
            getCandles(sym, '1h',  60),
            get4hCandles(sym),
            getOrderBook(sym),
            (async () => { const r = await safeGet(`/api/v3/ticker/24hr?symbol=${sym}`); return r?.data ?? null; })(),
        ]);
        const btcMom = await getBTCMomentum();
        const mktCtx = await marketContextScore(btcMom);
        const result = analyzeToken(sym, c15, c1h, ticker, ob, btcMom);
        if (result) {
            result.instGrade = calcInstitutionalGrade(result.score, result.expansion, result.lateRisk, result.trigger, mktCtx, result.whale);
            result.mktCtx    = mktCtx;
            // v6.0 Institutional layer
            const instLayer  = await runInstitutionalLayer(sym, c15, c1h, c4h, ob, result);
            result._instLayer = instLayer;
            await cmdBot.sendMessage(msg.chat.id, formatMessage(result), { parse_mode: 'Markdown' });
            await sleep(400);
            const mtf      = detectMultiTimeframeMomentum(c15, c1h);
            const deepPP   = formatDeepPrePumpAnalysis(sym, c15, ob, 'DEEP PRE-PUMP SCAN');
            const mtfLine  = `\n📊 *MTF Alignment: ${mtf.aligned ? '✅ CONFIRMED' : '⚠️ WEAK'}* (${mtf.alignScore}/100) — ${mtf.alignNote}`;
            await cmdBot.sendMessage(msg.chat.id, deepPP + mtfLine, { parse_mode: 'Markdown' });
        } else {
            const mtf    = detectMultiTimeframeMomentum(c15, c1h);
            const deepPP = formatDeepPrePumpAnalysis(sym, c15, ob, 'PRE-PUMP ANALYSIS');
            const mtfLine = `\n📊 *MTF Alignment: ${mtf.aligned ? '✅ CONFIRMED' : '⚠️ WEAK'}* (${mtf.alignScore}/100) — ${mtf.alignNote}`;
            await cmdBot.sendMessage(msg.chat.id, deepPP + mtfLine, { parse_mode: 'Markdown' });
            // Send institutional layer even without main signal
            const instLayer = await runInstitutionalLayer(sym, c15, c1h, c4h, ob, {});
            if (instLayer) await cmdBot.sendMessage(msg.chat.id, formatInstitutionalSummary(instLayer.verdict, sym), { parse_mode: 'Markdown' });
        }
    } catch (e) {
        await cmdBot.sendMessage(msg.chat.id, `❌ Error analyzing ${sym}: ${e.message}`);
        console.error('[/analyze]', e.message);
    }
});

cmdBot.onText(/\/forecast (.+)/, async (msg, match) => {
    let symbol = match[1].trim().toUpperCase();
    if (!symbol.endsWith('USDT')) symbol += 'USDT';
    await cmdBot.sendMessage(msg.chat.id, `📊 Analyzing ${symbol}...`);
    try {
        const [c15, c1h] = await Promise.all([
            getCandles(symbol, '15m', 80),
            getCandles(symbol, '1h',  40),
        ]);
        if (!c15) { await cmdBot.sendMessage(msg.chat.id, `❌ Could not fetch data for ${symbol}`); return; }
        const { closes, highs, lows, volumes } = c15;
        const n      = closes.length;
        const price  = closes[n-1];
        const rsi    = RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
        const atr    = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).slice(-1)[0];
        const parab  = detectParabolicMove(closes, highs, lows);
        const volZ   = volumeZScore(volumes);
        const spring = detectWyckoffSpring(closes, highs, lows, volumes);
        const tsmom  = calcTSMOM(closes);
        const hurst  = calcHurst(closes.slice(-60));
        const vpin   = calcVPIN(closes, volumes);
        const vAvg   = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
        const vNow   = volumes[n-1];
        const cRange = highs[n-1] - lows[n-1];
        const uWick  = highs[n-1] - Math.max(closes[n-1], closes[n-2] ?? closes[n-1]);
        const wRatio = cRange > 0 ? uWick/cRange : 0;
        const climax = vNow > vAvg*5 && rsi > 80 && wRatio > 0.5;
        const vRatioNow = vAvg > 0 ? vNow/vAvg : 1;
        const rsi1h  = c1h ? RSI.calculate({ values: c1h.closes, period: 14 }).slice(-1)[0] : null;
        let trend1h  = 'Neutral';
        if (c1h) {
            const e7_1h  = EMA.calculate({ values: c1h.closes, period: 7  }).slice(-1)[0];
            const e25_1h = EMA.calculate({ values: c1h.closes, period: 25 }).slice(-1)[0];
            if (e7_1h > e25_1h) trend1h = '✅ Bullish'; else if (e7_1h < e25_1h) trend1h = '❌ Bearish';
        }
        let forecastText = ''; let action = 'HOLD';
        if (climax)                            { forecastText = `🔴 *Volume Climax!*\nVol ${vRatioNow.toFixed(1)}x + RSI ${rsi.toFixed(0)} — consider partial exit`; action = 'EXIT_PARTIAL'; }
        else if (parab.phase === 'BLOWOFF')    { forecastText = `🔴 *Blowoff Phase!*\nATR ${parab.atrExp}x — overextended`; action = 'EXIT_PARTIAL'; }
        else if (parab.phase === 'PARABOLIC')  { forecastText = `🚀 *Parabolic Phase Active!*\nATR ${parab.atrExp}x — momentum strong`; action = 'HOLD_STRONG'; }
        else if (parab.phase === 'EXPANDING' && vRatioNow > 1.2) { forecastText = `📈 *Momentum Expanding*\nVol ${vRatioNow.toFixed(1)}x avg`; action = 'HOLD'; }
        else if (spring.spring)               { forecastText = `🌱 *Wyckoff Spring ${spring.score}/100*\nAccumulation signal`; action = 'BUY_WATCH'; }
        else if (volZ.highAnomaly)            { forecastText = `⚡ *Volume Anomaly! Z=${volZ.z} (${volZ.ratio}x)*\nUnusual volume surge`; action = 'WATCH'; }
        else if (rsi > 72)                    { forecastText = `⚠️ *RSI Overbought (${rsi.toFixed(0)})*\nPullback possible`; action = 'CAUTION'; }
        else if (tsmom.bearish || hurst.regime === 'MEAN_REV') { forecastText = `⚠️ *Weak Momentum*\nTSMOM: ${tsmom.signal} | Hurst: ${hurst.hurst}`; action = 'WAIT'; }
        else                                  { forecastText = `⚪ *No critical signals*\nRSI: ${rsi.toFixed(0)} | Vol: ${vRatioNow.toFixed(1)}x`; action = 'HOLD'; }
        const actionEmoji = { EXIT_PARTIAL: '🚨', HOLD_STRONG: '🚀', BUY_WATCH: '🌱', CAUTION: '⚠️', WATCH: '👀', WAIT: '⏳', HOLD: '✅' }[action] ?? '✅';
        await cmdBot.sendMessage(msg.chat.id,
`📊 *Forecast: ${symbol}*
Current Price: \`${fmt(price)}\`
━━━━━━━━━━━━━━━━━━
${actionEmoji} *${action}*
${forecastText}
━━━━━━━━━━━━━━━━━━
*Indicators:*
 · RSI 15m: ${rsi.toFixed(1)} | RSI 1h: ${rsi1h ? rsi1h.toFixed(1) : 'N/A'}
 · Trend 1h: ${trend1h}
 · Parabolic: ${parab.phase} (ATR exp: ${parab.atrExp}x)
 · TSMOM: ${tsmom.signal} (${tsmom.bullish ? '✅ Bullish' : tsmom.bearish ? '❌ Bearish' : '⚪ Neutral'})
 · Hurst: ${hurst.hurst} [${hurst.regime}]
 · VPIN: ${vpin.vpin}${vpin.toxic ? ' ☣️ Toxic' : ''}
 · Vol: ${vRatioNow.toFixed(1)}x avg
 · Spring: ${spring.spring ? `🌱 ${spring.score}/100` : '❌ None'}
 · ATR: ${fmt(atr)} (${((atr/price)*100).toFixed(2)}%)
 · Climax Risk: ${climax ? '🔴 HIGH' : '🟢 Low'}

_v6.0 Forecast • ${new Date().toUTCString()}_`, { parse_mode: 'Markdown' });
    } catch (e) {
        await cmdBot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
        console.error('[Forecast]', e.message);
    }
});

cmdBot.onText(/\/help/, async (msg) => {
    await cmdBot.sendMessage(msg.chat.id,
`*Scanner v6.0 Commands*
/analyze SYMBOL — Full analysis + Institutional layer
/forecast SYMBOL — Quick forecast
/track SYMBOL PRICE — Track a coin after entry
/untrack SYMBOL — Stop tracking
/tracked — All tracked positions

*Tracker auto-updates:*
 • Every 15 min (first 3 alerts)
 • Every 30 min after that
 • Immediate on: Trend Stop / −5% from peak / +20/50/100%

*New in v6.0:*
 • Engine Conflict Resolver (DISTRIBUTION vs ABSORBING explained)
 • Hidden Buyer / Hidden Seller Detector
 • Weak-Hand Shakeout Detector
 • MM Trap Detector
 • 4H Timeframe Hierarchy
 • Institutional Final Verdict

*أمثلة:*
/forecast STOUSDT
/analyze FORMUSDT
/track STOUSDT 0.13
/untrack STOUSDT

_v6.0 — Institutional Intelligence Layer_`, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCAN LOOP
// ═══════════════════════════════════════════════════════════════════════════
async function scan() {
    console.log(`\n[${new Date().toISOString()}] Scanner v6.0 scanning...`);

    const exRes = await safeGet('/api/v3/ticker/24hr');
    if (!exRes) { console.error('[Binance] All hosts failed'); return; }

    const btcMom  = await getBTCMomentum();
    const mktCtx  = await marketContextScore(btcMom);
    const tickers = Object.fromEntries(exRes.data.map(t => [t.symbol, t]));

    let spotSymbols = null;
    try {
        const infoRes = await safeGet('/api/v3/exchangeInfo');
        if (infoRes?.data?.symbols)
            spotSymbols = new Set(infoRes.data.symbols.filter(s=>s.status==='TRADING'&&s.quoteAsset==='USDT').map(s=>s.symbol));
    } catch {}

    const pairs = exRes.data
        .filter(t => t.symbol.endsWith('USDT') && passesGate(t) && (!spotSymbols || spotSymbols.has(t.symbol)))
        .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, CONFIG.TOP_PAIRS);

    console.log(` Pairs: ${pairs.length} | BTC bullish: ${btcMom?.bullish}`);

    const results  = [];
    const prePumps = [];

    for (let i = 0; i < pairs.length; i += CONFIG.BATCH_SIZE) {
        const batch = pairs.slice(i, i + CONFIG.BATCH_SIZE);
        const batchRes = await Promise.all(batch.map(async pair => {
            try {
                const [c15, c1h] = await Promise.all([
                    getCandles(pair.symbol, CONFIG.INTERVAL_PRIMARY),
                    getCandles(pair.symbol, CONFIG.INTERVAL_CONFIRM),
                ]);
                if (!c15 || !c1h) return { main: null, pp: null };
                const { volumes, closes } = c15;
                const n      = closes.length;
                const avgVol = volumes.slice(-20,-1).reduce((a,b)=>a+b,0) / 19;
                const vr     = volumes[n-1] / avgVol;
                const earlyOk = passesEarlyGate(pair, c15) || detectSuddenVolumeIgnition(pair, c15);
                if (vr < 0.65 && !earlyOk) return { main: null, pp: null };
                const ob   = await getOrderBook(pair.symbol).catch(()=>null);
                // v6.0: fetch 4h candles for institutional layer
                const c4h  = await get4hCandles(pair.symbol).catch(()=>null);
                const main = analyzeToken(pair.symbol, c15, c1h, tickers[pair.symbol], ob, btcMom);
                const pp   = checkPrePumpConditions(pair.symbol, c15, ob);
                // Attach institutional layer to main signal
                if (main) {
                    try {
                        const instLayer  = await runInstitutionalLayer(pair.symbol, c15, c1h, c4h, ob, main);
                        main._instLayer  = instLayer;
                    } catch {}
                }
                return { main, pp };
            } catch (e) { console.error(` ✗ ${pair.symbol}: ${e.message}`); return { main: null, pp: null }; }
        }));
        for (const { main, pp } of batchRes) {
            if (main) results.push(main);
            if (pp)   prePumps.push(pp);
        }
        process.stdout.write(` Scanned ${Math.min(i+CONFIG.BATCH_SIZE, pairs.length)}/${pairs.length}\r`);
        await sleep(CONFIG.BATCH_DELAY_MS);
    }
    console.log(`\n Results: ${results.length} | Pre-Pumps: ${prePumps.length}`);

    const now = Date.now();

    // Update alerts for tracked coins
    for (const r of results) {
        const prev = updateCache.get(r.symbol);
        if (!prev) continue;
        const lastUpdate = prev._updateTime ?? 0;
        if (now - lastUpdate < CONFIG.UPDATE_COOLDOWN) continue;
        const tc = r.trendConf ?? {};
        const pm = prev.momentum?.momScore ?? 0;
        const cm = r.momentum?.momScore ?? 0;
        if (tc.trendStatus === 'Trend Stop' && prev.trendConf?.trendStatus !== 'Trend Stop') {
            await sendTelegram(`🔴 *UPDATE* — *${r.symbol}*\nTrend Stop — Structure broken — Exit signal`);
            r._updateTime = now; updateCache.set(r.symbol, r);
        } else if (tc.trendStatus === 'Weakening' && cm < pm - 2) {
            try {
                const c4hWeak   = await getCandles(r.symbol, '4h', 30);
                const htf4hBull = c4hWeak ? (() => {
                    const e7w  = EMA.calculate({ values: c4hWeak.closes, period: 7  }).slice(-1)[0];
                    const e25w = EMA.calculate({ values: c4hWeak.closes, period: 25 }).slice(-1)[0];
                    const e99w = EMA.calculate({ values: c4hWeak.closes, period: Math.min(99, c4hWeak.closes.length-1) }).slice(-1)[0];
                    return e7w > e25w && c4hWeak.closes[c4hWeak.closes.length-1] > e99w;
                })() : false;
                if (htf4hBull) {
                    await sendTelegram(
`🟡 *UPDATE* — *${r.symbol}*
⚠️ Weakness 15m/1h
✅ 4H structure BULLISH — likely a dip, not reversal
Tighten stop but do not exit yet`);
                } else {
                    await sendTelegram(
`🔴 *UPDATE* — *${r.symbol}*
Momentum weakening on all timeframes
Tighten stop or reduce position size`);
                }
            } catch {
                await sendTelegram(`⚠️ *UPDATE* — *${r.symbol}*\nMomentum weakening — Tighten stop`);
            }
            r._updateTime = now; updateCache.set(r.symbol, r);
        } else if (tc.trendStatus === 'Continuation Strong' && prev.trendConf?.trendStatus !== 'Continuation Strong') {
            await sendTelegram(`✅ *UPDATE* — *${r.symbol}*\nTrend still active and strong`);
            r._updateTime = now; updateCache.set(r.symbol, r);
        }
    }

    // Send top main signals
    const afterCooldown = results.filter(r => {
        const last = alertCache.get(r.symbol);
        return !last || (now - last) > CONFIG.ALERT_COOLDOWN;
    });
    const top = afterCooldown.sort((a,b) => b.rank - a.rank).slice(0, CONFIG.MAX_RESULTS);
    for (const r of top) {
        const premiumEarly = r.score >= 15 && (r.momentum?.contProb ?? 0) >= 46 && parseFloat(r.lf?.flowRatio ?? 0) > 1.2;
        if (!premiumEarly && r.score < 18) continue;
        r.instGrade = calcInstitutionalGrade(r.score, r.expansion, r.lateRisk, r.trigger, mktCtx, r.whale);
        r.mktCtx    = mktCtx;
        try {
            r.weeklyBreakout  = await checkWeeklyBreakout(r.symbol, r.entry);
            r.sectorMom       = getSectorMomentum(r.symbol, { priceChangePercent: r.change24h }, tickers);
            r.adjustedTargets = {
                tp1 : r.entry * (1 + CONFIG.MIN_TP1_PCT  * r.adjustedTargets.targetMultiplier),
                tp2 : r.entry * (1 + CONFIG.MIN_TP2_PCT  * r.adjustedTargets.targetMultiplier),
                moon: r.entry * (1 + CONFIG.MIN_MOON_PCT * r.adjustedTargets.targetMultiplier),
                targetMultiplier: calcTargetMultiplier(r.narrative, r.tokenAge, r.volToMCap, r.weeklyBreakout),
            };
        } catch {}
        alertCache.set(r.symbol, now);
        updateCache.set(r.symbol, { ...r, _updateTime: now });
        await sendTelegram(formatMessage(r, false));
        forwardSignal(r);
        await sleep(500);
    }

    // Send PRE-PUMP alerts
    const prePumpFiltered = prePumps
        .filter(pp => { const last = alertCache.get('PP_' + pp.symbol); return !last || (now - last) > CONFIG.ALERT_COOLDOWN * 2; })
        .sort((a,b) => b.prePumpScore - a.prePumpScore)
        .slice(0, 3);
    for (const pp of prePumpFiltered) {
        if (alertCache.get(pp.symbol) === now) continue;
        alertCache.set('PP_' + pp.symbol, now);
        await sendTelegram(formatPrePumpAlert(pp));
        forwardSignal(pp);
        await sleep(500);
    }

    await reviewTrackedPositions();
}

// ═══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
//  INSTITUTIONAL INTELLIGENCE ENGINE v2.0
//  (Integrated from addon — all functions below are new in v6.0)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

// STEP 1 — FETCH 4H CANDLES
async function get4hCandles(symbol, limit = 60) {
    const res = await safeGet(`/api/v3/klines?symbol=${symbol}&interval=4h&limit=${limit}`);
    if (!res) return null;
    try {
        return {
            opens:   res.data.map(c => parseFloat(c[1])),
            highs:   res.data.map(c => parseFloat(c[2])),
            lows:    res.data.map(c => parseFloat(c[3])),
            closes:  res.data.map(c => parseFloat(c[4])),
            volumes: res.data.map(c => parseFloat(c[5])),
        };
    } catch { return null; }
}

// STEP 2 — TIMEFRAME HIERARCHY ENGINE
function analyzeTimeframeHierarchy(c15, c1h, c4h) {
    const fallback = { trend: 'UNKNOWN', rsi: 50, ema: 'UNKNOWN', structure: 'UNKNOWN', volumeLabel: 'UNKNOWN', meaning: 'No data', price: 0 };
    function assessFrame(c, label) {
        if (!c || c.closes.length < 20) return fallback;
        const closes = c.closes; const highs = c.highs; const lows = c.lows;
        const n      = closes.length;
        const rsiArr = RSI.calculate({ values: closes, period: 14 });
        const rsi    = rsiArr.length ? +rsiArr[rsiArr.length - 1].toFixed(1) : 50;
        const e7     = EMA.calculate({ values: closes, period: 7  }).slice(-1)[0];
        const e25    = EMA.calculate({ values: closes, period: 25 }).slice(-1)[0];
        const e99    = EMA.calculate({ values: closes, period: Math.min(99, n - 1) }).slice(-1)[0];
        const price  = closes[n - 1];
        let trend;
        if (e7 > e25 && price > e25 && rsi > 48)      trend = 'BULLISH';
        else if (e7 < e25 && price < e25 && rsi < 52) trend = 'BEARISH';
        else                                            trend = 'SIDEWAYS';
        let ema;
        if (e7 > e25 && e25 > e99)      ema = 'BULLISH_ALIGNED';
        else if (e7 < e25 && e25 < e99) ema = 'BEARISH_ALIGNED';
        else                             ema = 'MIXED';
        const recentHighs = highs.slice(-10);
        const recentLows  = lows.slice(-10);
        const higherHighs = recentHighs[recentHighs.length - 1] > recentHighs[0];
        const higherLows  = recentLows[recentLows.length - 1]   > recentLows[0];
        const lowerHighs  = recentHighs[recentHighs.length - 1] < recentHighs[0];
        const lowerLows   = recentLows[recentLows.length - 1]   < recentLows[0];
        let structure;
        if (higherHighs && higherLows)    structure = 'HHHL';
        else if (lowerHighs && lowerLows) structure = 'LHLL';
        else                              structure = 'MIXED';
        const avgVol5  = c.volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const avgVol20 = c.volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const volBias  = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
        const volumeLabel = volBias > 1.5 ? 'SURGING' : volBias > 1.1 ? 'RISING' : volBias < 0.7 ? 'DECLINING' : 'STABLE';
        let meaning;
        if (trend === 'BULLISH' && structure === 'HHHL')   meaning = `${label} bullish — higher highs intact`;
        else if (trend === 'BEARISH' && structure === 'LHLL') meaning = `${label} bearish — lower lows forming`;
        else if (trend === 'BULLISH' && rsi < 45)          meaning = `${label} bullish structure — short pullback only`;
        else if (trend === 'SIDEWAYS')                     meaning = `${label} consolidating — no clear direction`;
        else                                               meaning = `${label} ${trend.toLowerCase()} — ${structure}`;
        return { trend, rsi, ema, structure, volumeLabel, meaning, price, e7, e25, e99 };
    }
    const short  = assessFrame(c15, '15m');
    const medium = assessFrame(c1h, '1h');
    const long   = assessFrame(c4h, '4h');
    let alignScore = 0;
    if (short.trend  === 'BULLISH') alignScore += 20;
    if (medium.trend === 'BULLISH') alignScore += 35;
    if (long.trend   === 'BULLISH') alignScore += 45;
    let conflictType, finalMeaning, confidenceImpact;
    const shortBull = short.trend  === 'BULLISH';
    const medBull   = medium.trend === 'BULLISH';
    const longBull  = long.trend   === 'BULLISH';
    const shortBear = short.trend  === 'BEARISH';
    const medBear   = medium.trend === 'BEARISH';
    const longBear  = long.trend   === 'BEARISH';
    if (shortBull && medBull && longBull)        { conflictType = 'FULL_ALIGNMENT';  finalMeaning = 'Full timeframe alignment — strongest continuation condition'; confidenceImpact = +10; }
    else if (shortBear && medBear && longBear)   { conflictType = 'FULL_BEARISH';    finalMeaning = 'Full bearish alignment — avoid long entries'; confidenceImpact = -15; }
    else if (shortBear && medBull && longBull)   { conflictType = 'LOCAL_PULLBACK';  finalMeaning = 'Short-term selling only — likely local shake inside bullish trend'; confidenceImpact = 0; }
    else if (shortBear && medBear && longBull)   { conflictType = 'MEDIUM_PULLBACK'; finalMeaning = 'Medium pullback inside long-term bullish structure — wait for 1h recovery'; confidenceImpact = -5; }
    else if (shortBull && medBear && longBear)   { conflictType = 'SHORT_BOUNCE';    finalMeaning = 'Short bounce only — higher timeframes still weak — do not chase'; confidenceImpact = -10; }
    else if (shortBull && medBull && longBear)   { conflictType = 'TREND_CONFLICT';  finalMeaning = '15m+1h bullish but 4h bearish — medium-term move only, not a swing'; confidenceImpact = -5; }
    else if (shortBull && !medBull && longBull)  { conflictType = 'LOCAL_PUSH';      finalMeaning = 'Short-term push inside long-term bullish — watch if 1h confirms'; confidenceImpact = 0; }
    else                                         { conflictType = 'MIXED';           finalMeaning = 'Mixed signals across timeframes — reduce size and wait for clarity'; confidenceImpact = -5; }
    if (longBear && !shortBear) confidenceImpact = Math.min(confidenceImpact, -5);
    return { shortTerm: short, mediumTerm: medium, longTerm: long, alignment: alignScore, conflictType, finalMeaning, confidenceImpact };
}

// STEP 3 — ENGINE CONFLICT RESOLVER
function resolveEngineConflicts(volIntent, smAbsorb, obR, hurst, volZ, tsmom) {
    const conflicts      = [];
    const resolutions    = [];
    let conflictSeverity = 'NONE';
    const vi       = volIntent?.intent    ?? 'UNKNOWN';
    const absorb   = smAbsorb?.absorbing  ?? false;
    const absScore = smAbsorb?.absorptionScore ?? 0;
    const obImb    = parseFloat(obR?.imbalance ?? 0.5);
    const obBid    = obR?.buyWall  ?? false;
    const obSell   = obR?.sellWall ?? false;
    const h        = hurst?.hurst  ?? 0.5;
    const tsBeR    = tsmom?.bearish ?? false;
    const retailSelling  = vi === 'DISTRIBUTION' || vi === 'STRONG DISTRIBUTION';
    const whaleAbsorbing = absorb || absScore >= 40;

    if (retailSelling && whaleAbsorbing) {
        conflicts.push('Volume Intent = DISTRIBUTION but Smart Money = ABSORBING');
        resolutions.push(
            'Retail selling (CVD falling) + Whale absorbing (OB bid wall holding) = ' +
            'Classic pre-pump accumulation pattern. NOT a contradiction. ' +
            'Retail exits, smart money accumulates quietly. ' +
            'Key check: if bid wall holds → bullish continuation. If bid disappears → exit immediately.'
        );
        conflictSeverity = 'LOW';
    }
    if ((vi === 'STRONG BUYING' || vi === 'BUYING') && obSell && !obBid) {
        conflicts.push('Volume shows buying pressure but sell wall is blocking above price');
        resolutions.push(
            'Buy pressure present but heavy ask wall absorbing every push. ' +
            'Entry premature — wait for wall to be consumed before acting. ' +
            'Volume must exceed wall size for breakout to hold.'
        );
        if (conflictSeverity === 'NONE') conflictSeverity = 'MEDIUM';
    }
    if (h > 0.65 && tsBeR) {
        conflicts.push('Hurst shows strong trending structure but TSMOM momentum is bearish');
        resolutions.push(
            'Long-term structure intact (Hurst) but short-term momentum fading (TSMOM). ' +
            'Possible temporary pullback inside a trend — not a reversal signal. ' +
            'Confirm with 1h EMA structure before entry.'
        );
        if (conflictSeverity === 'NONE') conflictSeverity = 'LOW';
    }
    if (volZ?.highAnomaly && obSell && obImb < 0.45) {
        conflicts.push('Volume spike detected but order book dominated by sellers');
        resolutions.push(
            'High volume anomaly with seller-dominated book. ' +
            'Volume spike may be distribution (selling into liquidity), not accumulation. ' +
            'Check CVD direction: rising CVD = real buying. Falling CVD = selling.'
        );
        if (conflictSeverity !== 'HIGH') conflictSeverity = 'MEDIUM';
    }
    if (absorb && (vi === 'DISTRIBUTION' || vi === 'STRONG DISTRIBUTION')) {
        conflicts.push('OB depth shows absorption AND CVD shows distribution simultaneously');
        resolutions.push(
            'Most dangerous conflict: OB bids look strong but actual traded flow is selling. ' +
            'Bid walls may be spoofed (placed to create illusion, will vanish on test). ' +
            'Do not enter until price holds a full green candle ABOVE current level.'
        );
        conflictSeverity = 'HIGH';
    }
    let signalClarity;
    if (conflicts.length === 0)             signalClarity = 'CLEAN';
    else if (conflictSeverity === 'LOW')    signalClarity = 'EXPLAINABLE';
    else if (conflictSeverity === 'MEDIUM') signalClarity = 'CONFLICTED';
    else                                    signalClarity = 'DANGEROUS';
    return { conflicts, resolutions, conflictSeverity, signalClarity, hasConflict: conflicts.length > 0 };
}

// STEP 4 — HIDDEN BUYER / HIDDEN SELLER DETECTOR
function detectHiddenFlow(closes, highs, lows, volumes, opens) {
    const n    = closes.length;
    if (n < 8) return { type: 'UNKNOWN', confidence: 0, detail: 'Insufficient data', reasons: [] };
    const opns = opens ?? closes.map((c, i) => i > 0 ? closes[i - 1] : c);
    let hiddenBuyScore  = 0;
    let hiddenSellScore = 0;
    const buyReasons    = [];
    const sellReasons   = [];
    let lowerWickCount  = 0, upperWickCount = 0, sellCandleCount = 0, buyCandleCount = 0;
    const recentLow5   = Math.min(...lows.slice(-5));
    const recentLow10  = Math.min(...lows.slice(-10, -5));
    const priceHoldingLow  = recentLow5 >= recentLow10 * 0.998;
    const recentHigh5  = Math.max(...highs.slice(-5));
    const recentHigh10 = Math.max(...highs.slice(-10, -5));
    const priceHoldingHigh = recentHigh5 <= recentHigh10 * 1.002;
    for (let i = n - 5; i < n; i++) {
        const o      = opns[i];
        const body   = closes[i] - o;
        const range  = highs[i] - lows[i];
        const lWick  = Math.min(closes[i], o) - lows[i];
        const uWick  = highs[i] - Math.max(closes[i], o);
        const lWickR = range > 0 ? lWick / range : 0;
        const uWickR = range > 0 ? uWick / range : 0;
        if (body < 0) sellCandleCount++;
        if (body > 0) buyCandleCount++;
        if (lWickR > 0.35) lowerWickCount++;
        if (uWickR > 0.35) upperWickCount++;
    }
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volAbove = avgVol20 > 0 && avgVol5 > avgVol20;
    const bodies = [];
    for (let i = n - 5; i < n; i++) bodies.push(Math.abs(closes[i] - opns[i]));
    const bodiesShrinkingSell = bodies[4] < bodies[0] && bodies[4] < bodies[1] && sellCandleCount >= 2;
    const bodiesShrinkingBuy  = bodies[4] < bodies[0] && buyCandleCount >= 2;
    if (sellCandleCount >= 3 && priceHoldingLow)   { hiddenBuyScore += 25; buyReasons.push(`${sellCandleCount} red candles but price holds low — buyer defending`); }
    if (lowerWickCount >= 2)                        { hiddenBuyScore += 20; buyReasons.push(`${lowerWickCount} lower wicks — buyers stepping in at lows`); }
    if (sellCandleCount >= 3 && volAbove)           { hiddenBuyScore += 20; buyReasons.push('High volume during red candles — sells being absorbed'); }
    const lastClose = closes[n - 1];
    const low3Bars  = Math.min(...lows.slice(-3));
    if (lastClose > low3Bars * 1.005 && lowerWickCount >= 1) { hiddenBuyScore += 15; buyReasons.push('Price recovering from lows — hidden buyer pushing back up'); }
    if (bodiesShrinkingSell) { hiddenBuyScore += 20; buyReasons.push('Sell candle bodies shrinking — selling pressure exhausting'); }
    if (buyCandleCount >= 3 && priceHoldingHigh)   { hiddenSellScore += 25; sellReasons.push(`${buyCandleCount} green candles but price stalls — seller defending highs`); }
    if (upperWickCount >= 2)                        { hiddenSellScore += 20; sellReasons.push(`${upperWickCount} upper wicks — sellers absorbing buys at highs`); }
    if (buyCandleCount >= 3 && volAbove && priceHoldingHigh) { hiddenSellScore += 20; sellReasons.push('High volume on green candles but no breakout — hidden seller present'); }
    const prevHigh    = Math.max(...highs.slice(-8, -3));
    const currentHigh = Math.max(...highs.slice(-3));
    if (currentHigh <= prevHigh * 1.002 && buyCandleCount >= 2) { hiddenSellScore += 15; sellReasons.push('Buy pressure exists but price not making new highs — overhead seller'); }
    if (bodiesShrinkingBuy) { hiddenSellScore += 20; sellReasons.push('Buy candle bodies shrinking — buying pressure exhausting'); }
    hiddenBuyScore  = Math.min(hiddenBuyScore,  100);
    hiddenSellScore = Math.min(hiddenSellScore, 100);
    let type, confidence, detail, reasons;
    if (hiddenBuyScore >= 40 && hiddenBuyScore > hiddenSellScore + 10) {
        type = 'HIDDEN_BUYER'; confidence = hiddenBuyScore; reasons = buyReasons;
        detail = `Hidden buyer (${confidence}/100) — ${buyReasons[0] ?? ''}`;
    } else if (hiddenSellScore >= 40 && hiddenSellScore > hiddenBuyScore + 10) {
        type = 'HIDDEN_SELLER'; confidence = hiddenSellScore; reasons = sellReasons;
        detail = `Hidden seller (${confidence}/100) — ${sellReasons[0] ?? ''}`;
    } else if (hiddenBuyScore >= 25 && hiddenBuyScore > hiddenSellScore) {
        type = 'POSSIBLE_HIDDEN_BUYER'; confidence = hiddenBuyScore; reasons = buyReasons;
        detail = `Possible hidden buyer (${confidence}/100) — watch for confirmation`;
    } else {
        type = 'NEUTRAL'; confidence = 0; reasons = [];
        detail = 'No hidden flow — open market';
    }
    return { type, confidence, detail, reasons, hiddenBuyScore, hiddenSellScore };
}

// STEP 5 — WEAK-HAND SHAKEOUT DETECTOR
function detectWeakHandShakeout(closes, highs, lows, volumes, opens) {
    const n    = closes.length;
    if (n < 8) return { shakeout: false, confidence: 0, detail: 'Insufficient data', reasons: [] };
    const opns = opens ?? closes.map((c, i) => i > 0 ? closes[i - 1] : c);
    let score = 0;
    const reasons = [];
    let redCount = 0;
    for (let i = n - 4; i < n - 1; i++) { if (closes[i] < opns[i]) redCount++; }
    const bullishSetup = closes[n - 5] > closes[n - 8];
    if (redCount >= 1 && redCount <= 3 && bullishSetup) { score += 25; reasons.push(`${redCount} red candles after bullish setup — possible shakeout`); }
    const swingLow    = Math.min(...lows.slice(-6, -2));
    const dippedBelow = Math.min(...lows.slice(-3)) < swingLow * 0.998;
    const reclaimed   = closes[n - 1] > swingLow;
    if (dippedBelow && reclaimed) { score += 30; reasons.push('Price dipped below swing low then reclaimed — stop hunt confirmed'); }
    const avgVol10 = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const dipVol   = volumes.slice(-3, -1).reduce((a, b) => a + b, 0) / 2;
    if (dipVol < avgVol10 * 0.7) { score += 20; reasons.push('Low volume on dip — no real institutional selling'); }
    const dipCandle    = n - 2;
    const dipRange     = highs[dipCandle] - lows[dipCandle];
    const dipLowerWick = Math.min(closes[dipCandle], opns[dipCandle]) - lows[dipCandle];
    const wickRatio    = dipRange > 0 ? dipLowerWick / dipRange : 0;
    if (wickRatio > 0.4) { score += 15; reasons.push('Large lower wick on dip candle — buyers absorbed flush immediately'); }
    const lastGreen = closes[n - 1] > opns[n - 1] && closes[n - 1] > closes[n - 2];
    if (lastGreen && score > 20) { score += 10; reasons.push('Recovery candle forming — flush appears complete'); }
    const shakeout   = score >= 50;
    const confidence = Math.min(score, 100);
    return {
        shakeout, confidence,
        detail: shakeout ? `Weak-hand flush detected (${confidence}/100) — ${reasons[0] ?? ''}` : 'No shakeout pattern',
        reasons,
    };
}

// STEP 6 — MARKET MAKER TRAP DETECTOR
function detectMarketMakerTrap(closes, highs, lows, volumes, opens, ob) {
    const n = closes.length;
    if (n < 6) return { trap: false, confidence: 0, detail: 'Insufficient data', reasons: [] };
    const opns = opens ?? closes.map((c, i) => i > 0 ? closes[i - 1] : c);
    let score = 0;
    const reasons = [];
    const breakoutLevel = Math.max(...highs.slice(-10, -1));
    const brokeAbove    = highs[n - 1] > breakoutLevel;
    const closedBelow   = closes[n - 1] < breakoutLevel;
    if (brokeAbove && closedBelow) { score += 30; reasons.push('Price broke above resistance then closed below — fake breakout pattern'); }
    const range  = highs[n - 1] - lows[n - 1];
    const uWick  = highs[n - 1] - Math.max(closes[n - 1], opns[n - 1]);
    const uWickR = range > 0 ? uWick / range : 0;
    if (uWickR > 0.5) { score += 25; reasons.push(`Large upper wick ${(uWickR * 100).toFixed(0)}% of range — rejection at highs`); }
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volSpike = avgVol5 > avgVol20 * 2;
    if (brokeAbove && volSpike && closedBelow) { score += 20; reasons.push('High volume on fake breakout — liquidity grab confirmed'); }
    if (ob?.asks?.length) {
        const avgAsk = ob.asks.reduce((s, a) => s + a.qty, 0) / ob.asks.length;
        const topAsk = ob.asks.reduce((m, a) => a.qty > m.qty ? a : m, ob.asks[0]);
        if (topAsk.qty > avgAsk * 5 && topAsk.price > closes[n - 1]) {
            score += 15;
            reasons.push('Large ask wall just above current price — MM selling into breakout');
        }
    }
    const prevCandle   = n - 2;
    const prevGreen    = closes[prevCandle] > opns[prevCandle];
    const currentRed   = closes[n - 1] < opns[n - 1];
    if (prevGreen && currentRed && brokeAbove && closedBelow) { score += 10; reasons.push('Engulfing reversal after breakout — trap pattern'); }
    const trap       = score >= 50;
    const confidence = Math.min(score, 100);
    return {
        trap, confidence,
        detail: trap ? `MM Trap detected (${confidence}/100) — ${reasons[0] ?? ''}` : 'No MM trap detected',
        reasons,
    };
}

// STEP 7 — MARKET REGIME DETECTOR
function detectMarketRegime(closes, highs, lows, volumes) {
    const n = closes.length;
    if (n < 20) return { regime: 'UNKNOWN', regimeScore: 50, note: 'Insufficient data' };
    const atrArr  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atrNow  = atrArr[atrArr.length - 1] ?? 0;
    const price   = closes[n - 1];
    const atrPct  = price > 0 ? (atrNow / price) * 100 : 0;
    const highRange = Math.max(...highs.slice(-20));
    const lowRange  = Math.min(...lows.slice(-20));
    const rangeW    = highRange > 0 ? ((highRange - lowRange) / highRange) * 100 : 0;
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volTrend = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
    const hurst    = calcHurst(closes.slice(-60));
    let regime, regimeScore, note;
    if (atrPct < 0.8 && rangeW < 8) {
        regime = 'COMPRESSION'; regimeScore = 30;
        note = `ATR ${atrPct.toFixed(1)}% + range ${rangeW.toFixed(1)}% — coiling for breakout`;
    } else if (hurst.regime === 'TRENDING' && volTrend > 1.3 && atrPct > 1.5) {
        regime = 'TRENDING'; regimeScore = 80;
        note = `Hurst ${hurst.hurst} + vol ${volTrend.toFixed(1)}x + ATR ${atrPct.toFixed(1)}% — strong trend`;
    } else if (atrPct > 3.0 && volTrend > 2.0) {
        regime = 'VOLATILE'; regimeScore = 60;
        note = `ATR ${atrPct.toFixed(1)}% + vol surge — high volatility, careful`;
    } else if (hurst.regime === 'MEAN_REV') {
        regime = 'RANGING'; regimeScore = 40;
        note = `Hurst ${hurst.hurst} — mean-reverting, breakouts likely to fail`;
    } else {
        regime = 'NEUTRAL'; regimeScore = 50;
        note = 'No clear regime — standard analysis applies';
    }
    return { regime, regimeScore, note, atrPct: +atrPct.toFixed(2), rangeWidth: +rangeW.toFixed(1), volTrend: +volTrend.toFixed(2), hurst: hurst.hurst };
}

// STEP 8 — INSTITUTIONAL FINAL VERDICT
function buildInstitutionalVerdict(tfHierarchy, conflicts, hiddenFlow, shakeout, mmTrap, regime, mainSignal) {
    let verdict = 'WATCH';
    let confidence = 50;
    const reasons  = [];
    const warnings = [];
    const actions  = [];

    // Timeframe alignment
    if (tfHierarchy.conflictType === 'FULL_ALIGNMENT') {
        confidence += 20; reasons.push('Full 15m+1h+4h alignment');
    } else if (tfHierarchy.conflictType === 'LOCAL_PULLBACK') {
        confidence += 5; reasons.push('Short dip in bullish trend — pullback only');
    } else if (['FULL_BEARISH', 'SHORT_BOUNCE'].includes(tfHierarchy.conflictType)) {
        confidence -= 20; warnings.push('Higher timeframes bearish');
    } else if (tfHierarchy.conflictType === 'MEDIUM_PULLBACK') {
        confidence -= 10; warnings.push('1h+4h pulling back');
    }

    // Engine conflicts
    if (conflicts.signalClarity === 'CLEAN') {
        confidence += 10; reasons.push('All engines agree — clean signal');
    } else if (conflicts.signalClarity === 'EXPLAINABLE') {
        confidence += 0; reasons.push('Conflict explained: ' + conflicts.resolutions[0]?.split('.')[0]);
    } else if (conflicts.signalClarity === 'CONFLICTED') {
        confidence -= 15; warnings.push('Engine conflict — reduce size');
    } else if (conflicts.signalClarity === 'DANGEROUS') {
        confidence -= 25; warnings.push('DANGEROUS: Multiple conflicting signals');
        actions.push('Do NOT enter until conflict resolves');
    }

    // Hidden flow
    if (hiddenFlow.type === 'HIDDEN_BUYER') {
        confidence += 15; reasons.push(`Hidden buyer detected (${hiddenFlow.confidence}/100)`);
    } else if (hiddenFlow.type === 'POSSIBLE_HIDDEN_BUYER') {
        confidence += 8;  reasons.push('Possible hidden buyer — watch for confirmation');
    } else if (hiddenFlow.type === 'HIDDEN_SELLER') {
        confidence -= 20; warnings.push(`Hidden seller blocking (${hiddenFlow.confidence}/100)`);
        actions.push('Wait for seller to clear before entering');
    }

    // Shakeout
    if (shakeout.shakeout) {
        confidence += 10; reasons.push(`Weak-hand flush (${shakeout.confidence}/100) — likely to recover`);
        actions.push('Buy the dip — shakeout pattern identified');
    }

    // MM Trap
    if (mmTrap.trap) {
        confidence -= 25; warnings.push(`MM Trap (${mmTrap.confidence}/100) — breakout was fake`);
        actions.push('Exit or do not enter — price likely to reverse');
    }

    // Market regime
    if (regime.regime === 'TRENDING') {
        confidence += 10; reasons.push('Trending regime — continuation likely');
    } else if (regime.regime === 'COMPRESSION') {
        confidence += 5; reasons.push('Compression — breakout incoming');
        actions.push('Place alerts 2-3% above current price for breakout');
    } else if (regime.regime === 'VOLATILE') {
        confidence -= 5; warnings.push('High volatility — use wider stops');
    } else if (regime.regime === 'RANGING') {
        confidence -= 10; warnings.push('Mean-reverting regime — breakouts may fail');
    }

    confidence = Math.max(0, Math.min(100, confidence));

    // Final verdict
    if (mmTrap.trap) {
        verdict = 'AVOID';
    } else if (confidence >= 75 && !warnings.length) {
        verdict = 'HIGH_CONVICTION';
    } else if (confidence >= 60) {
        verdict = 'BUY';
    } else if (confidence >= 45) {
        verdict = 'WATCH';
    } else if (confidence >= 30) {
        verdict = 'WAIT';
    } else {
        verdict = 'AVOID';
    }

    const verdictEmoji = {
        HIGH_CONVICTION: '🔥', BUY: '✅', WATCH: '👀', WAIT: '⏳', AVOID: '🚫'
    }[verdict] ?? '⚪';

    if (actions.length === 0) {
        if (verdict === 'HIGH_CONVICTION') actions.push('Enter now — all conditions aligned');
        else if (verdict === 'BUY')        actions.push('Entry valid — manage risk with proper SL');
        else if (verdict === 'WATCH')      actions.push('Monitor — wait for one more confirmation');
        else if (verdict === 'WAIT')       actions.push('Not ready — wait for signals to align');
        else                               actions.push('Skip this setup — risk too high');
    }

    return { verdict, verdictEmoji, confidence, reasons, warnings, actions, tfConflict: tfHierarchy.conflictType, signalClarity: conflicts.signalClarity };
}

// STEP 9 — INSTITUTIONAL TELEGRAM FORMATTER
function formatInstitutionalSummary(verdict, symbol) {
    if (!verdict) return '';
    const { verdictEmoji, confidence, reasons, warnings, actions, tfConflict, signalClarity } = verdict;

    const clarityEmoji = { CLEAN: '✅', EXPLAINABLE: '🟡', CONFLICTED: '🟠', DANGEROUS: '🔴' }[signalClarity] ?? '⚪';
    const tfEmoji      = { FULL_ALIGNMENT: '✅', LOCAL_PULLBACK: '🟡', MEDIUM_PULLBACK: '🟠', FULL_BEARISH: '🔴', SHORT_BOUNCE: '🔴', TREND_CONFLICT: '🟠', LOCAL_PUSH: '🟡', MIXED: '⚪' }[tfConflict] ?? '⚪';

    return (
`
━━━━━━━━━━━━━━━━━━
🏛 *Institutional Intelligence — ${symbol}*
${verdictEmoji} *Verdict: ${verdict.verdict}* (${confidence}/100)

${tfEmoji} TF Alignment: *${tfConflict?.replace(/_/g, ' ')}*
${clarityEmoji} Signal Clarity: *${signalClarity}*

${reasons.length    ? `✅ *Bullish:*\n${reasons.slice(0,3).map(r => ` · ${safeTxt(r)}`).join('\n')}\n` : ''}${warnings.length   ? `⚠️ *Watch:*\n${warnings.slice(0,3).map(w => ` · ${safeTxt(w)}`).join('\n')}\n` : ''}
🎯 *Action: ${safeTxt(actions[0] ?? 'Monitor')}*`
    );
}

// STEP 10 — MASTER INSTITUTIONAL LAYER FUNCTION
async function runInstitutionalLayer(symbol, c15, c1h, c4h, ob, mainSignal) {
    if (!c15) return null;
    const { closes, highs, lows, volumes, opens } = c15;
    try {
        const tfHierarchy = analyzeTimeframeHierarchy(c15, c1h, c4h);
        const volIntentI  = classifyVolumeIntent(closes, highs, lows, volumes, opens);
        const smAbsorbI   = detectSmartMoneyAbsorption(closes, highs, lows, volumes, ob);
        const obRI        = analyzeOrderBook(ob);
        const hurstI      = calcHurst(closes.slice(-60));
        const volZI       = volumeZScore(volumes);
        const tsmomI      = calcTSMOM(closes);
        const conflicts   = resolveEngineConflicts(volIntentI, smAbsorbI, obRI, hurstI, volZI, tsmomI);
        const hiddenFlow  = detectHiddenFlow(closes, highs, lows, volumes, opens);
        const shakeout    = detectWeakHandShakeout(closes, highs, lows, volumes, opens);
        const mmTrap      = detectMarketMakerTrap(closes, highs, lows, volumes, opens, ob);
        const regime      = detectMarketRegime(closes, highs, lows, volumes);
        const verdict     = buildInstitutionalVerdict(tfHierarchy, conflicts, hiddenFlow, shakeout, mmTrap, regime, mainSignal);
        return { tfHierarchy, conflicts, hiddenFlow, shakeout, mmTrap, regime, verdict };
    } catch (e) {
        console.error(`[InstLayer] ${symbol}:`, e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTITUTIONAL TRACKER UPGRADE (Steps 11-14)
// ═══════════════════════════════════════════════════════════════════════════

// STEP 11 — ANALYZE TRACKED POSITION
async function analyzeTrackedPosition(pos, c15, c1h, c4h, ob) {
    if (!c15 || !pos) return null;
    const { closes, highs, lows, volumes, opens } = c15;
    const n          = closes.length;
    const currentPrice = closes[n - 1];
    const entry        = parseFloat(pos.entry ?? 0);
    const pnlPct       = entry > 0 ? +((currentPrice - entry) / entry * 100).toFixed(2) : 0;

    const rsiArr  = RSI.calculate({ values: closes, period: 14 });
    const rsiNow  = rsiArr.length ? +rsiArr[rsiArr.length - 1].toFixed(1) : 50;
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volTrend = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

    const tfHierarchy = analyzeTimeframeHierarchy(c15, c1h, c4h);
    const hiddenFlow  = detectHiddenFlow(closes, highs, lows, volumes, opens);
    const shakeout    = detectWeakHandShakeout(closes, highs, lows, volumes, opens);
    const mmTrap      = detectMarketMakerTrap(closes, highs, lows, volumes, opens, ob);
    const regime      = detectMarketRegime(closes, highs, lows, volumes);

    const momentum  = analyzeMomentum(closes, highs, lows, volumes);
    const tsmom     = calcTSMOM(closes);
    const trendConf = analyzeTrendConfirmation(closes, highs, lows, volumes, analyzeOrderBook(ob), momentum, analyzeLiquidityFlow(closes, highs, lows, volumes));

    let contScore = 50;
    const exitReasons = [];
    if (tfHierarchy.conflictType === 'FULL_ALIGNMENT')    contScore += 20;
    else if (tfHierarchy.conflictType === 'LOCAL_PULLBACK') contScore += 5;
    else if (['FULL_BEARISH', 'SHORT_BOUNCE'].includes(tfHierarchy.conflictType)) { contScore -= 25; exitReasons.push('Higher TFs bearish'); }
    else if (tfHierarchy.conflictType === 'MEDIUM_PULLBACK') { contScore -= 15; exitReasons.push('1h+4h pulling back'); }
    if (hiddenFlow.type === 'HIDDEN_BUYER')  contScore += 15;
    if (hiddenFlow.type === 'HIDDEN_SELLER') { contScore -= 20; exitReasons.push('Hidden seller detected'); }
    if (shakeout.shakeout)                   contScore += 10;
    if (mmTrap.trap)                         { contScore -= 30; exitReasons.push('MM Trap — price reversal risk'); }
    if (trendConf.trendStatus === 'Trend Stop')    { contScore -= 25; exitReasons.push('Trend stopped — structure broken'); }
    else if (trendConf.trendStatus === 'Weakening') { contScore -= 10; exitReasons.push('Trend weakening'); }
    else if (trendConf.trendStatus === 'Continuation Strong') contScore += 15;
    if (tsmom.bullish) contScore += 8;
    if (tsmom.bearish) { contScore -= 10; exitReasons.push('TSMOM momentum bearish'); }
    if (rsiNow > 75)   { contScore -= 10; exitReasons.push(`RSI overbought ${rsiNow}`); }
    if (volTrend < 0.7) { contScore -= 5; exitReasons.push('Volume declining'); }
    contScore = Math.max(0, Math.min(100, contScore));

    return { currentPrice, pnlPct, rsiNow, volTrend: +volTrend.toFixed(2), contScore, tfHierarchy, hiddenFlow, shakeout, mmTrap, regime, exitReasons, trendStatus: trendConf.trendStatus };
}

// STEP 12 — CLASSIFY TRACKER STATE
function classifyTrackerState(analysis) {
    if (!analysis) return { state: 'UNKNOWN', label: 'Unknown', emoji: '⚪', action: 'No data available' };
    const { contScore, mmTrap, tfHierarchy, hiddenFlow, shakeout, trendStatus, pnlPct } = analysis;
    if (mmTrap?.trap || contScore < 25 || trendStatus === 'Trend Stop') {
        return { state: 'EXIT', label: 'EXIT NOW', emoji: '🚨', action: mmTrap?.trap ? 'MM Trap detected — exit immediately' : 'Trend structure broken — close position' };
    }
    if (shakeout?.shakeout && pnlPct < -2) {
        return { state: 'HOLD_DIP', label: 'HOLD THROUGH DIP', emoji: '🧠', action: 'Weak-hand flush detected — likely to recover. Hold if SL not hit.' };
    }
    if (hiddenFlow?.type === 'HIDDEN_SELLER' || contScore < 40) {
        return { state: 'DISTRIBUTION', label: 'DISTRIBUTION DETECTED', emoji: '🔴', action: 'Hidden seller overhead or score dropping. Consider reducing size.' };
    }
    if (['FULL_ALIGNMENT', 'LOCAL_PULLBACK'].includes(tfHierarchy?.conflictType) && contScore >= 65) {
        return { state: 'CONTINUING', label: 'CONTINUING', emoji: '🟢', action: 'Trend intact on all timeframes. Hold full position.' };
    }
    return { state: 'WATCH', label: 'MONITOR', emoji: '🟡', action: 'Mixed signals. Check again in 15-30 min.' };
}

// STEP 13 — TRACKER TELEGRAM FORMATTER (institutional version)
function formatTrackerUpdateInstitutional(trackerOut, pos) {
    if (!trackerOut || !pos) return '';
    const { analysis, stateResult } = trackerOut;
    if (!analysis || !stateResult) return '';
    const symbol   = pos.symbol ?? '???';
    const entry    = parseFloat(pos.entry ?? 0);
    const price    = analysis.currentPrice;
    const pnl      = analysis.pnlPct;
    const pnlEmoji = pnl >= 5 ? '🚀' : pnl >= 2 ? '📈' : pnl >= 0 ? '✅' : pnl >= -2 ? '⚠️' : '🔴';
    const tf       = analysis.tfHierarchy;
    const pnlLine  = `${pnlEmoji} P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% | Entry: ${entry} → Now: ${price}`;
    const tfSummary = tf?.shortTerm ? (
        `📊 *Timeframe:*\n` +
        ` · 15m: ${tf.shortTerm.trend} (RSI ${tf.shortTerm.rsi})\n` +
        ` · 1h:  ${tf.mediumTerm.trend} (RSI ${tf.mediumTerm.rsi})\n` +
        ` · 4h:  ${tf.longTerm.trend} (RSI ${tf.longTerm.rsi}) — ${tf.longTerm.structure}\n` +
        ` · _${tf.finalMeaning}_`
    ) : '';
    const stateBlock =
        `━━━━━━━━━━━━━━━━━━\n` +
        `${stateResult.emoji} *${stateResult.label}*\n` +
        `_${stateResult.action}_`;
    const hiddenLine = analysis.hiddenFlow?.type && analysis.hiddenFlow.type !== 'NEUTRAL'
        ? `\n · ${analysis.hiddenFlow.type === 'HIDDEN_BUYER' ? '🔵' : '🔴'} *${analysis.hiddenFlow.type.replace(/_/g, ' ')}* (${analysis.hiddenFlow.confidence}/100)`
        : '';
    const shakeLine = analysis.shakeout?.shakeout ? `\n · 🧠 Weak-hand flush detected — likely to recover` : '';
    const trapLine  = analysis.mmTrap?.trap ? `\n · ⚠️ MM Trap warning (${analysis.mmTrap.confidence}/100)` : '';
    const metricsLine =
        `Vol: ${analysis.volTrend > 1.2 ? '📈' : analysis.volTrend < 0.8 ? '📉' : '➡️'} ${analysis.volTrend.toFixed(1)}x avg` +
        ` | RSI: ${analysis.rsiNow}` +
        ` | Regime: ${analysis.regime?.regime ?? '?'}`;
    const cs     = analysis.contScore;
    const csEmoji = cs >= 70 ? '🟢' : cs >= 45 ? '🟡' : '🔴';
    const contLine = `${csEmoji} Continuation: ${cs}/100`;
    const exitLine = analysis.exitReasons?.length > 0
        ? `\n⚠️ *Watch:* ${analysis.exitReasons.slice(0, 2).join(' | ')}`
        : '';
    return (
`🔍 *Tracker Update — ${symbol}*
${pnlLine}

${tfSummary}
${hiddenLine}${shakeLine}${trapLine}

${metricsLine}
${contLine}${exitLine}

${stateBlock}`
    );
}

// STEP 14 — MASTER TRACKER FUNCTION
async function runTrackerInstitutional(pos, c15, c1h, c4h, ob) {
    if (!pos || !c15) return null;
    const analysis    = await analyzeTrackedPosition(pos, c15, c1h, c4h, ob);
    if (!analysis)    return null;
    const stateResult = classifyTrackerState(analysis);
    return { analysis, stateResult };
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║         INSTITUTIONAL CRYPTO SCANNER v6.0                ║');
console.log('║   Blueprint + Institutional Intelligence + Smart Tracker  ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

if (!_standaloneMode) {
  // Required as a module — skip Telegram startup message and start scan directly
  scan();
  setInterval(scan, CONFIG.SCAN_INTERVAL_MS);
  setInterval(reviewTrackedPositions, CONFIG.TRACKER_REVIEW_MS);
} else
sendTelegram(
`🚀 *Scanner v6.0 Started*

*Original Engines (v5.0):*
⚡ Volume Z-Score Pre-Pump Detector
🌱 Wyckoff Spring Detector
☣️ VPIN Toxicity Filter
📊 Hurst Exponent Regime
🚀 TSMOM Signal
⚠️ Fake Breakout Discriminator v2
🌀 Parabolic Move Detector
₿ BTC Cross-Asset Momentum Gate
🎯 Expansion Probability Engine
💥 Explosion Readiness Score

*New in v6.0 (Institutional Layer):*
🏛 Engine Conflict Resolver
🔵 Hidden Buyer / 🔴 Hidden Seller Detector
🧠 Weak-Hand Shakeout Detector
⚠️ Market Maker Trap Detector
📊 4H Timeframe Hierarchy (15m+1h+4h)
🔬 Market Regime Detector
✅ Institutional Final Verdict
🔍 Smart Tracker Upgrade

*Commands:*
/track SYMBOL PRICE → start tracking
/untrack SYMBOL → stop
/tracked → view all
/analyze SYMBOL → on-demand analysis
/forecast SYMBOL → quick forecast
/help → full commands

_Scan every 5 min | Top 200 pairs_`
).then(() => {
    scan();
    setInterval(scan, CONFIG.SCAN_INTERVAL_MS);
    setInterval(reviewTrackedPositions, CONFIG.TRACKER_REVIEW_MS);
});

module.exports = { broadcastSignal: forwardSignal };
