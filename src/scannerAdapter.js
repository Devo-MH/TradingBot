'use strict';

/**
 * Scanner Adapter
 *
 * Normalises scanner_v6.js output into the unified signal shape
 * that signalBridge, tradeStore and tradeMonitor expect.
 *
 * Field shapes confirmed from scanner_v6.js source:
 *
 * Regular signal (r):
 *   r.entry, r.sl, r.tp1, r.tp2, r.moonPrice   — prices
 *   r.hurst   = { hurst: 0.9, regime: 'TRENDING' }
 *   r.tsmom   = { signal: 1.0, bullish: true, bearish: false }
 *   r.session = { session: 'EUROPE', emoji: '🌍', weight: 1 }
 *   r.volZ    = { z: 1.22, highAnomaly: bool, medAnomaly: bool, stealth: bool }
 *   r.instGrade = { grade: 'A+', iScore: 84 }
 *   r._instLayer — full institutional layer object
 *   r.atrPct  — number
 *   r.signals — string[]
 *
 * Pre-pump (pp):
 *   pp.price  (no entry/sl/tp fields — calculated from price)
 *   pp.prePumpSignals — string[]
 *   pp.smAbsorb = { absorptionScore: 0-100, absorbing: bool }
 *   pp.instConfidence — number 0-100
 *   pp.instClass — 'EXPLOSIVE'|'CLEAN'|'RISKY'|'TRAP'
 *   pp.obRatio — STRING like "0.58"
 *   pp.bidDepthUSDT, pp.askDepthUSDT
 *   pp.ppExpansion — string
 *   same hurst/tsmom/session/volZ object shapes as regular signal
 */

