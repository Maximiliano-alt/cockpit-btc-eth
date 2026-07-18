// Flujos diarios de ETF BTC/ETH desde Farside. Cloudflare bloquea el fetch
// directo desde Node (fingerprint TLS), así que se lee vía r.jina.ai, que
// devuelve la página como markdown. Cache 30 min — el dato cambia 1 vez al día.
let cache = { at: 0, body: null };
const TTL = 30 * 60 * 1000;

// Filas markdown tipo: | 09 Jun 2026 | (61.6) | ... | (77.4) |
// La última celda es el flujo total del día en US$m; negativos entre paréntesis.
function parseLatestFlow(md) {
  let latest = null;
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*(\d{2} \w{3} \d{4})\s*\|(.*)\|/);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim()).filter(Boolean);
    const raw = cells[cells.length - 1];
    if (!raw) continue;
    const num = parseFloat(raw.replace(/[(),]/g, ""));
    if (isFinite(num)) latest = { date: m[1], total: raw.startsWith("(") ? -num : num };
  }
  return latest;
}

async function readPage(slug) {
  const res = await fetch(`https://r.jina.ai/https://farside.co.uk/${slug}/`);
  if (!res.ok) throw new Error("jina HTTP " + res.status);
  return parseLatestFlow(await res.text());
}

exports.handler = async () => {
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  try {
    const [btc, eth] = await Promise.all([readPage("btc"), readPage("eth")]);
    const body = JSON.stringify({ btc, eth });
    if (btc || eth) cache = { at: Date.now(), body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
