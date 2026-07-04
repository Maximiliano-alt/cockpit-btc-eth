// Helper compartido para llamar a Gemini con fallback automático de modelo.
// Los modelos "pro"/preview suelen tener cuota gratuita 0 o muy baja. En vez
// de probar primero el modelo configurado (que puede estar sin cuota y hacer
// perder varios segundos antes de fallar — arriesgando el timeout de 30s de
// la function), probamos primero los "flash" (rápidos, cuota gratuita
// generosa) y dejamos el configurado como último recurso.
// Además: cada intento tiene un timeout corto propio y recordamos, dentro del
// mismo contenedor tibio, cuál fue el último modelo que funcionó, para ir
// directo a él en la siguiente invocación en vez de repetir todo el ciclo.
const FLASH_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
const PER_MODEL_TIMEOUT_MS = 9000;

let lastGoodModel = null;

function candidateModels() {
  const configured = process.env.GEMINI_MODEL;
  const rest = FLASH_FALLBACKS.filter((m) => m !== configured);
  const ordered = [
    ...(lastGoodModel ? [lastGoodModel] : []),
    ...rest,
    ...(configured ? [configured] : []),
  ];
  return [...new Set(ordered)];
}

async function callGeminiModel(model, key, system, user, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PER_MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: ctrl.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: opts.maxOutputTokens ?? 2048,
            temperature: opts.temperature ?? 0.3,
            ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
          },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      const err = new Error("Gemini HTTP " + res.status + " " + JSON.stringify(data).slice(0, 600));
      err.status = res.status;
      throw err;
    }
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Gemini timeout tras " + (opts.timeoutMs ?? PER_MODEL_TIMEOUT_MS) + "ms en " + model);
      err.status = 408;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Prueba el último modelo que funcionó, luego los flash, y el configurado al
// final — hasta obtener una respuesta o agotar la lista. Respeta un
// presupuesto total de tiempo para nunca chocar con el timeout duro de la
// function (30s) — mejor devolver un error JSON prolijo que un timeout mudo.
async function callGeminiWithFallback(key, system, user, opts = {}) {
  const models = candidateModels();
  const overallBudgetMs = opts.overallBudgetMs ?? 25000;
  const start = Date.now();
  let lastErr;
  for (const model of models) {
    const remaining = overallBudgetMs - (Date.now() - start);
    if (remaining < 1500) break;
    const timeoutMs = Math.min(opts.timeoutMs ?? PER_MODEL_TIMEOUT_MS, remaining);
    const attemptStart = Date.now();
    try {
      const text = await callGeminiModel(model, key, system, user, { ...opts, timeoutMs });
      console.log(`[gemini] ${model} OK en ${Date.now() - attemptStart}ms`);
      if (text) { lastGoodModel = model; return { text, model }; }
      lastErr = new Error("Respuesta vacía de " + model);
    } catch (e) {
      console.log(`[gemini] ${model} FALLÓ en ${Date.now() - attemptStart}ms: ${String(e).slice(0, 200)}`);
      lastErr = e;
      if (lastGoodModel === model) lastGoodModel = null;
      // 401/403: la key no sirve, cambiar de modelo no lo arregla.
      if (e.status === 401 || e.status === 403) throw e;
    }
  }
  throw lastErr || new Error("Sin modelos Gemini disponibles (tiempo agotado)");
}

module.exports = { callGeminiWithFallback };
