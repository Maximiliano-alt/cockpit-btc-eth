// Diagnóstico generado por LLM con el contexto completo del dashboard.
// Resultado cacheado en Netlify Blobs (persistente): la página siempre carga
// el último diagnóstico al instante; solo se regenera cada 45 min — clave
// para vivir dentro de la cuota gratuita de Gemini (~20 req/día por modelo).
import { callGeminiWithFallback } from "./_lib/gemini.mjs";
import { withAiCache } from "./_lib/aicache.mjs";
import { getStore } from "@netlify/blobs";

/**
 * Las zonas son autoritativas del SERVIDOR, no del cliente.
 *
 * El navegador enviaba su instantánea de contexto 1,2 s después de cargar,
 * cuando las zonas (que tardan segundos en calcularse) todavía valían null.
 * El diagnóstico salía diciendo "Zonas IA: datos no disponibles" aunque los
 * gráficos las mostraran, y encima quedaba cacheado 45 min. Leyéndolas aquí
 * del mismo blob que las guardó, el fallo de sincronización desaparece.
 */
async function serverZones() {
  try {
    const store = getStore({ name: "ai-cache", consistency: "strong" });
    const z = await store.get("zones", { type: "json" });
    return z?.data?.zones || null;
  } catch { return null; }
}

// Bloques que hacen falta para que el diagnóstico valga algo. Si faltan, el
// resultado se genera igual pero NO se cachea: así una carga incompleta no
// envenena la respuesta durante los siguientes 45 minutos.
function contextGaps(ctx) {
  const gaps = [];
  if (!ctx.zonasIA || !Object.keys(ctx.zonasIA).length) gaps.push("zonasIA");
  if (!ctx.fearGreed) gaps.push("fearGreed");
  if (!ctx.onchain) gaps.push("onchain");
  if (!ctx.macro?.dxy && !ctx.macro?.sp500) gaps.push("macro");
  if (!ctx.sesgoPorTemporalidad) gaps.push("sesgoPorTemporalidad");
  return gaps;
}

const TTL = 45 * 60 * 1000;

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

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!gemini && !anthropic) {
    return jsonResponse({ error: "Sin GEMINI_API_KEY ni ANTHROPIC_API_KEY" }, 500);
  }
  const bodyText = await req.text();
  const force = new URL(req.url).searchParams.get("force") === "1";

  // Se completa el contexto del cliente con lo que el servidor ya tiene.
  let ctx = {};
  try { ctx = JSON.parse(bodyText || "{}"); } catch { /* contexto vacío */ }
  if (!ctx.zonasIA || !Object.keys(ctx.zonasIA).length) {
    const z = await serverZones();
    if (z) ctx.zonasIA = z;
  }
  const gaps = contextGaps(ctx);

  try {
    const { data, served } = await withAiCache({
      key: "diagnosis",
      ttlMs: TTL,
      force,
      // Un diagnóstico hecho con huecos no se guarda: se sirve una vez y el
      // siguiente cliente con datos completos genera el bueno.
      skipWrite: gaps.length > 0,
      generate: async () => {
        const user = "Contexto en vivo (todas las variables del cockpit):\n" + JSON.stringify(ctx);
        let text, model;
        if (gemini) {
          try {
            const r = await callGeminiWithFallback(gemini, SYSTEM, user, {
              maxOutputTokens: 2048, temperature: 0.35, timeoutMs: 20000, overallBudgetMs: 26000,
            });
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
        if (!text) throw new Error("respuesta vacía del modelo");
        return { text, model, at: Date.now(), gaps };
      },
    });
    return jsonResponse({ ...data, served, gaps });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
};
