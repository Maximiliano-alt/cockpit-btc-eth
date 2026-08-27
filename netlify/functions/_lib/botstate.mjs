// Estado, configuración y bitácora del bot — persistidos en Netlify Blobs.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "bot", consistency: "strong" });

// Configuración de la estrategia de ASIGNACIÓN DE TENDENCIA — la única que
// superó la Compuerta 0 (ver tools/trend.mjs). No hay stop ni objetivo: se
// está dentro mientras el cierre diario supere su media, y en efectivo si no.
// No hay cortos ni apalancamiento: ambos empeoraron el resultado en las
// pruebas sobre 7 años.
export const DEFAULT_CONFIG = {
  armed: false,            // interruptor principal: sin esto el bot solo simula
  mode: "demo",            // "demo" = cuenta demo. "live" exige además BOT_ALLOW_LIVE
  strategy: "trend",
  symbols: ["BTCUSDT", "ETHUSDT"],
  maPeriod: 50,            // media de referencia (50 fue la mejor en la prueba)
  allocationPct: 90,       // % del capital que se reparte entre los símbolos
  trailPct: 20,            // red de seguridad ante desplomes más rápidos que la MA
  dailyLossLimitPct: 5,    // pérdida diaria que desarma el bot y cierra todo
};

// Campos del motor antiguo (operaciones con stop) que ya no se usan. Se
// descartan al leer para que una configuración guardada antes no reviva
// cortos ni apalancamiento.
const OBSOLETE = [
  "riskPctPerTrade", "maxConcurrent", "maxLeverage", "minScore",
  "minAlignment", "minRR", "maxChasePct", "cooldownMin", "allowShorts",
];

export async function getConfig() {
  try {
    const c = (await store().get("config", { type: "json" })) || {};
    for (const k of OBSOLETE) delete c[k];
    return { ...DEFAULT_CONFIG, ...c, strategy: "trend" };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export async function setConfig(patch) {
  const cur = await getConfig();
  const next = { ...cur, ...patch };
  for (const k of OBSOLETE) delete next[k];
  // El modo "live" nunca se puede activar desde la UI: exige una variable de
  // entorno que solo el dueño de la cuenta puede poner en Netlify.
  if (next.mode === "live" && process.env.BOT_ALLOW_LIVE !== "true") next.mode = "demo";
  next.strategy = "trend";
  next.maPeriod = Math.min(200, Math.max(10, Math.round(Number(next.maPeriod) || 50)));
  next.allocationPct = Math.min(100, Math.max(10, Number(next.allocationPct) || 90));
  // 0 desactiva el trailing. Por debajo de 10% recorta ganadores en tendencia,
  // así que ese es el mínimo permitido si está activo.
  next.trailPct = Number(next.trailPct) > 0 ? Math.min(50, Math.max(10, Number(next.trailPct))) : 0;
  next.dailyLossLimitPct = Math.min(50, Math.max(1, Number(next.dailyLossLimitPct) || 5));
  await store().setJSON("config", next);
  return next;
}

export async function getRuntime() {
  try {
    return (await store().get("runtime", { type: "json" })) || {};
  } catch { return {}; }
}

export async function setRuntime(patch) {
  const cur = await getRuntime();
  const next = { ...cur, ...patch };
  await store().setJSON("runtime", next);
  return next;
}

const MAX_LOG = 60;

export async function getLog() {
  try {
    return (await store().get("log", { type: "json" })) || [];
  } catch { return []; }
}

export async function appendLog(entry) {
  const log = await getLog();
  const next = [{ at: Date.now(), ...entry }, ...log].slice(0, MAX_LOG);
  await store().setJSON("log", next);
  return next;
}

/** Clave del día en UTC — para el límite de pérdida diaria. */
export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
