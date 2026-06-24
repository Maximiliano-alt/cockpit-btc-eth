// Diagnóstico generado por LLM con el contexto completo del dashboard.
// Gemini Pro (mejor razonamiento); Anthropic solo si no hay key de Google.
// Cache 15 min por clave de contexto (precio redondeado + zonas + hora).
let cache = { at: 0, key: null, body: null };
const TTL = 15 * 60 * 1000;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

const SYSTEM =
  "Eres un analista institucional de trading (SMC/Wyckoff + on-chain) escribiendo el diagnóstico del día " +
  "para un dashboard personal de Max. Estilo: directo, sin azúcar, en español. " +
  "Universo operable: solo BTC y ETH (SOL solo se monitorea). " +
  "Recibirás un JSON con datos en vivo: precios, Fear&Greed, dominancia, flujos ETF, funding, open interest, " +
  "on-chain (Puell, MVRV-Z, Mayer, RSI 22D, Cycle Top, Altseason) y las zonas vigentes del análisis " +
  "(zonasIA: imanes de liquidez, POI y línea de invalidación por activo). " +
  "OBLIGATORIO: usa EXCLUSIVAMENTE las zonas de zonasIA como niveles de referencia — no inventes números. " +
  "Si zonasIA es null o vacío, responde que el análisis está pendiente y no des niveles. " +
  "Devuelve SOLO el diagnóstico en este formato, sin preámbulo:\n" +
  "VEREDICTO: una frase contundente sobre qué hacer hoy (gestionar/esperar/actuar) según dónde está el precio vs los niveles.\n" +
  "Luego 4-6 bullets que empiecen con '› ', cada uno interpretando un dato concreto del JSON (precio vs zonas, sentimiento, " +
  "flujos, funding, on-chain). Cita los números. Máximo ~140 palabras en total. " +
  "Nunca recomiendes entrar a mercado sin estructura confirmada; nunca sugieras operar otros activos.";

function cacheKey(body) {
  try {
    const j = JSON.parse(body || "{}");
    const btc = Math.round((j.precios?.btc || 0) / 250) * 250;
    const eth = Math.round((j.precios?.eth || 0) / 25) * 25;
    const hour = new Date().toISOString().slice(0, 13);
    const zones = JSON.stringify(j.zonasIA || null);
    return `${hour}|${btc}|${eth}|${zones.slice(0, 400)}`;
  } catch {
    return String(Date.now());
  }
}

async function callGemini(key, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.35 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("Gemini HTTP " + res.status + " " + JSON.stringify(data).slice(0, 200));
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

async function callAnthropic(key, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
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
  try {
    const user = "Contexto en vivo:\n" + (event.body || "{}");
    const text = gemini ? await callGemini(gemini, user) : await callAnthropic(anthropic, user);
    const body = JSON.stringify({ text, model: gemini ? GEMINI_MODEL : "claude-sonnet-4-6", at: Date.now() });
    if (text) cache = { at: Date.now(), key, body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