function adapt(raw) {
  if (!raw || !raw.symbol) return null;

  // ── Identity ───────────────────────────────────────────────────────────────
  const symbol = String(raw.symbol).toUpperCase();

  // ── Prices ─────────────────────────────────────────────────────────────────
  const basePrice = raw.entry ?? raw.price ?? raw.currentPrice ?? 0;

  // Pre-pump signals don't store targets — derive them from price
  const entry      = basePrice;
  const sl         = raw.sl    ?? raw.stop ?? raw.stopLoss   ?? (basePrice ? basePrice * 0.975 : 0);
  const tp1        = raw.tp1   ?? (basePrice ? basePrice * 1.10 : 0);
  const tp2        = raw.tp2   ?? (basePrice ? basePrice * 1.20 : 0);
  const moonPrice  = raw.moonPrice ?? raw.moon ?? raw.moonTarget ?? (basePrice ? basePrice * 1.40 : 0);
  const confirmAbove = raw.confirmAbove ?? raw.confirmLevel ?? (basePrice ? basePrice * 1.03 : 0);

  const triggerDistance = raw.triggerPct       != null ? parseFloat(raw.triggerPct)
                        : raw.triggerDistance  != null ? parseFloat(raw.triggerDistance)
                        : raw.breakoutDistance != null ? parseFloat(raw.breakoutDistance)
                        : raw.distToHigh       != null ? parseFloat(raw.distToHigh)
                        : null;

  // ── Hurst — object {hurst, regime} or plain number ────────────────────────
  const hurst = raw.hurst != null
    ? (typeof raw.hurst === 'object' ? raw.hurst.hurst : raw.hurst)
    : null;
  const hurstRegime = typeof raw.hurst === 'object' ? raw.hurst.regime : null;

  // ── TSMOM — object {signal, bullish} or plain number ──────────────────────
  const tsmom = raw.tsmom != null
    ? (typeof raw.tsmom === 'object' ? raw.tsmom.signal : raw.tsmom)
    : null;
  const tsmomBullish = typeof raw.tsmom === 'object' ? raw.tsmom.bullish : (tsmom >= 0.5);

  // ── Session — object {session, emoji, weight} or string ───────────────────
  const session       = typeof raw.session === 'object' ? (raw.session?.session ?? '') : (raw.session ?? '');
  const sessionWeight = typeof raw.session === 'object' ? (raw.session?.weight ?? 0) : (raw.sessionWeight ?? 0);

  // ── ATR ────────────────────────────────────────────────────────────────────
  const atrPct = raw.atrPct != null ? parseFloat(raw.atrPct) : null;

  // ── Volume ─────────────────────────────────────────────────────────────────
  // volZ is an object {z, ratio, highAnomaly, medAnomaly, stealth}
  const volZObj  = typeof raw.volZ === 'object' ? raw.volZ : null;
  const volZNum  = volZObj ? parseFloat(volZObj.z ?? 0) : parseFloat(raw.volZ ?? raw.volZScore ?? 0);
  // volRatio = actual multiplier vs average (e.g. 2.5 = 2.5× avg volume)
  const volRatio = parseFloat(
    raw.volRatio ?? raw.volumeRatio ?? raw.volMult ??
    volZObj?.ratio ??   // scanner's volZ.ratio is the real volume multiplier
    1
  );

  // ── Order book ─────────────────────────────────────────────────────────────
  // Regular signals: scanner exports ob = { bids, asks, imbalance, bwr, awr }
  // Pre-pump signals: scanner exports obRatio as a string, bidDepthUSDT, askDepthUSDT
  const obRaw   = raw.ob ?? raw.orderBook ?? null;
  const obBids  = raw.bidDepthUSDT ?? raw.obBids ?? 0;
  const obAsks  = raw.askDepthUSDT ?? raw.obAsks ?? 0;

  // Compute ratio: bid USDT depth / ask USDT depth (regular signal uses imbalance → ratio)
  // imbalance = bids/(bids+asks) so ratio = imbalance / (1 - imbalance)
  let obRatio = parseFloat(raw.obRatio ?? raw.orderBookRatio ?? raw.bidAskRatio ?? 0);
  if (!obRatio && obRaw?.imbalance != null) {
    const imb = parseFloat(obRaw.imbalance);
    obRatio = imb > 0 && imb < 1 ? +(imb / (1 - imb)).toFixed(2) : 1;
  }
  if (!obRatio && obBids && obAsks) {
    obRatio = +(obBids / obAsks).toFixed(2);
  }

  const bidDominance = obRatio > 0 ? Math.round((obRatio / (obRatio + 1)) * 100) : 0;

  // ── Absorption ─────────────────────────────────────────────────────────────
  // smAbsorb = { absorptionScore: 0-100 }  (pre-pump)
  // _instLayer.hiddenFlow.confidence       (regular signal, via _instLayer)
  const absorption =
    raw.smAbsorb?.absorptionScore                ??
    raw._instLayer?.hiddenFlow?.confidence       ??
    raw.absorption ?? raw.absorptionScore        ?? 0;

  // ── Institutional scores ───────────────────────────────────────────────────
  // instGrade.iScore for regular signals; instConfidence for pre-pump
  const iScore = Math.round(Math.max(0, Math.min(100,
    raw.instGrade?.iScore   ??
    raw.instConfidence      ??
    raw.confidence          ?? 50
  )));

  const breakoutScore = raw.baResult?.acceptanceScore ?? raw.breakoutScore ?? raw.fbScore ?? 50;

  // ── Signals array ──────────────────────────────────────────────────────────
  // Regular signal: r.signals; Pre-pump: r.prePumpSignals
  const signals  = Array.isArray(raw.signals)        ? raw.signals
                 : Array.isArray(raw.prePumpSignals)  ? raw.prePumpSignals
                 : [];
  const sigStr   = signals.map(s => String(s).toLowerCase()).join(' ');

  // ── Expansion ──────────────────────────────────────────────────────────────
  const expansionType    = raw.ppExpansion ?? raw.expansionType ?? raw.expansion?.expansionType ?? '';
  const expansionTypeKey = deriveExpansionKey(expansionType);

  // ── Classification ─────────────────────────────────────────────────────────
  const classification = deriveClassification(raw, iScore, expansionType);

  // ── Derived institutional fields ───────────────────────────────────────────
  const hiddenFlowType = deriveHiddenFlowType(raw, sigStr, absorption, volZNum, volRatio);
  const mmTrap         = raw._instLayer?.mmTrap?.trap
    ?? raw.mmTrap ?? raw.isTrap
    ?? ((breakoutScore < 30 && iScore < 50) || sigStr.includes('fake') || sigStr.includes('trap'));
  const verdict        = raw._instLayer?.verdict?.verdict
    ?? raw.verdict ?? raw.instVerdict
    ?? deriveVerdict(iScore, mmTrap);
  const tfConflict     = raw._instLayer?.tfHierarchy?.conflictType
    ?? raw.tfConflict
    ?? deriveTFConflict(hurst, tsmom, sigStr);
  const signalClarity  = mmTrap         ? 'DANGEROUS'
                       : obRatio < 0.8  ? 'CONFLICTED'
                       : iScore >= 70   ? 'CLEAR'
                       : 'EXPLAINABLE';

  const isSpring   = raw.spring?.spring  ?? sigStr.includes('spring') ?? false;
  const isShakeout = raw._instLayer?.shakeout?.shakeout ?? sigStr.includes('shakeout') ?? false;
  const isFake     = raw.fbCheck?.isFake ?? (breakoutScore < 40);
  const brokeHigh  = raw.fbCheck?.brokeHigh ?? (raw.baResult?.acceptance === 'ACCEPTED');
  const explosionScore = raw.explosionReadiness?.score ?? iScore;

  // ─── UNIFIED RESULT ───────────────────────────────────────────────────────
  return {
    symbol,
    entry,
    sl,
    tp1,
    tp2,
    moonPrice,
    confirmAbove,
    hurst,
    tsmom,
    atrPct,
    volRatio,
    session,
    sessionWeight,
    triggerDistance,
    classification,

    instGrade: {
      iScore,
      hurst,
      tsmom,
      atrPct,
      obRatio,
      session,
      grade        : raw.instGrade?.grade ?? null,
      checklistScore: raw.score ?? raw.prePumpScore ?? null,
    },

    _instLayer: raw._instLayer ?? {
      hiddenFlow : { type: hiddenFlowType, confidence: absorption },
      mmTrap     : { trap: Boolean(mmTrap) },
      verdict    : { verdict },
      tfHierarchy: {
        conflictType : tfConflict,
        tf15m        : raw.tf15m ?? { trend: tsmomBullish ? 'bullish' : 'neutral' },
        tf1h         : raw.tf1h  ?? { trend: (hurst ?? 0) >= 0.8 ? 'bullish' : 'neutral' },
        tf4h         : raw.tf4h  ?? { trend: null },
      },
      shakeout   : { shakeout: isShakeout },
      conflicts  : { signalClarity },
    },

    volZ: {
      ratio       : volZObj?.ratio != null ? parseFloat(volZObj.ratio) : volRatio, // actual multiplier e.g. 2.5x
      z           : volZNum,                                                        // z-score
      highAnomaly : volZObj?.highAnomaly ?? (volZNum >= 3),
      medAnomaly  : volZObj?.medAnomaly  ?? (volZNum >= 1.5 && volZNum < 3),
      stealth     : volZObj?.stealth     ?? (absorption >= 60 && volZNum < 1.0),
    },

    orderBook: {
      ratio        : obRatio,
      bids         : obBids,
      asks         : obAsks,
      bidDominance,
    },

    spring          : { spring: isSpring, score: raw.spring?.score ?? 0 },
    fbCheck         : { isFake, brokeHigh, vwap: raw.fbCheck?.vwap ?? null },
    explosionReadiness: { score: Math.round(explosionScore) },
    candleEnergy    : raw.candleEnergy ?? raw.compressionScore?.bars ?? null,
    expansion       : { expansionType, expansionTypeKey },
    signals,

    // Preserve fields signalBridge reads directly from raw
    volIntent      : raw.volIntent,
    lf             : raw.lf,
    momentum       : raw.momentum,
    change24h      : raw.change24h,

    _raw: raw,
  };
}

