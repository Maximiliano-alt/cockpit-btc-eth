// Cruce entre el análisis del canal y el del cockpit.
//
// La idea: dos métodos independientes que señalan el mismo nivel es
// información real; que se contradigan también lo es, y suele ser más útil
// todavía. Esto lo calcula de forma determinista — sin IA, sin coste y sin
// que el contenido de terceros pueda influir en nada más que en su propia
// comparación numérica.
import { getStore } from "@netlify/blobs";

const SYM = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };

// Dos niveles se consideran el mismo si distan menos de esto. 1,5% es lo que
// separa "coinciden" de "hablan de cosas distintas" en cripto: por debajo, la
// diferencia cabe dentro del ruido de una sola vela.
const TOLERANCIA = 0.015;

async function read(key) {
  try {
    return await getStore({ name: "ai-cache", consistency: "strong" }).get(key, { type: "json" });
  } catch { return null; }
}

const cerca = (a, b) => a && b && Math.abs(a - b) / b <= TOLERANCIA;

/**
 * @returns por activo: coincidencias de nivel, choque de sesgo y un veredicto.
 */
export async function crossReference(readings) {
  const [zonesBlob, diagBlob] = await Promise.all([read("zones"), read("diagnosis")]);
  const zones = zonesBlob?.data?.zones || null;
  if (!zones || !readings) return null;

  // Se toma la lectura más reciente que mencione cada activo.
  const porActivo = {};
  for (const r of Object.values(readings)) {
    for (const [sym, d] of Object.entries(r.activos || {})) {
      if (!porActivo[sym]) porActivo[sym] = { ...d, tesis: r.tesis };
    }
  }

  const out = {};
  for (const [sym, canal] of Object.entries(porActivo)) {
    const z = zones[SYM[sym] || sym];
    if (!z) continue;
    const poi = z.zones?.find((x) => x.kind === "poi");
    const target = z.zones?.find((x) => x.kind === "target");
    const inval = z.lines?.find((l) => l.kind === "stop")?.price ?? null;

    const coincidencias = [];
    // Soportes del canal contra el POI del cockpit (ambos son "dónde compra
    // el dinero"), tanto por proximidad a los bordes como por estar dentro.
    for (const s of canal.soportes || []) {
      if (!poi) break;
      if ((s >= poi.from && s <= poi.to) || cerca(s, poi.from) || cerca(s, poi.to)) {
        coincidencias.push({
          tipo: "soporte", nivelCanal: s,
          zonaCockpit: `POI ${poi.from.toFixed(0)}–${poi.to.toFixed(0)}`,
        });
      }
    }
    // Resistencias contra el imán de liquidez.
    for (const rr of canal.resistencias || []) {
      if (!target) break;
      if ((rr >= target.from && rr <= target.to) || cerca(rr, target.from) || cerca(rr, target.to)) {
        coincidencias.push({
          tipo: "resistencia", nivelCanal: rr,
          zonaCockpit: `Liquidez ${target.from.toFixed(0)}–${target.to.toFixed(0)}`,
        });
      }
    }

    // Divergencia de invalidación: si el canal se rinde mucho antes que el
    // cockpit, tu stop efectivo es el suyo, no el del análisis técnico.
    let invalidacion = null;
    if (canal.invalidacion && inval) {
      const dif = ((canal.invalidacion - inval) / inval) * 100;
      invalidacion = {
        canal: canal.invalidacion, cockpit: inval, difPct: dif,
        nota: Math.abs(dif) < 2
          ? "Ambos sitúan la invalidación prácticamente en el mismo punto."
          : dif > 0
            ? `El canal se rinde ${dif.toFixed(1)}% antes que el cockpit: su stop salta primero.`
            : `El canal aguanta ${Math.abs(dif).toFixed(1)}% más abajo que el cockpit.`,
      };
    }

    const n = coincidencias.length;
    out[sym] = {
      canal: { sesgo: canal.sesgo, soportes: canal.soportes, resistencias: canal.resistencias, tesis: canal.tesis },
      cockpit: {
        poi: poi ? [poi.from, poi.to] : null,
        target: target ? [target.from, target.to] : null,
        invalidacion: inval,
      },
      coincidencias,
      invalidacion,
      veredicto: n >= 2
        ? { nivel: "confirma", texto: `${n} niveles coinciden con las zonas del cockpit. Dos métodos independientes señalan lo mismo, lo que refuerza esos niveles.` }
        : n === 1
          ? { nivel: "parcial", texto: "Un nivel coincide con el cockpit; el resto no. Confirmación parcial." }
          : { nivel: "discrepa", texto: "Ningún nivel del canal coincide con las zonas del cockpit. Están leyendo estructuras distintas: conviene entender por qué antes de fiarse de ninguno." },
    };
  }

  return {
    activos: out,
    diagnosticoAt: diagBlob?.at || null,
    zonasAt: zonesBlob?.at || null,
    nota: "Comparación numérica determinista. El canal es una opinión de terceros sin historial medido en este cockpit: sirve como confirmación o alerta, no como validación.",
  };
}
