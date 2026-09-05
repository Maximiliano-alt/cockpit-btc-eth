// Resumen conjunto de todas las variables en vivo.
//
// Las descripciones de cada métrica se resuelven en el cliente (son fijas y no
// gastan cuota). Lo que sí aporta la IA es CRUZARLAS: qué implica que el
// sentimiento esté eufórico mientras el on-chain sigue barato, o que entre
// dinero institucional con dominancia subiendo. Eso es lo que se genera aquí.
//
// Cacheado 45 min con firma sobre los valores: si las variables no se han
// movido de forma relevante, no se vuelve a llamar al modelo.
import { callGeminiWithFallback } from "./_lib/gemini.mjs";
import { withAiCache } from "./_lib/aicache.mjs";

const TTL = 45 * 60 * 1000;

const SYSTEM =
  "Eres un estratega de mercado cripto. Recibes el estado actual de las variables que sigue un dashboard: " +
  "sentimiento (Fear&Greed y social), dominancia, flujos de ETF, derivados (funding, open interest), " +
  "on-chain y ciclo (Puell, MVRV-Z, Mayer, RSI 22D, Cycle Top, Altseason) y macro (DXY, S&P500). " +
  "Escribe en español un resumen de 4 a 6 frases que CRUCE las variables entre sí en vez de repetirlas una a " +
  "una: señala dónde se confirman, dónde se contradicen, y qué implica ese conjunto para el mercado cripto " +
  "ahora mismo. Destaca explícitamente cualquier divergencia relevante (por ejemplo sentimiento eufórico con " +
  "valuación barata, o entradas institucionales con dominancia subiendo). " +
  "Cierra con una frase que diga en qué fase de riesgo sitúa al mercado el conjunto. " +
  "Cita los números que uses. No des consejos de inversión ni niveles de entrada: describe el estado, no qué " +
  "hacer. Devuelve solo el texto, sin títulos ni viñetas.";

const jsonResponse = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Firma redondeada: cambios mínimos no deben disparar una regeneración.
function signatureOf(v) {
  // `step` es el tamaño del escalón: valores dentro del mismo escalón dan la
  // misma firma y no regeneran el resumen.
  const q = (x, step) => (typeof x === "number" ? String(Math.round(x / step)) : "-");
  return [
    q(v.fearGreed, 3), q(v.btcDom, 0.5), q(v.ethDom, 0.5),
    q(v.etfBtc, 50), q(v.fundingBtc, 0.005),
    q(v.puell, 0.1), q(v.mvrvz, 0.1), q(v.mayer, 0.05), q(v.rsi22, 3),
    q(v.cycleTop, 1), q(v.altseason, 5), q(v.dxyChange, 0.2), q(v.spChange, 0.2),
  ].join("|");
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const gemini = process.env.GEMINI_API_KEY;
  if (!gemini) return jsonResponse({ error: "Sin GEMINI_API_KEY" }, 500);

  let v = {};
  try { v = JSON.parse((await req.text()) || "{}"); } catch { /* vacío */ }
  if (v.fearGreed == null && v.puell == null) {
    return jsonResponse({ error: "sin variables suficientes" }, 400);
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const { data, served } = await withAiCache({
      key: "market-summary",
      ttlMs: TTL,
      signature: signatureOf(v),
      force,
      generate: async () => {
        const r = await callGeminiWithFallback(gemini, SYSTEM, "Variables actuales:\n" + JSON.stringify(v, null, 1), {
          maxOutputTokens: 1024, temperature: 0.35, timeoutMs: 20000, overallBudgetMs: 26000,
        });
        if (!r.text) throw new Error("respuesta vacía");
        return { text: r.text, model: r.model, at: Date.now() };
      },
    });
    return jsonResponse({ ...data, served });
  } catch (e) {
    return jsonResponse({ error: String(e).slice(0, 200) }, 500);
  }
};
