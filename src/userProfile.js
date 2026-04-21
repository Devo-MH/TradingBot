'use strict';

/**
 * User Profile System
 *
 * Manages onboarding, profile storage, and per-user risk parameters.
 * Every bot decision (signal filtering, position sizing, daily limits)
 * reads from this module.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, '../data');
const PROFILES_FILE  = path.join(DATA_DIR, 'users.json');
const ONBOARD_STATES = path.join(DATA_DIR, 'onboard_states.json');

// ─── DEFAULTS ────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE = {
  capital          : 1000,
  riskPct          : 0.03,       // 3% per trade
  maxTrades        : 2,
  experience       : 'beginner',
  activeHours      : [0, 23],    // UTC start/end
  signalFilter     : 'B',        // minimum grade to receive: A+, A, B
  dailyLossLimitPct: 0.06,       // pause after -6% of capital in a day
  maxCapitalPct    : 0.30,       // never deploy >30% at once
  paused           : false,
  onboarded        : false,
  createdAt        : null,
};

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────

function loadJSON(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Profile] Save error:', e.message);
  }
}

// ─── PROFILE CRUD ────────────────────────────────────────────────────────────

function getAllProfiles() {
  return loadJSON(PROFILES_FILE, {});
}

function getProfile(userId) {
  const all = getAllProfiles();
  return all[String(userId)] ?? null;
}

function saveProfile(userId, profile) {
  const all = getAllProfiles();
  all[String(userId)] = { ...DEFAULT_PROFILE, ...profile };
  saveJSON(PROFILES_FILE, all);
  return all[String(userId)];
}

function updateProfile(userId, patch) {
  const existing = getProfile(userId) ?? { ...DEFAULT_PROFILE };
  return saveProfile(userId, { ...existing, ...patch });
}

function isOnboarded(userId) {
  const p = getProfile(userId);
  return p?.onboarded === true;
}

// ─── ONBOARDING STATE MACHINE ────────────────────────────────────────────────
//
// Each user progresses through 5 questions.
// State is stored in a separate file so it survives bot restarts.
//
// Steps:
//   0 → ask capital
//   1 → ask risk tolerance
//   2 → ask experience
//   3 → ask max concurrent trades
//   4 → ask active hours
//   5 → complete

function getOnboardState(userId) {
  const all = loadJSON(ONBOARD_STATES, {});
  return all[String(userId)] ?? { step: 0, data: {} };
}

function saveOnboardState(userId, state) {
  const all = loadJSON(ONBOARD_STATES, {});
  all[String(userId)] = state;
  saveJSON(ONBOARD_STATES, all);
}

function clearOnboardState(userId) {
  const all = loadJSON(ONBOARD_STATES, {});
  delete all[String(userId)];
  saveJSON(ONBOARD_STATES, all);
}

// ─── ONBOARDING QUESTIONS ────────────────────────────────────────────────────

const ONBOARD_STEPS = [
  {
    key     : 'capital',
    question: (
      `💰 *Step 1 of 5 — Your Capital*\n\n` +
      `How much USDT are you trading with?\n` +
      `_(This sets your position sizes — be honest for best results)_`
    ),
    buttons : [
      [{ text: 'Under $500',    callback_data: 'ob_capital_300'   }],
      [{ text: '$500 – $2,000', callback_data: 'ob_capital_1000'  }],
      [{ text: '$2,000 – $10K', callback_data: 'ob_capital_5000'  }],
      [{ text: '$10,000+',      callback_data: 'ob_capital_15000' }],
    ],
    parse: cb => parseInt(cb.replace('ob_capital_', ''), 10),
  },
  {
    key     : 'riskPct',
    question: (
      `🛡️ *Step 2 of 5 — Risk Tolerance*\n\n` +
      `How much of your capital can you risk per trade?\n\n` +
      `• *Conservative* — small, safe bets. Slower growth.\n` +
      `• *Moderate* — balanced approach. Recommended.\n` +
      `• *Aggressive* — bigger swings. Higher reward AND loss.`
    ),
    buttons : [
      [{ text: '🟢 Conservative  (1–2%)', callback_data: 'ob_risk_0.02' }],
      [{ text: '🟡 Moderate      (3–5%)', callback_data: 'ob_risk_0.04' }],
      [{ text: '🔴 Aggressive    (6–10%)',callback_data: 'ob_risk_0.08' }],
    ],
    parse: cb => parseFloat(cb.replace('ob_risk_', '')),
  },
  {
    key     : 'experience',
    question: (
      `📚 *Step 3 of 5 — Experience Level*\n\n` +
      `How experienced are you with crypto trading?\n\n` +
      `• *Beginner* — I'll only send you the clearest, highest-confidence signals\n` +
      `• *Intermediate* — good signals with full context\n` +
      `• *Advanced* — all signals including early-stage setups`
    ),
    buttons : [
      [{ text: '🌱 Beginner',     callback_data: 'ob_exp_beginner'     }],
      [{ text: '📈 Intermediate', callback_data: 'ob_exp_intermediate' }],
      [{ text: '🧠 Advanced',     callback_data: 'ob_exp_advanced'     }],
    ],
    parse: cb => cb.replace('ob_exp_', ''),
  },
  {
    key     : 'maxTrades',
    question: (
      `⚖️ *Step 4 of 5 — Capacity*\n\n` +
      `How many trades can you manage at the same time?\n\n` +
      `_More trades = more alerts. Start small if you're new._`
    ),
    buttons : [
      [{ text: '1 trade at a time', callback_data: 'ob_maxt_1' }],
      [{ text: '2 trades',          callback_data: 'ob_maxt_2' }],
      [{ text: '3 trades',          callback_data: 'ob_maxt_3' }],
      [{ text: '5 trades',          callback_data: 'ob_maxt_5' }],
    ],
    parse: cb => parseInt(cb.replace('ob_maxt_', ''), 10),
  },
  {
    key     : 'activeHours',
    question: (
      `🕐 *Step 5 of 5 — Trading Hours*\n\n` +
      `When are you usually active? (UTC)\n` +
      `_I'll only send alerts during your active hours._`
    ),
    buttons : [
      [{ text: '🌏 Asia    (00:00–08:00 UTC)', callback_data: 'ob_hours_0_8'   }],
      [{ text: '🇪🇺 Europe  (07:00–15:00 UTC)', callback_data: 'ob_hours_7_15'  }],
      [{ text: '🇺🇸 US      (13:00–21:00 UTC)', callback_data: 'ob_hours_13_21' }],
      [{ text: '🌍 24/7 — always active',       callback_data: 'ob_hours_0_23'  }],
    ],
    parse: (cb) => {
      const parts = cb.replace('ob_hours_', '').split('_');
      return [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    },
  },
];

// ─── ONBOARDING FLOW HANDLERS ─────────────────────────────────────────────────

function getOnboardQuestion(step) {
  return ONBOARD_STEPS[step] ?? null;
}

/**
 * Process a callback answer for the current onboarding step.
 * Returns { done, nextQuestion, profile } where done=true means onboarding complete.
 */
