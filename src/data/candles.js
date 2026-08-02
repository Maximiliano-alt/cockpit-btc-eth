// Obtención de velas con respaldo automático de exchange.
//
// Antes todo el cockpit pedía las velas SOLO a Binance: si Binance quedaba
// inalcanzable (bloqueo por país/ISP, o el geobloqueo a IPs de EE.UU. que
// afecta a las functions de Netlify), los gráficos, los indicadores y el bot
// se quedaban en blanco a la vez. Ahora hay una cadena de fuentes: se intenta
// Binance y, si falla, Coinbase — que expone velas públicas sin API key.
//
// Coinbase solo ofrece granularidades de 1m/5m/15m/1h/6h/1d y máximo 300 velas
// por petición, así que los marcos mayores se construyen agregando velas más
// pequeñas (paginando hacia atrás cuando hace falta).

const BINANCE_HOSTS = [
  "https://api.binance.com",
  // Espejo de solo-datos de Binance: a veces responde donde el principal no.
  "https://data-api.binance.vision",
];

const COINBASE_PRODUCT = {
  BTCUSDT: "BTC-USD", ETHUSDT: "ETH-USD", SOLUSDT: "SOL-USD",
};

// Cómo reconstruir cada marco temporal con datos de Coinbase.
// granularity en segundos · pages de 300 velas · aggregate = cuántas agrupar.
const COINBASE_PLAN = {
  "4h": { granularity: 3600, pages: 2, aggregate: 4 },
  "1d": { granularity: 86400, pages: 1, aggregate: 1 },
  "1w": { granularity: 86400, pages: 2, aggregate: 7 },
  "1M": { granularity: 86400, pages: 4, aggregate: 30 },
};

async function fetchJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(id); }
}

async function fromBinance(symbol, interval, limit) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const j = await fetchJSON(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!Array.isArray(j) || !j.length) throw new Error("respuesta vacía");
      return j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Binance no disponible");
}

function aggregate(candles, n) {
  if (n <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const g = candles.slice(i, i + n);
    if (!g.length) continue;
    out.push({
      t: g[0].t,
      o: g[0].o,
      c: g[g.length - 1].c,
      h: Math.max(...g.map((x) => x.h)),
      l: Math.min(...g.map((x) => x.l)),
    });
  }
  return out;
}

async function fromCoinbase(symbol, interval, limit) {
  const product = COINBASE_PRODUCT[symbol];
  const plan = COINBASE_PLAN[interval];
  if (!product || !plan) throw new Error(`Coinbase no cubre ${symbol} ${interval}`);

  const all = [];
  let end = new Date();
  for (let p = 0; p < plan.pages; p++) {
    const start = new Date(end.getTime() - 300 * plan.granularity * 1000);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles`
      + `?granularity=${plan.granularity}&start=${start.toISOString()}&end=${end.toISOString()}`;
    const arr = await fetchJSON(url, 10000);
    if (!Array.isArray(arr)) break;
    // Coinbase devuelve [time, low, high, open, close, volume], descendente.
    all.push(...arr.map((k) => ({ t: k[0] * 1000, l: +k[1], h: +k[2], o: +k[3], c: +k[4] })));
    if (arr.length < 300) break;
    end = start;
  }
  if (!all.length) throw new Error("Coinbase sin datos");

  const asc = all.sort((a, b) => a.t - b.t);
  // Alineamos el agrupado al final para que la última vela sea la más reciente.
  const n = plan.aggregate;
  const offset = n > 1 ? asc.length % n : 0;
  return aggregate(asc.slice(offset), n).slice(-limit);
}

/**
 * Velas normalizadas [{t,o,h,l,c}] ascendentes.
 * Intenta Binance y cae a Coinbase. Lanza solo si todas las fuentes fallan.
 */
export async function fetchCandles(symbol, interval, limit = 400) {
  try {
    return await fromBinance(symbol, interval, limit);
  } catch (e1) {
    try {
      const c = await fromCoinbase(symbol, interval, limit);
      if (c.length) return c;
      throw new Error("Coinbase devolvió vacío");
    } catch (e2) {
      const err = new Error(`Sin velas para ${symbol} ${interval}: Binance (${e1.message}) y Coinbase (${e2.message})`);
      err.allSourcesFailed = true;
      throw err;
    }
  }
}

/** Precios al contado con respaldo, para cuando Binance no responde. */
export async function fetchPrices(symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
  try {
    const url = `${BINANCE_HOSTS[0]}/api/v3/ticker/24hr?symbols=` +
      encodeURIComponent(JSON.stringify(symbols));
    const arr = await fetchJSON(url);
    const out = {};
    arr.forEach((t) => {
      out[t.symbol] = { price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent) };
    });
    return { data: out, source: "binance" };
  } catch { /* seguimos con el respaldo */ }

  const cg = await fetchJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
  );
  return {
    data: {
      BTCUSDT: { price: cg.bitcoin.usd, change: cg.bitcoin.usd_24h_change },
      ETHUSDT: { price: cg.ethereum.usd, change: cg.ethereum.usd_24h_change },
      SOLUSDT: { price: cg.solana.usd, change: cg.solana.usd_24h_change },
    },
    source: "coingecko",
  };
}
