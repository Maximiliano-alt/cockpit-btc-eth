// Helper compartido para llamar a Gemini con fallback automático de modelo.
// Los modelos "pro"/preview suelen tener cuota gratuita 0 o muy baja; si el
// modelo configurado en GEMINI_MODEL devuelve 429 (cuota) o 404 (no existe),
// se reintenta con modelos "flash" que sí tienen cuota gratuita generosa.
const FLASH_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];

function candidateModels() {
  const configured = process.env.GEMINI_MODEL;
  const list = configured ? [configured, ...FLASH_FALLBACKS] : FLASH_FALLBACKS;
  return [...new Set(list)];
}

async function callGeminiModel(model, key, system, user, opts) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
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
    const err = new Error("Gemini HTTP " + res.status + " " + JSON.stringify(data).slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

// Prueba el modelo configurado y, si falla por cuota/modelo inexistente,
// recorre los fallbacks hasta obtener una respuesta o agotar la lista.
async function callGeminiWithFallback(key, system, user, opts = {}) {
  const models = candidateModels();
  let lastErr;
  for (const model of models) {
    try {
      const text = await callGeminiModel(model, key, system, user, opts);
      if (text) return { text, model };
      lastErr = new Error("Respuesta vacía de " + model);
    } catch (e) {
      lastErr = e;
      // 401/403: la key no sirve, cambiar de modelo no lo arregla.
      if (e.status === 401 || e.status === 403) throw e;
    }
  }
  throw lastErr || new Error("Sin modelos Gemini disponibles");
}

module.exports = { callGeminiWithFallback };
