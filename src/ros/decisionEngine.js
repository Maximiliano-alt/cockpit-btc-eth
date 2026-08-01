import { MARKET_PHASE, TRADING_MODE } from "./types.js";

// Peso de cada temporalidad en el sesgo compuesto. El diario y el semanal
// mandan (son los que definen la tesis); el 4H solo afina el timing.
const TF_WEIGHTS = { h4: 0.15, d1: 0.35, w1: 0.30, mn: 0.20 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Puntaje de valuación a partir de las métricas de ciclo/on-chain.
 * +100 = históricamente barato · -100 = históricamente caro.
 */
export function valuationScore({ onchain, daily }) {
  const parts = {};
  const mvrv = onchain?.mvrvz?.value;
  const puell = onchain?.puell?.value;
  const mayer = daily?.mayer;
  const rsi22 = daily?.rsi22;

  if (mvrv != null) parts.mvrv = clamp((2.5 - mvrv) * 18, -45, 45);
  if (puell != null) parts.puell = clamp((1.2 - puell) * 30, -30, 30);
  if (mayer != null) parts.mayer = clamp((1.1 - mayer) * 60, -30, 30);
  if (rsi22 != null) parts.rsi22 = clamp((50 - rsi22) * 0.6, -20, 20);

  const vals = Object.values(parts);
  if (!vals.length) return { score: 0, parts };
  return { score: clamp(Math.round(vals.reduce((a, b) => a + b, 0)), -100, 100), parts };
}

/** Sesgo compuesto entre temporalidades + medida de alineación. */
export function compositeBias(timeframes) {
  let sum = 0, wsum = 0;
  const scores = [];
  for (const [k, w] of Object.entries(TF_WEIGHTS)) {
    const s = timeframes?.[k]?.score;
    if (typeof s === "number") { sum += s * w; wsum += w; scores.push(s); }
  }
  if (!wsum) return { score: 0, alignment: 0, agree: 0, total: 0 };
  const score = Math.round(sum / wsum);
  const positives = scores.filter((s) => s >= 15).length;
  const negatives = scores.filter((s) => s <= -15).length;
  const agree = Math.max(positives, negatives);
  // 0 = temporalidades peleadas · 100 = todas apuntando al mismo lado.
  const alignment = scores.length ? Math.round((agree / scores.length) * 100) : 0;
  return { score, alignment, agree, total: scores.length, direction: positives >= negatives ? 1 : -1 };
}

/** @param {object} ctx */
export function classifyMarketPhase(ctx) {
  const { fg, onchain, etf, derivs, timeframes, daily } = ctx;
  const bias = compositeBias(timeframes);
  const val = valuationScore({ onchain, daily });

  const fgVal = fg?.value ?? 50;
  const cycleHit = onchain?.cycleTop?.hit ?? 0;
  const funding = derivs?.BTCUSDT?.funding ?? 0;
  const etfBtc = etf?.btc?.total ?? 0;

  const reasons = [];
  let phase;

  const euforia = cycleHit >= 3 || (fgVal >= 75 && funding > 0.03);

  if (euforia) {
    phase = MARKET_PHASE.DISTRIBUTION;
    reasons.push(cycleHit >= 3
      ? `${cycleHit} indicadores de techo de ciclo activos.`
      : `Euforia: Fear&Greed ${fgVal} con funding ${funding.toFixed(4)}%.`);
  } else if (bias.score >= 25) {
    phase = MARKET_PHASE.EXPANSION;
    reasons.push(`Sesgo compuesto +${bias.score} — tendencia al alza en marcha.`);
  } else if (bias.score <= -25) {
    // Cayendo y barato = acumulación; cayendo y caro = distribución.
    phase = val.score >= 15 ? MARKET_PHASE.ACCUMULATION : MARKET_PHASE.DISTRIBUTION;
    reasons.push(`Sesgo compuesto ${bias.score} — presión bajista dominante.`);
    reasons.push(val.score >= 15
      ? `Valuación ${val.score > 0 ? "+" : ""}${val.score}: zona históricamente barata.`
      : `Valuación ${val.score}: sin descuento que justifique acumular.`);
  } else {
    phase = MARKET_PHASE.MANIPULATION;
    reasons.push(`Sesgo compuesto ${bias.score >= 0 ? "+" : ""}${bias.score} con alineación ${bias.alignment}% — rango / temporalidades peleadas.`);
  }

  // Contexto que suma matiz sin decidir la fase.
  if (timeframes?.w1 && timeframes?.d1) {
    reasons.push(`Semanal ${timeframes.w1.label} (${timeframes.w1.score >= 0 ? "+" : ""}${timeframes.w1.score}) · Diario ${timeframes.d1.label} (${timeframes.d1.score >= 0 ? "+" : ""}${timeframes.d1.score}).`);
  }
  if (fgVal <= 25) reasons.push(`Fear&Greed ${fgVal}: miedo extremo, contexto contrarian.`);
  else if (fgVal >= 70) reasons.push(`Fear&Greed ${fgVal}: codicia, subir la cautela.`);
  if (Math.abs(etfBtc) > 50) {
    reasons.push(`Flujos ETF BTC ${etfBtc >= 0 ? "+" : ""}${etfBtc.toFixed(0)}M — ${etfBtc >= 0 ? "demanda institucional" : "salidas institucionales"}.`);
  }
  if (funding < 0) reasons.push(`Funding negativo (${funding.toFixed(4)}%): los cortos pagan.`);

  const phaseLabel = {
    [MARKET_PHASE.ACCUMULATION]: "ACUMULACIÓN",
    [MARKET_PHASE.EXPANSION]: "EXPANSIÓN",
    [MARKET_PHASE.DISTRIBUTION]: "DISTRIBUCIÓN",
    [MARKET_PHASE.MANIPULATION]: "RANGO / MANIPULACIÓN",
  }[phase];

  return { phase, phaseLabel, reasons: reasons.slice(0, 6), bias, valuation: val };
}

/**
 * Veredicto del día. Ya no depende de banderas booleanas rígidas: usa el
 * sesgo compuesto graduado, la alineación entre temporalidades y los gatillos
 * de la temporalidad de ejecución.
 */
export function computeDailyVerdict({ timeframes, triggers, marketPhase, macroBullish, hasZones }) {
  const bias = marketPhase?.bias || compositeBias(timeframes);
  const trigger = !!(triggers?.choch || triggers?.bos || triggers?.liquiditySweep);
  const dir = bias.score >= 0 ? "alcista" : "bajista";
  const strength = Math.abs(bias.score);

  const detail = {
    composite: bias.score,
    alignment: bias.alignment,
    trigger,
    macro: !!macroBullish,
    timeframes,
  };

  if (!timeframes || !timeframes.d1) {
    return { mode: TRADING_MODE.NO_TRADE, rationale: "Sin datos de estructura todavía.", detail };
  }
  if (!hasZones) {
    return {
      mode: TRADING_MODE.NO_TRADE,
      rationale: "Sin zonas IA vigentes: no hay dónde poner stop ni objetivo, así que no hay operación definible.",
      detail,
    };
  }
  if (strength < 15) {
    return {
      mode: TRADING_MODE.NO_TRADE,
      rationale: `Sesgo compuesto ${bias.score >= 0 ? "+" : ""}${bias.score} (rango) con alineación ${bias.alignment}%. Sin dirección clara, la inacción es la posición.`,
      detail,
    };
  }
  if (strength >= 40 && bias.alignment >= 75 && trigger) {
    return {
      mode: TRADING_MODE.POSITION,
      rationale: `Sesgo ${dir} fuerte (${bias.score}) con ${bias.alignment}% de las temporalidades alineadas y gatillo confirmado en 4H. Ventana de posición.`,
      detail,
    };
  }
  if (strength >= 25 && trigger) {
    return {
      mode: TRADING_MODE.SWING,
      rationale: `Sesgo ${dir} (${bias.score}) con gatillo en 4H (${[triggers?.choch && "CHoCH", triggers?.bos && "BOS", triggers?.liquiditySweep && "barrido"].filter(Boolean).join(" + ")}). Swing condicionado.`,
      detail,
    };
  }
  if (strength >= 25) {
    return {
      mode: TRADING_MODE.WAIT_TRIGGER,
      rationale: `Sesgo ${dir} (${bias.score}) pero sin gatillo en 4H. La tesis está, falta el momento de entrada.`,
      detail,
    };
  }
  return {
    mode: TRADING_MODE.NO_TRADE,
    rationale: `Sesgo ${dir} débil (${bias.score}) y alineación ${bias.alignment}%. No compensa el riesgo.`,
    detail,
  };
}

export function modeLabel(mode) {
  return {
    [TRADING_MODE.NO_TRADE]: "NO_TRADE",
    [TRADING_MODE.WAIT_TRIGGER]: "ESPERAR GATILLO",
    [TRADING_MODE.SWING]: "SWING",
    [TRADING_MODE.POSITION]: "POSITION",
  }[mode] || mode;
}

export function modeDescription(mode) {
  return {
    [TRADING_MODE.NO_TRADE]: "Hoy no operar. Preservar capital.",
    [TRADING_MODE.WAIT_TRIGGER]: "Tesis válida, sin gatillo. Vigilar el 4H.",
    [TRADING_MODE.SWING]: "Ventana swing condicionada — tamaño normal.",
    [TRADING_MODE.POSITION]: "Todas las temporalidades alineadas. Ventana de posición.",
  }[mode] || "";
}