function processOnboardAnswer(userId, callbackData) {
  const state = getOnboardState(userId);
  const step  = ONBOARD_STEPS[state.step];

  if (!step) return { done: false, error: 'Invalid step' };

  // Validate callback belongs to this step
  const prefix = callbackData.split('_').slice(0, 2).join('_');
  const expectedPrefix = `ob_${step.key.replace('Pct', '').replace('Hours', 'hours').replace('maxTrades', 'maxt').toLowerCase()}`;

  const parsed = step.parse(callbackData);
  state.data[step.key] = parsed;
  state.step += 1;

  if (state.step >= ONBOARD_STEPS.length) {
    // Onboarding complete — build profile
    const profile = buildProfileFromOnboard(state.data);
    saveProfile(userId, { ...profile, onboarded: true, createdAt: Date.now() });
    clearOnboardState(userId);
    return { done: true, profile };
  }

  saveOnboardState(userId, state);
  const nextQ = ONBOARD_STEPS[state.step];
  return { done: false, nextQuestion: nextQ };
}

function buildProfileFromOnboard(data) {
  const exp = data.experience ?? 'beginner';
  let signalFilter = 'B';
  if (exp === 'beginner')     signalFilter = 'A';   // only A and A+ for beginners
  if (exp === 'intermediate') signalFilter = 'B';
  if (exp === 'advanced')     signalFilter = 'C';   // all signals

  const dailyLossLimitPct = data.riskPct <= 0.02 ? 0.04
    : data.riskPct <= 0.05 ? 0.06
    : 0.10;

  return {
    capital          : data.capital          ?? 1000,
    riskPct          : data.riskPct          ?? 0.03,
    maxTrades        : data.maxTrades        ?? 2,
    experience       : exp,
    activeHours      : data.activeHours      ?? [0, 23],
    signalFilter,
    dailyLossLimitPct,
    maxCapitalPct    : 0.30,
    paused           : false,
  };
}

// ─── RISK PARAMETER HELPERS ──────────────────────────────────────────────────

/**
 * Calculate position size in USDT for a given trade.
 * Returns { recommended, conservative, aggressive, maxRiskUSDT }
 */
