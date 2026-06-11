// Diagnóstico generado por Claude con el contexto completo del dashboard.
// Cache 15 min en memoria: aunque haya varias pestañas o recargas, se gasta
// como máximo ~4 requests/hora de tokens. La API key vive solo en el server.
let cache = { at: 0, body: null };
const TTL = 15 * 60 * 1000;

const SYSTEM =
  "Eres un analista institucional de trading (SMC/Wyckoff + on-chain) escribiendo el diagnóstico del día " +
  "para un dashboard personal de Max. Estilo: directo, sin azúcar, en español. " +
  "Niveles de referencia: BTC POI de acumulación 58,000-60,000, invalidación HTF 54,500, imán de liquidez 80,000-85,000. " +
  "ETH POI 1,500-1,550, invalidación 1,400, imán 2,400-2,500. Universo operable: solo BTC y ETH (SOL solo se monitorea). " +
  "Recibirás un JSON con datos en vivo (precios, Fear&Greed, dominancia, flujos ETF, funding, open interest, on-chain). " +
  "Devuelve SOLO el diagnóstico en este formato, sin preámbulo:\n" +
  "VEREDICTO: una frase contundente sobre qué hacer hoy (gestionar/esperar/actuar) según dónde está el precio vs los niveles.\n" +
  "Luego 4-6 bullets que empiecen con '› ', cada uno interpretando un dato concreto del JSON (precio vs zonas, sentimiento, " +
  "flujos, funding, on-chain). Cita los números. Máximo ~140 palabras en total. " +
  "Nunca recomiendes entrar a mercado sin estructura confirmada; nunca sugieras operar otros activos.";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  if (cache.body && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }) };
  }
  try {
    const ctx = JSON.parse(event.body || "{}");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: "Contexto en vivo:\n" + JSON.stringify(ctx) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify(data) };
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const body = JSON.stringify({ text, at: Date.now() });
    if (text) cache = { at: Date.now(), body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
