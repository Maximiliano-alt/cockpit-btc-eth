import { LIMITS, MARKET_PHASE, TRAFFIC_LIGHT, TRADING_MODE } from "./types.js";

/** @param {import('./types.js').PortfolioState} portfolio */
export function computeRiskMetrics(portfolio) {
  const { accountBalance, maxRiskPerTradePct, maxPortfolioRiskPct, positions } = portfolio;
  const maxRiskPerTrade = (accountBalance * maxRiskPerTradePct) / 100;
  const maxPortfolioRisk = (accountBalance * maxPortfolioRiskPct) / 100;
  const currentPortfolioRisk = positions.reduce((s, p) => s + (p.riskUsd || 0), 0);
  const availableRisk = Math.max(0, maxPortfolioRisk - currentPortfolioRisk);
  const riskUtilPct = maxPortfolioRisk > 0 ? (currentPortfolioRisk / maxPortfolioRisk) * 100 : 0;
  return {
    accountBalance,
    maxRiskPerTradePct,
    maxPortfolioRiskPct,
    maxRiskPerTrade,
    maxPortfolioRisk,
    currentPortfolioRisk,
    availableRisk,
    riskUtilPct,
  };
}

export function computeExposure(portfolio) {
  const { accountBalance, exposedCapital } = portfolio;
  const pct = accountBalance > 0 ? (exposedCapital / accountBalance) * 100 : 0;
  let status = "SEGURO";
  let tone = "good";
  let blockNewEntries = false;
  if (pct > 80) { status = "BLOQUEADO"; tone = "danger"; blockNewEntries = true; }
  else if (pct > 60) { status = "ELEVADO"; tone = "danger"; }
  else if (pct > 30) { status = "MODERADO"; tone = "warn"; }
  return { exposedCapital, pct, status, tone, blockNewEntries };
}

/** @param {object} ctx */
export function classifyMarketPhase(ctx) {
  const {
    btc, eth, fg, onchain, etf, derivs, daily, macro, structure, btcCfg, ethCfg,
  } = ctx;

  const fgVal = fg?.value ?? 50;
  const mvrv = onchain?.mvrvz?.value;
  const puell = onchain?.puell?.value;
  const cycleHit = onchain?.cycleTop?.hit ?? 0;
  const etfBtc = etf?.btc?.total ?? 0;
  const fundingBtc = derivs?.BTCUSDT?.funding ?? 0;
  const mayer = daily?.mayer;
  const dxyUp = (macro?.dxy?.changePct ?? 0) > 0.2;
  const spUp = (macro?.sp500?.changePct ?? 0) > 0.3;

  const reasons = [];
  let score = { acc: 0, exp: 0, dist: 0, manip: 0 };

  const poiMid = btcCfg?.poi ? (btcCfg.poi.lo + btcCfg.poi.hi) / 2 : null;
  const nearPoi = poiMid && btc ? Math.abs(btc - poiMid) / poiMid < 0.06 : false;
  const abovePoi = poiMid && btc ? btc > (btcCfg.poi?.hi ?? poiMid) : false;
  const ethWeak = ethCfg?.poi && eth
    ? eth < ethCfg.poi.lo * 0.98
    : (pricesChange(ctx) ? ctx.ethChange < ctx.btcChange - 1 : false);

  if (mvrv != null && mvrv < 1) { score.acc += 2; reasons.push("MVRV-Z infravalorado."); }
  if (puell != null && puell < 1) { score.acc += 1; reasons.push("Puell bajo — acumulación on-chain."); }
  if (fgVal <= 30) { score.acc += 1; reasons.push("Fear elevado — contexto de acumulación."); }
  if (nearPoi && !structure?.choch4h) { score.acc += 1; reasons.push("Precio cerca del POI."); }

  if (etfBtc > 50) { score.exp += 2; reasons.push("Flujos ETF BTC positivos."); }
  if (structure?.bos4h || structure?.htfBullish) { score.exp += 2; reasons.push("Estructura HTF constructiva."); }
  if (abovePoi && structure?.choch4h) { score.exp += 1; reasons.push("CHoCH confirmado sobre POI."); }
  if (spUp && !dxyUp) { score.exp += 1; reasons.push("Risk-on macro (SP500)."); }

  if (cycleHit >= 3) { score.dist += 3; reasons.push("Indicadores de techo de ciclo activos."); }
  if (fgVal >= 75) { score.dist += 2; reasons.push("Euforia en Fear & Greed."); }
  if (fundingBtc > 0.03) { score.dist += 1; reasons.push("Funding elevado — apalancamiento long."); }
  if (mayer != null && mayer > 1.4) { score.dist += 1; reasons.push("Mayer Multiple extendido."); }

  if (!structure?.choch4h) { score.manip += 2; reasons.push("Sin CHoCH confirmado."); }
  if (nearPoi || abovePoi) { score.manip += 1; reasons.push(btcCfg?.poi ? "BTC en/defendiendo POI." : "BTC sin POI IA — precaución."); }
  if (ethWeak) { score.manip += 1; reasons.push("ETH débil vs estructura."); }
  if (fgVal <= 25) { score.manip += 1; reasons.push("Fear extremo — posible barrido."); }
  if (fundingBtc < 0) { score.manip += 1; reasons.push("Funding negativo."); }

  const entries = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const top = entries[0][1] === 0 ? "manip" : entries[0][0];
  const phaseMap = {
    acc: MARKET_PHASE.ACCUMULATION,
    exp: MARKET_PHASE.EXPANSION,
    dist: MARKET_PHASE.DISTRIBUTION,
    manip: MARKET_PHASE.MANIPULATION,
  };
  const phase = phaseMap[top] || MARKET_PHASE.MANIPULATION;

  const phaseLabel = {
    [MARKET_PHASE.ACCUMULATION]: "ACUMULACIÓN",
    [MARKET_PHASE.EXPANSION]: "EXPANSIÓN",
    [MARKET_PHASE.DISTRIBUTION]: "DISTRIBUCIÓN",
    [MARKET_PHASE.MANIPULATION]: "MANIPULACIÓN",
  }[phase];

  return { phase, phaseLabel, reasons: reasons.slice(0, 6) };
}

