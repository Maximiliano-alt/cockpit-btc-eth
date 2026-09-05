// Helper compartido para llamar a Gemini rotando entre los pools gratuitos.
// En el free tier CADA modelo tiene su propia cuota diaria (~20 req/día) y
// por minuto (~5 RPM), así que rotar entre varios multiplica la cuota total
// disponible. Orden: mejor calidad primero, los "lite" como red de seguridad.
// El modelo configurado en GEMINI_MODEL se intenta al final (es el que más
// probablemente esté mal configurado o sin cuota, p. ej. un "pro" preview).
// Los alias "-latest" van primero a propósito: Google retira modelos con
// nombre de versión sin avisar (gemini-2.0-flash y gemini-2.5-flash-lite
// empezaron a devolver 404 apuntando a sus reemplazos), mientras que el alias
// siempre resuelve al vigente. Los nombrados quedan detrás como respaldo, y
// cada uno tiene su propia cuota diaria, que es lo que multiplica el margen.
const FREE_MODELS = [
  "gemini-flash-latest",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];
const PER_MODEL_TIMEOUT_MS = 20000;

let lastGoodModel = null;

function candidateModels() {
  const configured = process.env.GEMINI_MODEL;
  const rest = FREE_MODELS.filter((m) => m !== configured && m !== lastGoodModel);
  const ordered = [
    ...(lastGoodModel ? [lastGoodModel] : []),
    ...rest,
    ...(configured && configured !== lastGoodModel ? [configured] : []),
  ];
  return [...new Set(ordered)];
}

// Los flash 2.5/3.5 traen "thinking" activado por defecto: los pensamientos
// consumen maxOutputTokens (truncando el JSON) y suman segundos de latencia.
// Para este dashboard queremos respuesta rápida y completa → thinking off.
function supportsThinkingConfig(model) {
  // Los "lite" devuelven 400 INVALID_ARGUMENT si se les manda thinkingConfig.
  if (/lite/i.test(model)) return false;
  return /2\.5|3\.|-latest/.test(model);
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
            ...(opts.responseJson ? { responseMimeType: "application/json" } : {}),
            ...(supportsThinkingConfig(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
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

// Recorre los pools hasta obtener respuesta, respetando un presupuesto total
// para nunca chocar con el timeout duro de la function (30s).
export async function callGeminiWithFallback(key, system, user, opts = {}) {
  const models = candidateModels();
  const overallBudgetMs = opts.overallBudgetMs ?? 26000;
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
      // 400/401/403: la key no sirve o el modelo no existe para esta key —
      // cambiar de modelo sí puede ayudar en 400/404, pero en 401/403 no.
      if (e.status === 401 || e.status === 403) throw e;
    }
  }
  throw lastErr || new Error("Sin modelos Gemini disponibles (tiempo agotado)");
}
