// Cache persistente para resultados de IA usando Netlify Blobs.
// A diferencia del cache en memoria (que muere con cada cold start de la
// function), esto sobrevive entre invocaciones y despliegues, así que:
//  - la página SIEMPRE recibe el último análisis al instante (<1s),
//  - solo se llama a Gemini cuando el resultado expiró de verdad,
//  - si Gemini falla (cuota agotada), se sirve el último análisis bueno
//    en lugar de un error, y se respeta un cooldown para no quemar cuota
//    reintentando en loop.
import { getStore } from "@netlify/blobs";

// `signature`: si cambia, el cache se considera vencido aunque no haya
// expirado el TTL. Sirve para regenerar cuando cambian los datos de entrada
// (p. ej. se publicó el resultado de un evento nuevo) sin bajar el TTL.
export async function withAiCache({ key, ttlMs, cooldownMs = 10 * 60 * 1000, force = false, signature = null, generate }) {
  // strong: una escritura recién hecha (p.ej. regeneración de otra pestaña)
  // se ve de inmediato; con la consistencia eventual por defecto la lectura
  // podía devolver la versión vieja durante ~1 min.
  const store = getStore({ name: "ai-cache", consistency: "strong" });
  let entry = null;
  try { entry = await store.get(key, { type: "json" }); } catch { /* sin cache previo */ }
  const now = Date.now();
  const sigOk = signature == null || entry?.signature === signature;

  if (!force) {
    if (entry?.data && sigOk && now - entry.at < ttlMs) {
      return { data: entry.data, served: "cache" };
    }
    // Falló hace poco: no reintentar todavía; servir lo último que haya.
    if (entry?.lastFailAt && now - entry.lastFailAt < cooldownMs) {
      if (entry?.data) return { data: entry.data, served: "stale-cooldown" };
      throw new Error("IA en cooldown tras error reciente; se reintenta en unos minutos.");
    }
  }

  try {
    const data = await generate();
    await store.setJSON(key, { at: now, signature, data });
    return { data, served: "generated" };
  } catch (e) {
    try { await store.setJSON(key, { ...(entry || { at: 0 }), lastFailAt: now }); } catch { /* best effort */ }
    if (entry?.data) {
      console.log(`[aicache] ${key}: generación falló, sirviendo versión previa (${Math.round((now - entry.at) / 60000)} min): ${String(e).slice(0, 150)}`);
      return { data: entry.data, served: "stale-error" };
    }
    throw e;
  }
}
