// Motor de señales del bot — DETERMINISTA a propósito.
//
// La IA ya hizo el trabajo pesado (zonas, POI, invalidación y objetivos) y ese
// resultado vive cacheado en Blobs. El bot NO llama a la IA en cada ciclo: eso
// quemaría la cuota gratuita en horas y, peor, haría que la misma situación de
// mercado produjera decisiones distintas. Acá solo se aplican reglas fijas y
// auditables sobre esas zonas + el sesgo multi-temporal.
import { timeframeBias, detectStructure } from "../../../src/ros/structure.js";
import { compositeBias } from "../../../src/ros/decisionEngine.js";

const BINANCE = "https://api.binance.com/api/v3";

async function klines(symbol, interval, limit) {
  const res = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`klines ${symbol} ${interval}: HTTP ${res.status}`);
  const j = await res.json();
  return j.map((c) => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
}

/** Sesgo y gatillos de un símbolo, calculados sobre el mercado REAL. */
export async function analyzeSymbol(symbol, zone) {
  const [c4h, c1d, c1w, c1M] = await Promise.all([
    klines(symbol, "4h", 200),
    klines(symbol, "1d", 200),
    klines(symbol, "1w", 120),
    klines(symbol, "1M", 60),
  ]);
  const timeframes = {
    h4: timeframeBias(c4h), d1: timeframeBias(c1d),
    w1: timeframeBias(c1w), mn: timeframeBias(c1M),
  };
  const poi = zone?.zones?.find((z) => z.kind === "poi");
  const stopLine = zone?.lines?.find((l) => l.kind === "stop");
  const triggers = detectStructure(c4h, poi?.from, stopLine?.price);
  const price = c4h[c4h.length - 1].c;
  return { timeframes, triggers, price, bias: compositeBias(timeframes) };
}

/**
 * Decide si hay operación para un símbolo.
 * Devuelve siempre un motivo, haya señal o no: la bitácora tiene que explicar
 * por qué el bot NO operó tanto como por qué sí.
 * Los niveles salen como PORCENTAJES respecto al precio de análisis, para que
 * al ejecutar se apliquen sobre el precio del broker (el testnet puede
 * divergir del mercado real y los niveles absolutos quedarían inservibles).
 */
export function buildSignal({ symbol, analysis, zone, config }) {
  const { bias, triggers, price } = analysis;
  const reject = (reason) => ({ symbol, action: "none", reason, score: bias.score, alignment: bias.alignment });

  if (!zone?.zones?.length) return reject("sin zonas IA vigentes para definir stop y objetivo");
  if (Math.abs(bias.score) < config.minScore) {
    return reject(`sesgo ${bias.score >= 0 ? "+" : ""}${bias.score} por debajo del mínimo ${config.minScore}`);
  }
  if (bias.alignment < config.minAlignment) {
    return reject(`alineación ${bias.alignment}% bajo el mínimo ${config.minAlignment}%`);
  }
  const trigger = triggers?.choch || triggers?.bos || triggers?.liquiditySweep;
  if (!trigger) return reject("sin gatillo en 4H (CHoCH / BOS / barrido)");

  const long = bias.score > 0;
  if (!long && !config.allowShorts) return reject("sesgo bajista y los cortos están desactivados");

  const poi = zone.zones.find((z) => z.kind === "poi");
  const target = zone.zones.find((z) => z.kind === "target");
  const stopLine = zone.lines?.find((l) => l.kind === "stop");
  if (!poi || !stopLine) return reject("las zonas no traen POI o línea de invalidación");

  let stop, tp;
  if (long) {
    stop = stopLine.price;
    tp = target ? (target.from + target.to) / 2 : null;
    if (stop >= price) return reject("la invalidación quedó por encima del precio: tesis rota");
    // No perseguir: si el precio ya voló muy por encima del POI, se espera.
    const chase = ((price - poi.to) / poi.to) * 100;
    if (chase > config.maxChasePct) {
      return reject(`precio ${chase.toFixed(1)}% sobre el POI (máx. ${config.maxChasePct}%): perseguir, no`);
    }
  } else {
    // En corto la invalidación estructural va por encima; si la IA solo dio la
    // de abajo, se usa el techo de la zona de liquidez como stop.
    stop = target ? target.to : null;
    tp = poi ? (poi.from + poi.to) / 2 : null;
    if (!stop || stop <= price) return reject("sin nivel de invalidación válido por encima para el corto");
  }
  if (!tp) return reject("sin objetivo definido en las zonas");

  const riskDist = Math.abs(price - stop);
  const rewardDist = Math.abs(tp - price);
  if (riskDist <= 0) return reject("distancia al stop nula");
  const rr = rewardDist / riskDist;
  if (rr < config.minRR) return reject(`R:R ${rr.toFixed(2)} bajo el mínimo ${config.minRR}`);

  return {
    symbol,
    action: long ? "long" : "short",
    side: long ? "BUY" : "SELL",
    reason: `sesgo ${bias.score >= 0 ? "+" : ""}${bias.score} (${bias.alignment}% alineado) con ${[
      triggers.choch && "CHoCH", triggers.bos && "BOS", triggers.liquiditySweep && "barrido",
    ].filter(Boolean).join(" + ")} · R:R ${rr.toFixed(2)}`,
    score: bias.score,
    alignment: bias.alignment,
    rr: Number(rr.toFixed(2)),
    refPrice: price,
    // Distancias relativas: se aplican sobre el precio real del broker.
    stopPct: riskDist / price,
    targetPct: rewardDist / price,
    levels: { refStop: stop, refTarget: tp, poi: [poi.from, poi.to] },
  };
}
