// Puente entre el análisis del cockpit y el bot.
//
// Decisión de diseño importante: este contexto NO decide entradas ni salidas.
// Se midió (7 años, BTC y ETH) usar el sentimiento para modular el tamaño y
// TODAS las variantes empeoraron el resultado: el peor tramo bajaba de 26,0%
// a entre 17,8% y 21,7% anual, porque en cripto la euforia persiste y recortar
// exposición durante la codicia te saca de la parte más rentable de la
// tendencia.
//
// Lo que sí aporta es TRAZABILIDAD: junto a cada decisión del bot queda
// registrado qué decía el resto del cockpit en ese momento, y se marca cuando
// el análisis contradice a la posición abierta. Así el bot sigue ejecutando la
// regla probada, pero tú ves cuándo el contexto discrepa y puedes intervenir.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "ai-cache", consistency: "strong" });

async function read(key) {
  try { return await store().get(key, { type: "json" }); } catch { return null; }
}

/**
 * Foto del análisis del cockpit en este instante, tomada de los mismos blobs
 * que alimentan la interfaz — sin recalcular nada ni gastar cuota de IA.
 */
export async function cockpitSnapshot() {
  const [zones, diag, summary] = await Promise.all([
    read("zones"), read("diagnosis"), read("market-summary"),
  ]);

  const zoneData = zones?.data?.zones || null;
  const veredicto = diag?.data?.text
    ? (diag.data.text.match(/VEREDICTO:\s*([^\n]+)/i)?.[1] || diag.data.text.split("\n")[0]).slice(0, 220)
    : null;

  return {
    at: Date.now(),
    zonas: zoneData ? Object.fromEntries(Object.entries(zoneData).map(([sym, z]) => [sym, {
      poi: z.zones?.find((x) => x.kind === "poi") || null,
      target: z.zones?.find((x) => x.kind === "target") || null,
      invalidacion: z.lines?.find((l) => l.kind === "stop")?.price ?? null,
      comentario: z.comment || null,
    }])) : null,
    zonasAt: zones?.at || null,
    veredicto,
    diagnosticoAt: diag?.at || null,
    resumenMercado: summary?.data?.text ? summary.data.text.slice(0, 400) : null,
  };
}

/**
 * Divergencias entre lo que hace el bot y lo que dice el análisis.
 * Son AVISOS para el operador, no órdenes: el bot no cambia su conducta.
 */
export function divergences({ snapshot, positions, signals }) {
  const out = [];
  if (!snapshot) return out;

  for (const s of signals || []) {
    const pos = (positions || []).find((p) => p.symbol === s.symbol);
    const z = snapshot.zonas?.[s.symbol];
    if (!z) continue;

    // Dentro pero por debajo de la invalidación estructural del análisis.
    if (pos && z.invalidacion && s.close && s.close < z.invalidacion) {
      out.push({
        symbol: s.symbol, level: "alto",
        text: `Posición abierta con el precio (${s.close.toFixed(0)}) por DEBAJO de la invalidación del análisis (${z.invalidacion.toFixed(0)}). La MA50 aún no ha salido, pero la tesis estructural está rota.`,
      });
    }
    // Dentro y ya en la zona de liquidez objetivo: el análisis esperaría toma
    // de beneficio ahí, la estrategia deja correr.
    if (pos && z.target && s.close && s.close >= z.target.from) {
      out.push({
        symbol: s.symbol, level: "info",
        text: `Precio dentro del imán de liquidez del análisis (${z.target.from.toFixed(0)}–${z.target.to.toFixed(0)}). La estrategia no toma beneficio ahí a propósito: recortar ganadores empeoró el resultado en las pruebas.`,
      });
    }
  }

  if (snapshot.veredicto && /no operar|esperar|inacci/i.test(snapshot.veredicto) && (positions || []).length) {
    out.push({
      symbol: "—", level: "info",
      text: `El diagnóstico del día dice "${snapshot.veredicto.slice(0, 110)}" mientras el bot mantiene ${positions.length} posición(es). Es esperable: el diagnóstico juzga entradas NUEVAS y el bot ya está dentro por tendencia.`,
    });
  }
  return out;
}
