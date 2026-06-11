// Métricas on-chain y de ciclo desde fuentes gratuitas:
// - Puell Multiple y MVRV Z-Score: bitcoin-data.com (API libre, sin key)
// - Altcoin Season Index: endpoint público de CoinMarketCap
// - Cycle Top (indicadores de techo): coinglass.com vía r.jina.ai ("Hit: N/30")
// Cache 6 h — todas estas métricas se actualizan a diario.
let cache = { at: 0, body: null };
const TTL = 6 * 60 * 60 * 1000;

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(url + " HTTP " + res.status);
  return res.json();
}

async function getPuell() {
  const j = await getJSON("https://bitcoin-data.com/v1/puell-multiple/last");
  return { value: parseFloat(j.puellMultiple), date: j.d };
}

async function getMvrvZ() {
  const j = await getJSON("https://bitcoin-data.com/v1/mvrv-zscore/last");
  return { value: parseFloat(j.mvrvZscore), date: j.d };
}

async function getAltseason() {
  const end = Math.floor(Date.now() / 1000);
  const j = await getJSON(
    `https://api.coinmarketcap.com/data-api/v3/altcoin-season/chart?start=${end - 7 * 86400}&end=${end}`,
    { "User-Agent": "Mozilla/5.0" }
  );
  const pts = j?.data?.points;
  if (!pts?.length) throw new Error("altseason sin puntos");
  return { value: parseInt(pts[pts.length - 1].altcoinIndex, 10) };
}

async function getCycleTop() {
  const res = await fetch("https://r.jina.ai/https://www.coinglass.com/bull-market-peak-signals");
  if (!res.ok) throw new Error("jina HTTP " + res.status);
  const md = await res.text();
  const m = md.match(/Hit\s*:?\s*(\d+)\s*\/\s*(\d+)/s);
  if (!m) throw new Error("cycle top no parseable");
  return { hit: +m[1], total: +m[2] };
}

exports.handler = async () => {
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  // Promise.allSettled: si una fuente cae, las demás siguen llegando.
  const [puell, mvrvz, altseason, cycleTop] = (
    await Promise.allSettled([getPuell(), getMvrvZ(), getAltseason(), getCycleTop()])
  ).map((r) => (r.status === "fulfilled" ? r.value : null));

  const body = JSON.stringify({ puell, mvrvz, altseason, cycleTop });
  if (puell || mvrvz || altseason || cycleTop) cache = { at: Date.now(), body };
  return { statusCode: 200, body };
};
