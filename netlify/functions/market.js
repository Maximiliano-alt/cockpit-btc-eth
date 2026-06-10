// Proxy a CoinMarketCap (tier gratis). Cache en memoria para no quemar créditos:
// el plan Basic da ~333 créditos/día y cada visita del dashboard pediría 2.
let cache = { at: 0, body: null };
const TTL = 10 * 60 * 1000;

exports.handler = async () => {
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  const key = process.env.CMC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "CMC_API_KEY no configurada" }) };
  }
  const headers = { "X-CMC_PRO_API_KEY": key, Accept: "application/json" };
  try {
    const [fgRes, gmRes] = await Promise.all([
      fetch("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest", { headers }),
      fetch("https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest", { headers }),
    ]);
    const fg = await fgRes.json();
    const gm = await gmRes.json();
    const body = JSON.stringify({
      fearGreed: fg?.data?.value != null
        ? { value: Math.round(fg.data.value), label: fg.data.value_classification }
        : null,
      dominance: gm?.data?.btc_dominance != null
        ? { btc: gm.data.btc_dominance, eth: gm.data.eth_dominance }
        : null,
    });
    cache = { at: Date.now(), body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