function calcPositionSizes(userId) {
  const p = getProfile(userId);
  if (!p) return null;

  const rec  = Math.round(p.capital * p.riskPct);
  const cons = Math.round(p.capital * p.riskPct * 0.6);
  const agg  = Math.round(p.capital * p.riskPct * 1.8);

  // Max risk in USDT at SL distance of 2.5%
  const maxRiskUSDT = +(rec * 0.025).toFixed(2);

  return { recommended: rec, conservative: cons, aggressive: agg, maxRiskUSDT };
}

/**
 * Check if user is within daily loss limit.
 * Returns { allowed, reason }
 */
function checkDailyLimit(userId, dailyPnlUSDT) {
  const p = getProfile(userId);
  if (!p) return { allowed: false, reason: 'No profile found' };

  const limitUSDT = p.capital * p.dailyLossLimitPct;
  if (dailyPnlUSDT <= -limitUSDT) {
    return {
      allowed: false,
      reason : `Daily loss limit reached (${formatUSDT(dailyPnlUSDT)} / -${formatUSDT(limitUSDT)}). Bot paused until tomorrow.`,
    };
  }
  return { allowed: true };
}

/**
 * Check if user can open another trade.
 * Returns { allowed, reason, openCount, maxAllowed }
 */
function checkTradeCapacity(userId, currentOpenCount) {
  const p = getProfile(userId);
  if (!p) return { allowed: false, reason: 'No profile found' };
  if (p.paused) return { allowed: false, reason: 'Bot is paused. Use /resume to continue.' };
  if (currentOpenCount >= p.maxTrades) {
    return {
      allowed   : false,
      reason    : `You already have ${currentOpenCount}/${p.maxTrades} trades open.`,
      openCount : currentOpenCount,
      maxAllowed: p.maxTrades,
    };
  }
  return { allowed: true, openCount: currentOpenCount, maxAllowed: p.maxTrades };
}

/**
 * Determine if a signal should be sent to this user.
 * grade: 'A+' | 'A' | 'B' | 'C'
 */
function shouldReceiveSignal(userId, grade) {
  const p = getProfile(userId);
  if (!p || !p.onboarded) return false;
  if (p.paused) return false;

  const rank = { 'A+': 4, 'A': 3, 'B': 2, 'C': 1 };
  const required = rank[p.signalFilter] ?? 2;
  const actual   = rank[grade]          ?? 1;
  return actual >= required;
}

/**
 * Check if current UTC hour is within user's active window.
 */
function isUserActive(userId) {
  const p = getProfile(userId);
  if (!p) return false;
  const [start, end] = p.activeHours;
  const h = new Date().getUTCHours();
  if (start <= end) return h >= start && h <= end;
  return h >= start || h <= end; // overnight window (e.g. 22–06)
}

// ─── PROFILE DISPLAY HELPERS ─────────────────────────────────────────────────

function formatUSDT(n) {
  return `$${Math.abs(n).toFixed(2)}`;
}

function gradeEmoji(grade) {
  return { 'A+': '⭐⭐⭐', 'A': '⭐⭐', 'B': '⭐', 'C': '⚠️' }[grade] ?? '⚪';
}

function buildProfileSummary(userId) {
  const p = getProfile(userId);
  if (!p) return 'No profile found.';

  const [hStart, hEnd] = p.activeHours;
  const hoursLabel = hStart === 0 && hEnd === 23 ? '24/7' : `${hStart}:00–${hEnd}:00 UTC`;
  const sizes = calcPositionSizes(userId);

  return (
    `👤 *Your Trading Profile*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Capital:       $${p.capital.toLocaleString()}\n` +
    `🎯 Risk/trade:    ${(p.riskPct * 100).toFixed(0)}% → *~$${sizes.recommended}*\n` +
    `⚖️  Max trades:   ${p.maxTrades} at once\n` +
    `📚 Level:         ${p.experience}\n` +
    `🕐 Active hours:  ${hoursLabel}\n` +
    `📡 Signal filter: Grade ${p.signalFilter} and above\n` +
    `🛑 Daily limit:   -${(p.dailyLossLimitPct * 100).toFixed(0)}% of capital\n` +
    `⏸️  Status:        ${p.paused ? '⏸️ Paused' : '✅ Active'}\n\n` +
    `To update any setting: /profile edit`
  );
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  // CRUD
  getProfile,
  saveProfile,
  updateProfile,
  isOnboarded,
  getAllProfiles,

  // Onboarding
  getOnboardState,
  saveOnboardState,
  getOnboardQuestion,
  processOnboardAnswer,
  ONBOARD_STEPS,

  // Risk helpers
  calcPositionSizes,
  checkDailyLimit,
  checkTradeCapacity,
  shouldReceiveSignal,
  isUserActive,

  // Display
  buildProfileSummary,
  gradeEmoji,
  formatUSDT,
};
