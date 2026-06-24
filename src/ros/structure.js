// Detección heurística de estructura HTF (CHoCH, BOS, barrido de liquidez).
// No es señal automática — alimenta el Decision Engine.

function swingPoints(candles, look = 3) {
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

function trendFromSwings(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const lh = highs[highs.length - 1].p < highs[highs.length - 2].p;
  const ll = lows[lows.length - 1].p < lows[lows.length - 2].p;
  if (lh && ll) return "bearish";
  if (!lh && !ll) return "bullish";
  return "neutral";
}

/** @param {{h:number,l:number,c:number,o:number}[]} candles */
export function detectStructure(candles, poiLo, invalidation) {
  if (!candles?.length || candles.length < 20) {
    return {
      choch4h: false,
      bos4h: false,
      liquiditySweep: false,
      htfBullish: false,
      weeklyBullish: false,
      monthlyBullish: false,
    };
  }

  const { highs, lows } = swingPoints(candles);
  const trend = trendFromSwings(highs, lows);
  const last = candles[candles.length - 1];
  const prevHigh = highs.length ? highs[highs.length - 1].p : null;
  const prevLow = lows.length ? lows[lows.length - 1].p : null;

  const choch4h =
    (trend === "bearish" && prevHigh != null && last.c > prevHigh) ||
    (trend === "bullish" && prevLow != null && last.c < prevLow);

  const bos4h =
    (trend === "bullish" && prevHigh != null && last.c > prevHigh && !choch4h) ||
    (trend === "bearish" && prevLow != null && last.c < prevLow && !choch4h);

  const sweepLevel = poiLo ?? invalidation;
  let liquiditySweep = false;
  if (sweepLevel != null) {
    const recent = candles.slice(-8);
    const wickBelow = recent.some((c) => c.l < sweepLevel);
    const reclaimed = last.c > sweepLevel;
    liquiditySweep = wickBelow && reclaimed;
  }

  const htfBullish = trend === "bullish" || (choch4h && last.c > (prevHigh ?? last.c));

  return {
    choch4h,
    bos4h,
    liquiditySweep,
    htfBullish,
    weeklyBullish: false,
    monthlyBullish: false,
    trend,
  };
}

/** @param {{c:number}[]} candles */
export function timeframeBias(candles) {
  if (!candles?.length || candles.length < 5) return false;
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const ma = closes.slice(-Math.min(20, closes.length)).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
  const higherHigh = closes[closes.length - 1] > Math.max(...closes.slice(-6, -1));
  return last > ma && higherHigh;
}
