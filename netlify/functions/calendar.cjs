// Calendario económico semanal (Forex Factory vía feed público), filtrado a
// lo relevante para cripto: el driver macro de BTC/ETH es la política
// monetaria y liquidez en USD, no datos retail de otras divisas.
// Cache 1 h — suficiente para eventos macro.
let cache = { at: 0, body: null };
const TTL = 60 * 60 * 1000;

// Alto impacto en cualquier divisa mueve el sentimiento de riesgo global
// (y por lo tanto cripto); medio impacto solo importa si es en USD, que es
// la divisa que de verdad correlaciona con BTC/ETH (Fed, CPI, NFP, etc).
function isCryptoRelevant(e) {
  if (e.impact === "High") return true;
  if (e.impact === "Medium" && e.country === "USD") return true;
  return false;
}

exports.handler = async () => {
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body, headers: { "Content-Type": "application/json" } };
  }
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    const events = (Array.isArray(raw) ? raw : [])
      .map((e) => ({
        title: String(e.title || "").slice(0, 120),
        country: String(e.country || "").slice(0, 6),
        date: e.date || "",
        impact: ["High", "Medium", "Low"].includes(e.impact) ? e.impact : "Low",
        forecast: String(e.forecast ?? "").slice(0, 30),
        previous: String(e.previous ?? "").slice(0, 30),
      }))
      .filter((e) => e.title && e.date)
      .filter(isCryptoRelevant)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const body = JSON.stringify({ events, at: Date.now() });
    cache = { at: Date.now(), body };
    return { statusCode: 200, body, headers: { "Content-Type": "application/json" } };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
