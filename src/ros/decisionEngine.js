import { MARKET_PHASE, TRADING_MODE } from "./types.js";

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

/**
 * Veredicto del día a partir de TODAS las temporalidades (4H + semanal +
 * mensual) más el contexto macro — sin depender de portafolio/riesgo manual.
 */
export function computeDailyVerdict({ structure, marketPhase, macroBullish }) {
  const choch = structure?.choch4h === true;
  const bos = structure?.bos4h === true;
  const sweep = structure?.liquiditySweep === true;
  const weekly = structure?.weeklyBullish === true;
  const monthly = structure?.monthlyBullish === true;
  const macro = macroBullish === true;

  const timeframes = { h4: choch || bos, weekly, monthly, macro };
  const alignedCount = Object.values(timeframes).filter(Boolean).length;

  if (!structure) {
    return { mode: TRADING_MODE.NO_TRADE, rationale: "Sin datos de estructura todavía.", timeframes };
  }
  if (marketPhase?.phase === MARKET_PHASE.MANIPULATION && !choch) {
    return { mode: TRADING_MODE.NO_TRADE, rationale: "Fase de manipulación sin CHoCH confirmado — esperar.", timeframes };
  }
  if (macro && weekly && monthly && (choch || bos)) {
    return { mode: TRADING_MODE.POSITION, rationale: "4H, semanal, mensual y macro alineados — ventana de posición (filtro R:R obligatorio).", timeframes };
  }
  if (choch && sweep) {
    return { mode: TRADING_MODE.SWING, rationale: "CHoCH + barrido de liquidez en 4H — swing condicionado, falta confirmación HTF completa.", timeframes };
  }
  if (alignedCount >= 3) {
    return { mode: TRADING_MODE.SWING, rationale: "Mayoría de temporalidades alineadas, pero sin gatillo de entrada (CHoCH + barrido) en 4H todavía.", timeframes };
  }
  return { mode: TRADING_MODE.NO_TRADE, rationale: "Sin asimetría clara entre temporalidades — inacción preferida.", timeframes };
}

export function modeLabel(mode) {
  const map = {
    [TRADING_MODE.NO_TRADE]: "NO_TRADE",
    [TRADING_MODE.SWING]: "SWING",
    [TRADING_MODE.POSITION]: "POSITION",
  };
  return map[mode] || mode;
}

export function modeDescription(mode) {
  const map = {
    [TRADING_MODE.NO_TRADE]: "Hoy no operar. Preservar capital.",
    [TRADING_MODE.SWING]: "Ventana swing condicionada — confirmar estructura antes de ejecutar.",
    [TRADING_MODE.POSITION]: "Ventana de posición: todas las temporalidades alineadas. Tamaño conservador.",
  };
  return map[mode] || "";
}
