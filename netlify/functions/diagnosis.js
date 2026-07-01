// Diagnóstico generado por LLM con el contexto completo del dashboard.
// Gemini (con fallback automático de modelo); Anthropic solo si Gemini falla del todo.
// Cache 15 min por clave de contexto (precio redondeado + zonas + hora).
const { callGeminiWithFallback } = require("./_lib/gemini.js");

let cache = { at: 0, key: null, body: null };
const TTL = 15 * 60 * 1000;

const SYSTEM =
  "Eres un analista institucional de trading (SMC/Wyckoff + on-chain + macro) escribiendo el diagnóstico " +
  "COMPLETO del día para el cockpit personal de Max. Estilo: directo, sin azúcar, en español. " +
  "Universo operable: solo BTC y ETH (SOL solo se monitorea). " +
  "Recibirás un JSON con TODO el contexto en vivo del cockpit: precios y cambio 24h, Fear&Greed, dominancia " +
  "BTC/ETH, flujos de ETF, funding y open interest (derivados), on-chain (Puell, MVRV-Z, Mayer, RSI 22D, Cycle " +
  "Top, Altseason), macro (DXY y S&P500), estructura técnica de BTC en múltiples temporalidades (4H: " +
  "CHoCH/BOS/barrido de liquidez; sesgo semanal y mensual) y las zonas vigentes del análisis (zonasIA: imanes " +
  "de liquidez, POI y línea de invalidación por activo). " +
  "OBLIGATORIO: usa EXCLUSIVAMENTE las zonas de zonasIA como niveles de referencia — no inventes números. " +
  "Si zonasIA es null o vacío, dilo explícitamente y no des niveles. " +
  "Devuelve SOLO el diagnóstico, sin preámbulo, con este formato:\n" +
  "VEREDICTO: una frase contundente sobre qué hacer hoy (gestionar/esperar/actuar), integrando precio vs " +
  "niveles Y la alineación entre temporalidades.\n" +
  "Luego bullets que empiecen con '› ', cubriendo en este orden cada bloque de datos que venga presente en el " +
  "JSON: estructura técnica multi-temporal, precio vs zonas IA, sentimiento (Fear&Greed), flujos ETF y " +
  "derivados (funding/OI), on-chain/ciclo, y macro (DXY/SP500). Cita los números concretos de cada bloque que " +
  "uses. Sé exhaustivo pero conciso: máximo ~220 palabras en total. " +
  "Nunca recomiendes entrar a mercado sin estructura confirmada; nunca sugieras operar otros activos.";

function cacheKey(body) {
  try {
    const j = JSON.parse(body || "{}");
    const btc = Math.round((j.precios?.btc || 0) / 250) * 250;
    const eth = Math.round((j.precios?.eth || 0) / 25) * 25;
    const hour = new Date().toISOString().slice(0, 13);
    const zones = JSON.stringify(j.zonasIA || null);
    const estructura = JSON.stringify(j.estructuraBTC || null);
    return `${hour}|${btc}|${eth}|${zones.slice(0, 400)}|${estructura.slice(0, 200)}`;
  } catch {
    return String(Date.now());
  }
}

async function callAnthropic(key, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Anthropic HTTP " + res.status + " " + JSON.stringify(data).slice(0, 200));
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const key = cacheKey(event.body);
  if (cache.body && cache.key === key && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!gemini && !anthropic) {
    return { statusCode: 500, body: JSON.stringify({ error: "Sin GEMINI_API_KEY ni ANTHROPIC_API_KEY" }) };
  }
  const user = "Contexto en vivo (todas las variables del cockpit):\n" + (event.body || "{}");
  try {
    let text, model;
    if (gemini) {
      try {
        const r = await callGeminiWithFallback(gemini, SYSTEM, user, { maxOutputTokens: 2048, temperature: 0.35 });
        text = r.text; model = r.model;
      } catch (e) {
        if (!anthropic) throw e;
        text = await callAnthropic(anthropic, user);
        model = "claude-sonnet-4-6";
      }
    } else {
      text = await callAnthropic(anthropic, user);
      model = "claude-sonnet-4-6";
    }
    const body = JSON.stringify({ text, model, at: Date.now() });
    if (text) cache = { at: Date.now(), key, body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