// ─── DERIVATION HELPERS ───────────────────────────────────────────────────────

function deriveVerdict(iScore, trap) {
  if (trap)         return 'AVOID';
  if (iScore >= 85) return 'HIGH_CONVICTION';
  if (iScore >= 65) return 'BUY';
  if (iScore >= 50) return 'WATCH';
  if (iScore >= 35) return 'WAIT';
  return 'AVOID';
}

function deriveTFConflict(hurst, tsmom, sigStr) {
  if ((hurst ?? 0) >= 0.85 && (tsmom ?? 0) >= 0.8) return 'FULL_ALIGNMENT';
  if (sigStr.includes('pullback') || sigStr.includes('dip')) return 'LOCAL_PULLBACK';
  if (sigStr.includes('bearish')  || sigStr.includes('conflict')) return 'FULL_BEARISH';
  return 'UNKNOWN';
}

function deriveHiddenFlowType(raw, sigStr, absorption, volZNum, volRatio) {
  if (raw._instLayer?.hiddenFlow?.type) return raw._instLayer.hiddenFlow.type;

  const sellerSignals = sigStr.includes('hidden seller') || sigStr.includes('distribution') ||
    sigStr.includes('vol intent: distribution');
  if (sellerSignals) return 'HIDDEN_SELLER';

  const buyerSignals = sigStr.includes('hidden buyer') || sigStr.includes('strong buying') ||
    sigStr.includes('absorption') || sigStr.includes('smart money') || absorption >= 50;
  if (buyerSignals) return 'HIDDEN_BUYER';

  return null;
}

function deriveClassification(raw, iScore, expansionType) {
  const c = String(raw.classification ?? raw.instClass ?? '').toUpperCase();
  if (c.includes('EXPLOSIVE') || iScore >= 90) return 'EXPLOSIVE';
  if (c.includes('STRONG')    || iScore >= 70) return 'STRONG';
  if (c.includes('EARLY')     || iScore >= 50) return 'EARLY';
  if (c.includes('ACCUM'))                     return 'ACCUM';
  if (expansionType.toUpperCase().includes('DELAYED')) return 'ACCUM';
  return 'EARLY';
}

function deriveExpansionKey(expansionType) {
  const u = String(expansionType ?? '').toUpperCase();
  if (u.includes('MICRO'))   return 'MICRO';
  if (u.includes('STRONG'))  return 'STRONG';
  if (u.includes('DELAYED')) return 'DELAYED';
  if (u.includes('MOON'))    return 'MOON';
  return 'CONTROLLED';
}

module.exports = { adapt };
