// Función programada del bot.
// Todas las compuertas de seguridad viven dentro de runTrendCycle — si el bot
// está desarmado o faltan claves, el ciclo solo registra señales sin operar.
//
// Cada hora, no cada 15 min: la señal se calcula sobre CIERRES DIARIOS, así que
// solo puede cambiar una vez al día. Revisar más a menudo no aporta y sí gasta
// invocaciones. Al ser idempotente, si la exposición ya coincide no toca nada.
import { runTrendCycle } from "./_lib/trendengine.mjs";

export default async () => {
  try {
    const s = await runTrendCycle();
    console.log(`[bot] ciclo ${s.armed ? "ARMADO" : "simulación"} · ${s.decisions.map((d) => `${d.symbol}:${d.action}`).join(" ")}`);
  } catch (e) {
    console.error("[bot] ciclo falló:", e);
  }
};

export const config = { schedule: "7 * * * *" };
