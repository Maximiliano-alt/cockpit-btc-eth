// Diagnóstico generado por LLM con el contexto completo del dashboard.
// Gratis con Gemini (tier free, sin tarjeta); usa Anthropic solo si hay key.
// Cache 15 min en memoria: aunque haya varias pestañas o recargas, se gasta
// como máximo ~4 requests/hora. Las API keys viven solo en el server.
let cache = { at: 0, body: null };
const TTL = 15 * 60 * 1000;

const GEMINI_MODEL = "gemini-3.5-flash";

const SYSTEM =
  "Eres un analista institucional de trading (SMC/Wyckoff + on-chain) escribiendo el diagnóstico del día " +
  "para un dashboard personal de Max. Estilo: directo, sin azúcar, en español. " +
  "Universo operable: solo BTC y ETH (SOL solo se monitorea). " +
  "Recibirás un JSON con datos en vivo: precios, Fear&Greed, dominancia, flujos ETF, funding, open interest, " +
  "on-chain (Puell, MVRV-Z, Mayer, RSI 22D, Cycle Top, Altseason) y, si están, las zonas vigentes del análisis " +
  "(zonasIA: imanes de liquidez, POI y línea de invalidación por activo) — usa ESAS zonas como niveles de referencia. " +
  "Si no vienen zonas, usa: BTC POI 58,000-60,000, invalidación 54,500, imán 80,000-85,000; ETH POI 1,500-1,550, invalidación 1,400, imán 2,400-2,500. " +
  "Devuelve SOLO el diagnóstico en este formato, sin preámbulo:\n" +
  "VEREDICTO: una frase contundente sobre qué hacer hoy (gestionar/esperar/actuar) según dónde está el precio vs los niveles.\n" +
  "Luego 4-6 bullets que empiecen con '› ', cada uno interpretando un dato concreto del JSON (precio vs zonas, sentimiento, " +
  "flujos, funding, on-chain). Cita los números. Máximo ~140 palabras en total. " +
  "Nunca recomiendes entrar a mercado sin estructura confirmada; nunca sugieras operar otros activos.";

async function callGemini(key, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
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
  if (cache.body && Date.now() - cache.at < TTL) {
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
    if (text) cache = { at: Date.now(), body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