function pricesChange(ctx) {
  return ctx.btcChange != null && ctx.ethChange != null;
}

/** Regla no negociable: sin asimetría HTF + liquidez + macro => NO_TRADE */
export function runDecisionEngine(ctx) {
  const {
    structure, marketPhase, riskMetrics, exposure, portfolio,
    macroBullish, hasClearAsymmetry,
  } = ctx;

  const hasOpen = portfolio.positions.length > 0;
  const riskOk = riskMetrics.availableRisk > 0 && !exposure.blockNewEntries;
  const choch = structure?.choch4h === true;
  const sweep = structure?.liquiditySweep === true;
  const weekly = structure?.weeklyBullish === true;
  const monthly = structure?.monthlyBullish === true;
  const macro = macroBullish === true;

  let mode = TRADING_MODE.NO_TRADE;
  let rationale = "Sin asimetría clara HTF + liquidez + macro. Inacción preferida.";

  if (hasOpen) {
    mode = TRADING_MODE.MANAGE;
    rationale = "Hay posición(es) abierta(s). Hoy es día de gestión, no de nuevas entradas.";
  } else if (!hasClearAsymmetry || !riskOk) {
    mode = TRADING_MODE.NO_TRADE;
    rationale = exposure.blockNewEntries
      ? "Exposición >80% — bloqueadas nuevas entradas."
      : "Riesgo disponible agotado o sin asimetría — no operar.";
  } else if (macro && weekly && monthly) {
    mode = TRADING_MODE.POSITION;
    rationale = "Macro + semanal + mensual alineados — ventana de posición (con filtro R:R).";
  } else if (choch && sweep && riskMetrics.availableRisk > 0) {
    mode = TRADING_MODE.SWING;
    rationale = "CHoCH + barrido de liquidez + riesgo disponible — swing condicionado.";
  } else if (!choch && marketPhase.phase === MARKET_PHASE.MANIPULATION) {
    mode = TRADING_MODE.NO_TRADE;
    rationale = "Fase manipulación sin CHoCH — esperar confirmación estructural.";
  }

  return { mode, rationale };
}

export function computeTrafficLight(tradingMode, blockers) {
  if (blockers.length > 0 || tradingMode === TRADING_MODE.NO_TRADE) {
    return { light: TRAFFIC_LIGHT.WAIT, label: "NO HACER NADA", emoji: "🔴" };
  }
  if (tradingMode === TRADING_MODE.MANAGE) {
    return { light: TRAFFIC_LIGHT.MANAGE, label: "GESTIONAR", emoji: "🟡" };
  }
  return { light: TRAFFIC_LIGHT.ACT, label: "ACTUAR", emoji: "🟢" };
}

