// DXY + S&P 500 vía Yahoo Finance (proxy server-side, sin key).
let cache = { at: 0, body: null };
const TTL = 15 * 60 * 1000;

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(symbol + " HTTP " + res.status);
  const j = await res.json();
  const q = j?.chart?.result?.[0];
  const closes = q?.indicators?.quote?.[0]?.close?.filter((v) => v != null) ?? [];
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const change = prev ? ((last - prev) / prev) * 100 : 0;
  return { price: last, changePct: change };
}

exports.handler = async () => {
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body, headers: { "Content-Type": "application/json" } };
  }
  try {
    const [dxy, sp500] = await Promise.allSettled([
      fetchQuote("DX-Y.NYB"),
      fetchQuote("^GSPC"),
    ]);
    const body = JSON.stringify({
      dxy: dxy.status === "fulfilled" ? dxy.value : null,
      sp500: sp500.status === "fulfilled" ? sp500.value : null,
      at: Date.now(),
    });
    cache = { at: Date.now(), body };
    return { statusCode: 200, body, headers: { "Content-Type": "application/json" } };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
