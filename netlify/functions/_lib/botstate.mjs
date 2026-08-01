// Estado, configuración y bitácora del bot — persistidos en Netlify Blobs.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "bot", consistency: "strong" });

export const DEFAULT_CONFIG = {
  armed: false,            // interruptor principal: sin esto el bot solo simula
  mode: "demo",            // "demo" = testnet. "live" exige además BOT_ALLOW_LIVE
  symbols: ["BTCUSDT", "ETHUSDT"],
  riskPctPerTrade: 1,      // % del capital arriesgado hasta el stop
  maxConcurrent: 2,
  maxLeverage: 3,
  minScore: 25,            // |sesgo compuesto| mínimo para operar
  minAlignment: 50,        // % de temporalidades que deben coincidir
  minRR: 1.5,
  maxChasePct: 3,          // no perseguir: máx. % por encima del POI para entrar
  dailyLossLimitPct: 5,    // pérdida diaria que apaga el bot
  cooldownMin: 90,         // espera mínima entre operaciones del mismo símbolo
  allowShorts: true,
};

export async function getConfig() {
  try {
    const c = await store().get("config", { type: "json" });
    return { ...DEFAULT_CONFIG, ...(c || {}) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export async function setConfig(patch) {
  const cur = await getConfig();
  // El modo "live" nunca se puede activar desde la UI: exige una variable de
  // entorno que solo el dueño de la cuenta puede poner en Netlify.
  const next = { ...cur, ...patch };
  if (next.mode === "live" && process.env.BOT_ALLOW_LIVE !== "true") next.mode = "demo";
  next.riskPctPerTrade = Math.min(5, Math.max(0.1, Number(next.riskPctPerTrade) || 1));
  next.maxLeverage = Math.min(10, Math.max(1, Number(next.maxLeverage) || 3));
  next.maxConcurrent = Math.min(4, Math.max(1, Number(next.maxConcurrent) || 2));
  next.minRR = Math.max(1, Number(next.minRR) || 1.5);
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
