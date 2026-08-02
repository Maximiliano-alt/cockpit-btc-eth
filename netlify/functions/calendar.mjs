// Calendario económico desde la API pública de TradingView.
// Ventaja sobre el feed de ForexFactory que usábamos antes: incluye el
// RESULTADO PUBLICADO (actual) de los eventos que ya ocurrieron, además de
// pronóstico y previo — que es lo que permite juzgar la sorpresa real.
// Filtrado a lo relevante para cripto y cacheado 20 min (los actuals van
// apareciendo a lo largo del día, así que no conviene un TTL largo).
import { getStore } from "@netlify/blobs";

const TTL = 20 * 60 * 1000;

// TV usa códigos de país; el cockpit muestra la divisa, que es como se lee
// un calendario de trading.
const CURRENCY = {
  US: "USD", EU: "EUR", GB: "GBP", JP: "JPY", CA: "CAD",
  AU: "AUD", NZ: "NZD", CH: "CHF", CN: "CNY", DE: "EUR", FR: "EUR",
};
const COUNTRIES = Object.keys(CURRENCY).join(",");

// importance: 1 = alto, 0 = medio, -1 = bajo.
const IMPACT = { 1: "High", 0: "Medium", "-1": "Low" };

// Series de impacto medio que TradingView marca como USD pero que no mueven
// el apetito de riesgo: inventarios de energía, hipotecas, subastas de deuda.
const NOISE = /EIA |API Crude|Baker Hughes|MBA |Mortgage|Redbook|Auction|Tender|Bill |Note |Bond |Imports$|Exports$|Stocks Change/i;

// El driver macro de BTC/ETH es la política monetaria y la liquidez en USD:
// alto impacto de cualquier divisa mueve el apetito de riesgo global, y el
// impacto medio solo importa si es de EE.UU. y no es ruido sectorial.
function isCryptoRelevant(e) {
  if (NOISE.test(e.title)) return false;
  if (e.impact === "High") return true;
  return e.impact === "Medium" && e.country === "USD";
}

function fmtValue(v, unit) {
  if (v == null) return "";
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n)) return String(v).slice(0, 20);
  const abs = Math.abs(n);
  const num = abs >= 1000 ? n.toLocaleString("en-US") : String(Number(n.toFixed(2)));
  if (unit === "%") return num + "%";
  if (unit === "K" || unit === "M" || unit === "B") return num + unit;
  return num;
}

export default async () => {
  const store = getStore({ name: "ai-cache", consistency: "strong" });
  let cached = null;
  try { cached = await store.get("calendar", { type: "json" }); } catch { /* sin cache */ }
  if (cached?.data && Date.now() - cached.at < TTL) {
    return Response.json(cached.data);
  }
  try {
    // Ventana: 4 días atrás (para ver resultados recientes) y 7 hacia adelante.
    const from = new Date(Date.now() - 4 * 864e5).toISOString();
    const to = new Date(Date.now() + 7 * 864e5).toISOString();
    const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=${COUNTRIES}`;
    const res = await fetch(url, {
      headers: { Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" },
    });
    if (!res.ok) throw new Error("TradingView HTTP " + res.status);
    const raw = await res.json();
    const list = Array.isArray(raw?.result) ? raw.result : [];

    const events = list
      .map((e) => ({
        id: String(e.id || (e.title + e.date)).slice(0, 80),
        title: String(e.title || "").slice(0, 120),
        country: CURRENCY[e.country] || e.country || "",
        date: e.date || "",
        impact: IMPACT[String(e.importance)] || "Low",
        actual: fmtValue(e.actual, e.unit),
        forecast: fmtValue(e.forecast, e.unit),
        previous: fmtValue(e.previous, e.unit),
        // Valores crudos para calcular la sorpresa sin re-parsear texto.
        actualRaw: typeof e.actual === "number" ? e.actual : null,
        forecastRaw: typeof e.forecast === "number" ? e.forecast : null,
        previousRaw: typeof e.previous === "number" ? e.previous : null,
        period: String(e.period || "").slice(0, 20),
        source: String(e.source || "").slice(0, 60),
      }))
      .filter((e) => e.title && e.date)
      .filter(isCryptoRelevant)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const data = { events, at: Date.now() };
    await store.setJSON("calendar", { at: Date.now(), data });
    return Response.json(data);
  } catch (e) {
    // Si TradingView falla, servir lo último bueno antes que romper la sección.
    if (cached?.data) return Response.json({ ...cached.data, stale: true });
    return Response.json({ error: String(e) }, { status: 500 });
  }
};
