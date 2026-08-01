// Lectura de estructura y sesgo por temporalidad.
//
// La versión anterior devolvía solo banderas booleanas (choch4h, weeklyBullish…)
// que exigían condiciones muy estrictas y por eso salían falsas casi siempre:
// el veredicto quedaba clavado en NO_TRADE sin importar el mercado. Ahora cada
// temporalidad devuelve un PUNTAJE graduado (-100 a +100) combinando ubicación
// respecto a las medias, pendiente, estructura de swings y momento — que sí se
// mueve día a día — y las banderas se conservan como señales de gatillo.

function sma(values, period, offsetFromEnd = 0) {
  const end = values.length - offsetFromEnd;
  if (end < period) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) s += values[i];
  return s / period;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG += (ch > 0 ? ch : 0) / period;
    avgL += (ch < 0 ? -ch : 0) / period;
  }
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

function macdHist(closes) {
  if (closes.length < 35) return null;
  const line = (arr) => ema(arr, 12) - ema(arr, 26);
  const hist = [];
  for (let i = 35; i <= closes.length; i++) hist.push(line(closes.slice(0, i)));
  const signal = ema(hist, 9);
  return { macd: hist[hist.length - 1], signal, hist: hist[hist.length - 1] - signal };
}

export function swingPoints(candles, look = 3) {
  const highs = [], lows = [];
  for (let i = look; i < candles.length - look; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= look; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isHigh = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isLow = false;
    }
    if (isHigh) highs.push({ i, p: candles[i].h });
    if (isLow) lows.push({ i, p: candles[i].l });
  }
  return { highs, lows };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Sesgo graduado de una temporalidad.
 * @returns {{score:number,label:string,parts:object}} score -100..+100
 */
export function timeframeBias(candles) {
  if (!candles || candles.length < 30) return { score: 0, label: "Sin datos", parts: {} };
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const ma20 = sma(closes, 20), ma50 = sma(closes, Math.min(50, closes.length - 1));
  const ma20Prev = sma(closes, 20, 10);

  const parts = {};

  // Todo se normaliza por el RANGO reciente, no por la volatilidad media:
  // dentro de un rango lateral el precio oscila alrededor del centro, así que
  // el puntaje se queda cerca de cero por construcción (con la normalización
  // por volatilidad, una oscilación suave disparaba el puntaje al máximo).
  const win = candles.slice(-60);
  const hi = Math.max(...win.map((c) => c.h));
  const lo = Math.min(...win.map((c) => c.l));
  const range = hi - lo;
  const half = range / 2 || last * 0.02;
  const mid = (hi + lo) / 2;

  // Ubicación dentro del rango: −1 en el piso, +1 en el techo.
  parts.ubicacion = clamp(((last - mid) / half) * 30, -30, 30);

  // Tendencia: separación entre medias, medida contra el rango.
  if (ma20 && ma50) parts.tendencia = clamp(((ma20 - ma50) / half) * 45, -25, 25);

  // Pendiente de la media de 20 en las últimas 10 velas.
  if (ma20 && ma20Prev) parts.pendiente = clamp(((ma20 - ma20Prev) / half) * 45, -20, 20);

  // Estructura: máximos y mínimos crecientes vs decrecientes.
  const { highs, lows } = swingPoints(candles);
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].p > highs[highs.length - 2].p;
    const hl = lows[lows.length - 1].p > lows[lows.length - 2].p;
    parts.estructura = (hh ? 10 : -10) + (hl ? 10 : -10);
  }

  // Momento: RSI centrado en 50 e histograma MACD.
  const r = rsi(closes);
  if (r != null) parts.rsi = clamp(((r - 50) / 50) * 15, -15, 15);
  const m = macdHist(closes);
  if (m) parts.macd = clamp((m.hist / (half * 0.35)) * 15, -15, 15);

  const score = clamp(Math.round(Object.values(parts).reduce((a, b) => a + b, 0)), -100, 100);
  const label =
    score >= 45 ? "Alcista fuerte" : score >= 15 ? "Alcista" :
    score <= -45 ? "Bajista fuerte" : score <= -15 ? "Bajista" : "Neutral";
  return {
    score, label,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    rsi: r != null ? Math.round(r * 10) / 10 : null,
    bullish: score >= 15,
  };
}

/** Señales de gatillo en la temporalidad de ejecución (4H). */
export function detectStructure(candles, poiLo, invalidation) {
  const empty = { choch: false, bos: false, liquiditySweep: false, trend: "neutral" };
  if (!candles || candles.length < 20) return empty;

  const { highs, lows } = swingPoints(candles);
  if (highs.length < 2 || lows.length < 2) return empty;

  const last = candles[candles.length - 1];
  const prevHigh = highs[highs.length - 1].p;
  const prevLow = lows[lows.length - 1].p;
  const lh = highs[highs.length - 1].p < highs[highs.length - 2].p;
  const ll = lows[lows.length - 1].p < lows[lows.length - 2].p;
  const trend = lh && ll ? "bearish" : !lh && !ll ? "bullish" : "neutral";

  const choch =
    (trend === "bearish" && last.c > prevHigh) ||
    (trend === "bullish" && last.c < prevLow);
  const bos =
    (trend === "bullish" && last.c > prevHigh) ||
    (trend === "bearish" && last.c < prevLow);

  // Barrido de liquidez: se perforó un mínimo relevante y el precio lo recuperó.
  const recent = candles.slice(-10);
  const refLow = poiLo ?? invalidation ?? Math.min(...lows.slice(-3).map((l) => l.p));
  const liquiditySweep = refLow != null
    && recent.some((c) => c.l < refLow) && last.c > refLow;

  return { choch, bos, liquiditySweep, trend };
}
