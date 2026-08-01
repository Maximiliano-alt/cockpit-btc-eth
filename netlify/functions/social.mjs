// Señal social / de atención — totalmente gratis, sin API key.
// CoinMarketCap cobra sus endpoints sociales, así que se arma con:
//  - CoinGecko /search/trending → ranking de atención (impulsado por búsquedas),
//  - sentimiento de la comunidad y usuarios que lo tienen en watchlist por activo,
//  - r/CryptoCurrency (si responde desde el servidor) → menciones y engagement.
// Cacheado 20 min en Blobs para no golpear los límites de CoinGecko.
import { getStore } from "@netlify/blobs";

const TTL = 20 * 60 * 1000;
const COINS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

async function fetchJSON(url, ms = 9000, headers = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally { clearTimeout(id); }
}

// Menciones y engagement en r/CryptoCurrency. Reddit bloquea agresivamente
// por IP/UA: si falla, el resto de la señal social sigue funcionando.
async function redditBuzz() {
  const j = await fetchJSON(
    "https://www.reddit.com/r/CryptoCurrency/hot.json?limit=100", 8000,
    { "User-Agent": "web:crypto-cockpit:1.0 (personal dashboard)" }
  );
  const posts = (j?.data?.children || []).map((p) => p.data).filter(Boolean);
  if (!posts.length) throw new Error("sin posts");
  const pats = {
    BTC: /\b(btc|bitcoin)\b/i,
    ETH: /\b(eth|ethereum|ether)\b/i,
    SOL: /\b(sol|solana)\b/i,
  };
  const out = {};
  for (const [sym, re] of Object.entries(pats)) {
    const hits = posts.filter((p) => re.test(`${p.title} ${(p.selftext || "").slice(0, 400)}`));
    out[sym] = {
      mentions: hits.length,
      upvotes: hits.reduce((s, p) => s + (p.score || 0), 0),
      comments: hits.reduce((s, p) => s + (p.num_comments || 0), 0),
    };
  }
  out.sample = posts.length;
  return out;
}

export default async () => {
  const store = getStore({ name: "ai-cache", consistency: "strong" });
  let cached = null;
  try { cached = await store.get("social", { type: "json" }); } catch { /* sin cache */ }
  if (cached?.data && Date.now() - cached.at < TTL) {
    return Response.json(cached.data);
  }

  const data = { assets: {}, trending: [], at: Date.now() };
  const tasks = [];

  // Ranking de tendencia: en qué puesto de atención está cada activo.
  tasks.push((async () => {
    const j = await fetchJSON("https://api.coingecko.com/api/v3/search/trending");
    const coins = (j?.coins || []).map((c) => c.item).filter(Boolean);
    data.trending = coins.slice(0, 7).map((it, i) => ({
      symbol: String(it.symbol || "").toUpperCase().slice(0, 10),
      rank: i + 1,
      mcapRank: it.market_cap_rank ?? null,
    }));
    for (const [sym] of Object.entries(COINS)) {
      const idx = coins.findIndex((c) => String(c.symbol || "").toUpperCase() === sym);
      data.assets[sym] = { ...(data.assets[sym] || {}), trendingRank: idx >= 0 ? idx + 1 : null };
    }
  })());

  // Sentimiento de la comunidad + tamaño de audiencia por activo.
  for (const [sym, id] of Object.entries(COINS)) {
    tasks.push((async () => {
      const j = await fetchJSON(
        `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false&sparkline=false`
      );
      data.assets[sym] = {
        ...(data.assets[sym] || {}),
        sentimentUp: typeof j?.sentiment_votes_up_percentage === "number"
          ? Math.round(j.sentiment_votes_up_percentage * 10) / 10 : null,
        watchlistUsers: j?.watchlist_portfolio_users ?? null,
      };
    })());
  }

  tasks.push((async () => {
    const r = await redditBuzz();
    data.reddit = r;
    for (const sym of Object.keys(COINS)) {
      if (r[sym]) data.assets[sym] = { ...(data.assets[sym] || {}), reddit: r[sym] };
    }
  })());

  await Promise.allSettled(tasks);

  // Si no se pudo sacar nada útil, preferimos el snapshot anterior.
  const gotSomething = Object.values(data.assets).some(
    (a) => a && (a.sentimentUp != null || a.trendingRank != null || a.reddit)
  );
  if (!gotSomething) {
    if (cached?.data) return Response.json({ ...cached.data, stale: true });
    return Response.json({ error: "sin datos sociales disponibles" }, { status: 500 });
  }

  await store.setJSON("social", { at: Date.now(), data });
  return Response.json(data);
};
