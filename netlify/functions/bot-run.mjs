// Función programada: ejecuta un ciclo del bot cada 15 minutos.
// Todas las compuertas de seguridad viven dentro de runCycle — si el bot está
// desarmado o faltan claves, este ciclo solo registra señales sin operar.
import { runCycle } from "./_lib/botengine.mjs";

export default async () => {
  try {
    const summary = await runCycle();
    console.log(`[bot] ciclo ${summary.armed ? "ARMADO" : "simulación"} · ${summary.decisions.length} decisiones`);
  } catch (e) {
    console.error("[bot] ciclo falló:", e);
  }
};

export const config = { schedule: "*/15 * * * *" };
