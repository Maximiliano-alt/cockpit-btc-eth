// Lectura IA de los eventos macro que YA ocurrieron y tienen resultado
// publicado. Una sola llamada cubre todos los eventos recientes (batch) y el
// resultado se cachea en Blobs con firma: solo se regenera cuando aparece un
// resultado nuevo, no cada vez que alguien abre la página. Así el análisis es
// instantáneo y el consumo de cuota gratuita es mínimo (~pocas llamadas/día).
import { callGeminiWithFallback } from "./_lib/gemini.mjs";
import { withAiCache } from "./_lib/aicache.mjs";
import { getStore } from "@netlify/blobs";

const TTL = 6 * 60 * 60 * 1000;
const MAX_EVENTS = 8;

const SYSTEM =
  "Eres un analista macro que traduce datos económicos a impacto sobre BTC y ETH. " +
  "Recibes eventos que YA se publicaron, con su resultado real (actual), el pronóstico y el previo. " +
  "Para CADA evento devuelve una lectura de 2 frases en español, directa y sin relleno: " +
  "(1) qué mostró el dato realmente comparado con lo esperado (sorpresa al alza/baja o en línea) y qué implica " +
  "para la Reserva Federal / liquidez en dólares; " +
  "(2) cómo eso se traduce en presión alcista, bajista o neutral para cripto, y con qué intensidad. " +
  "Sé concreto y cita los números. Si el dato salió en línea con lo esperado, dilo y explica que el efecto " +
  "suele ser neutral o de corta duración. Nunca recomiendes operar ni des señales de entrada. " +
  'Devuelve SOLO JSON válido con la forma {"<id>": "<lectura>", ...} usando exactamente los id que recibes.';

function surpriseOf(e) {
  if (e.actualRaw == null || e.forecastRaw == null) return null;
  const d = e.actualRaw - e.forecastRaw;
  if (d === 0) return "en línea";
  const base = Math.abs(e.forecastRaw) || 1;
  const pct = (Math.abs(d) / base) * 100;
  const size = pct > 25 ? "grande" : pct > 8 ? "moderada" : "leve";
  return `${d > 0 ? "por encima" : "por debajo"} del pronóstico (sorpresa ${size})`;
}

export default async (req) => {
  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!gemini && !anthropic) {
    return Response.json({ readings: {}, error: "Sin API key de IA" });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  // Leemos el calendario del mismo cache que sirve la UI: la lectura se genera
  // sobre datos ya validados server-side, no sobre lo que mande el cliente.
  const store = getStore({ name: "ai-cache", consistency: "strong" });
  let cal = null;
  try { cal = await store.get("calendar", { type: "json" }); } catch { /* sin calendario */ }
  const all = cal?.data?.events || [];
  const now = Date.now();

  // Eventos pasados, con resultado publicado, de mayor impacto primero.
  const past = all
    .filter((e) => new Date(e.date).getTime() <= now && e.actual)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_EVENTS);

  if (!past.length) return Response.json({ readings: {}, served: "sin-eventos" });

  const signature = past.map((e) => `${e.id}:${e.actual}`).join("|");

  try {
    const { data, served } = await withAiCache({
      key: "event-readings",
      ttlMs: TTL,
      signature,
      force,
      generate: async () => {
        const payload = past.map((e) => ({
          id: e.id,
          evento: e.title,
          divisa: e.country,
          periodo: e.period,
          resultado: e.actual,
          pronostico: e.forecast || "—",
          previo: e.previous || "—",
          sorpresa: surpriseOf(e) || "sin pronóstico previo para comparar",
        }));
        const user = "Eventos ya publicados:\n" + JSON.stringify(payload, null, 1);
        const r = await callGeminiWithFallback(gemini, SYSTEM, user, {
          maxOutputTokens: 4096, temperature: 0.3, responseJson: true,
          timeoutMs: 22000, overallBudgetMs: 26000,
        });
        const m = r.text.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : r.text);
        const readings = {};
        for (const e of past) {
          const t = parsed[e.id];
          if (typeof t === "string" && t.trim()) readings[e.id] = t.trim().slice(0, 600);
        }
        if (!Object.keys(readings).length) throw new Error("respuesta sin lecturas válidas");
        return { readings, model: r.model, at: Date.now() };
      },
    });
    return Response.json({ ...data, served });
  } catch (e) {
    return Response.json({ readings: {}, error: String(e) });
  }
};