export function computeAntiFomo(ctx) {
  const { btc, eth, btcCfg, ethCfg, fg, structure } = ctx;
  const blocks = [];

  if (btcCfg?.poi?.hi && btc != null && btc > btcCfg.poi.hi && !structure?.choch4h) {
    blocks.push({ id: "chase", text: "PROHIBIDO PERSEGUIR PRECIO", detail: "BTC por encima del POI sin CHoCH." });
  }
  if (ethCfg?.poi && eth != null) {
    const mid = (ethCfg.poi.lo + ethCfg.poi.hi) / 2;
    if (mid > 0 && (eth - mid) / mid > 0.08) {
      blocks.push({ id: "fomo", text: "FOMO DETECTADO", detail: "ETH >8% por encima del POI." });
    }
  }
  if (fg?.value != null && fg.value < 20) {
    blocks.push({ id: "fear", text: "MIEDO EXTREMO NO SIGNIFICA COMPRAR", detail: `Fear & Greed ${fg.value}.` });
  }
  if (exposureBlock(ctx.exposure)) {
    blocks.push({ id: "exposure", text: "EXPOSICIÓN MÁXIMA", detail: "No abrir nuevas posiciones." });
  }

  return blocks;
}

function exposureBlock(exposure) {
  return exposure?.blockNewEntries === true;
}

export function computeAllowedTrades(portfolio, tradingMode, exposure) {
  const swings = portfolio.positions.filter((p) => p.type === "swing").length;
  const positions = portfolio.positions.filter((p) => p.type === "position").length;
  const total = portfolio.positions.length;

  const swingSlots = Math.max(0, LIMITS.maxSwingTrades - swings);
  const positionSlots = Math.max(0, LIMITS.maxPositionTrades - positions);
  const simSlots = Math.max(0, LIMITS.maxSimultaneous - total);

  let newEntries = Math.min(swingSlots, positionSlots, simSlots);
  if (exposure.blockNewEntries || tradingMode === TRADING_MODE.NO_TRADE) newEntries = 0;
  if (tradingMode === TRADING_MODE.MANAGE) newEntries = 0;

  return {
    maxPositionTrades: LIMITS.maxPositionTrades,
    maxSwingTrades: LIMITS.maxSwingTrades,
    maxSimultaneous: LIMITS.maxSimultaneous,
    maxRiskPct: portfolio.maxPortfolioRiskPct,
    currentSwings: swings,
    currentPositions: positions,
    newEntriesAvailable: newEntries,
  };
}

export function deriveBias(marketPhase, structure) {
  if (marketPhase.phase === MARKET_PHASE.ACCUMULATION) return "Neutral alcista (acumulación)";
  if (marketPhase.phase === MARKET_PHASE.EXPANSION) return "Alcista";
  if (marketPhase.phase === MARKET_PHASE.DISTRIBUTION) return "Neutral bajista / distribución";
  if (structure?.trend === "bearish") return "Neutral bajista";
  return "Neutral — esperar estructura";
}

export function modeLabel(mode) {
  const map = {
    [TRADING_MODE.NO_TRADE]: "NO_TRADE",
    [TRADING_MODE.MANAGE]: "MANAGE",
    [TRADING_MODE.SWING]: "SWING",
    [TRADING_MODE.POSITION]: "POSITION",
  };
  return map[mode] || mode;
}

export function modeDescription(mode) {
  const map = {
    [TRADING_MODE.NO_TRADE]: "Hoy no operar. Preservar capital.",
    [TRADING_MODE.MANAGE]: "Hoy es día de gestión. No abrir nuevas posiciones.",
    [TRADING_MODE.SWING]: "Ventana swing condicionada — pasar por filtro R:R.",
    [TRADING_MODE.POSITION]: "Ventana de posición macro — tamaño conservador.",
  };
  return map[mode] || "";
}

export function riskTone(riskUtilPct) {
  if (riskUtilPct > 80) return "danger";
  if (riskUtilPct >= 50) return "warn";
  return "good";
}

export function exposureTone(tone) {
  return tone;
}
