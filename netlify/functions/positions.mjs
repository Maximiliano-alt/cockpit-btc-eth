// Registro de posiciones manuales — la trazabilidad que Exness no da.
//
// El problema real: en Exness dejas órdenes límite que se acumulan durante
// semanas. Cuando llega el momento, muchas ya no tienen sentido (el precio se
// fue, la estructura cambió, la invalidación se perforó), pero siguen ahí
// consumiendo margen y subiendo el riesgo de la cuenta. Exness no expone API
// pública de trading, así que no se pueden cancelar desde aquí — pero SÍ se
// puede saber cuáles ya no valen.
//
// Cada idea se guarda con su nivel de invalidación y su caducidad; el cockpit
// compara contra el precio en vivo y te dice cuáles cancelar. La ejecución la
// haces tú en Exness; el juicio de vigencia lo lleva el cockpit.
import { getStore } from "@netlify/blobs";
import { fetchCandles } from "../../src/data/candles.js";

const store = () => getStore({ name: "positions", consistency: "strong" });
const KEY = "manual";
const MAX = 100;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function readAll() {
  try { return (await store().get(KEY, { type: "json" })) || []; } catch { return []; }
}
async function writeAll(list) {
  await store().setJSON(KEY, list.slice(0, MAX));
}

const SYMBOL_MAP = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" };

/** Precio actual de cada símbolo con la cadena de respaldo del cockpit. */
async function currentPrices(symbols) {
  const out = {};
  await Promise.all([...new Set(symbols)].map(async (s) => {
    try {
      const c = await fetchCandles(SYMBOL_MAP[s] || s, "1d", 3);
      out[s] = c[c.length - 1].c;
    } catch { out[s] = null; }
  }));
  return out;
}

/**
 * Estado de una idea frente al mercado actual.
 * pendiente  → esperando que el precio llegue a la entrada
 * activa     → el precio pasó por la entrada (asumimos ejecutada)
 * invalidada → el precio perforó el nivel que anula la tesis
 * caducada   → pasó su fecha límite sin activarse
 * objetivo   → alcanzó el objetivo
 */
function evaluate(p, price) {
  if (p.closedAt) return { ...p, estado: "cerrada", motivo: p.closeReason || "cerrada a mano" };
  if (price == null) return { ...p, estado: p.estado || "pendiente", motivo: "sin precio de referencia" };

  const long = (p.side || "long") === "long";
  const hitStop = p.stop != null && (long ? price <= p.stop : price >= p.stop);
  const hitTarget = p.target != null && (long ? price >= p.target : price <= p.target);
  const reachedEntry = p.entry != null && (long ? price <= p.entry : price >= p.entry);
  const expired = p.expiresAt && Date.now() > p.expiresAt;

  if (hitStop) {
    return { ...p, estado: "invalidada", price,
      motivo: `El precio (${price.toFixed(2)}) perforó la invalidación (${p.stop}). Esta idea ya no vale: cancélala en Exness si sigue como orden límite.` };
  }
  if (hitTarget) {
    return { ...p, estado: "objetivo", price,
      motivo: `El precio (${price.toFixed(2)}) alcanzó el objetivo (${p.target}).` };
  }
  if (!p.activatedAt && expired) {
    return { ...p, estado: "caducada", price,
      motivo: `Caducó el ${new Date(p.expiresAt).toLocaleDateString("es")} sin que el precio llegara a la entrada (${p.entry}). Cancélala: ocupa margen sin tesis vigente.` };
  }
  if (p.activatedAt || reachedEntry) {
    const dist = p.stop != null ? ((price - p.stop) / price) * 100 : null;
    return { ...p, estado: "activa", price, activatedAt: p.activatedAt || Date.now(),
      motivo: `Entrada alcanzada. Precio ${price.toFixed(2)}${dist != null ? ` · ${Math.abs(dist).toFixed(1)}% sobre la invalidación` : ""}.` };
  }
  const away = p.entry ? ((price - p.entry) / p.entry) * 100 : null;
  return { ...p, estado: "pendiente", price,
    motivo: `Esperando entrada en ${p.entry}${away != null ? ` · el precio está ${away >= 0 ? "+" : ""}${away.toFixed(1)}% de distancia` : ""}.` };
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const list = await readAll();
    const prices = await currentPrices(list.map((p) => p.symbol));
    const evaluated = list.map((p) => evaluate(p, prices[p.symbol]));
    // Se persiste el paso a "activa" para no perder el momento de activación.
    const changed = evaluated.some((e, i) => e.activatedAt !== list[i].activatedAt);
    if (changed) await writeAll(evaluated.map(({ estado, motivo, price, ...rest }) => rest));

    const vivas = evaluated.filter((p) => ["pendiente", "activa"].includes(p.estado));
    const muertas = evaluated.filter((p) => ["invalidada", "caducada"].includes(p.estado));
    return json({
      positions: evaluated,
      prices,
      resumen: {
        total: evaluated.length,
        vivas: vivas.length,
        porCancelar: muertas.length,
        capitalComprometido: vivas.reduce((s, p) => s + (Number(p.riskUsd) || 0), 0),
      },
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const list = await readAll();

  if (body.action === "add") {
    const p = body.position || {};
    if (!p.symbol || p.entry == null) return json({ error: "faltan symbol y entry" }, 400);
    const days = Number(p.validDays) || 14;
    const next = [{
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: String(p.symbol).toUpperCase().slice(0, 10),
      side: p.side === "short" ? "short" : "long",
      entry: Number(p.entry),
      stop: p.stop != null ? Number(p.stop) : null,
      target: p.target != null ? Number(p.target) : null,
      riskUsd: p.riskUsd != null ? Number(p.riskUsd) : null,
      note: String(p.note || "").slice(0, 200),
      source: String(p.source || "manual").slice(0, 40),
      createdAt: Date.now(),
      expiresAt: Date.now() + days * 864e5,
      activatedAt: null,
      closedAt: null,
    }, ...list];
    await writeAll(next);
    return json({ ok: true, count: next.length });
  }

  if (body.action === "close") {
    const next = list.map((p) => p.id === body.id
      ? { ...p, closedAt: Date.now(), closeReason: String(body.reason || "cerrada a mano").slice(0, 120) }
      : p);
    await writeAll(next);
    return json({ ok: true });
  }

  if (body.action === "delete") {
    await writeAll(list.filter((p) => p.id !== body.id));
    return json({ ok: true });
  }

  // Limpieza en bloque: quita todo lo que ya no vale.
  if (body.action === "purge") {
    const prices = await currentPrices(list.map((p) => p.symbol));
    const keep = list.filter((p) => {
      const e = evaluate(p, prices[p.symbol]);
      return !["invalidada", "caducada", "cerrada", "objetivo"].includes(e.estado);
    });
    await writeAll(keep);
    return json({ ok: true, eliminadas: list.length - keep.length });
  }

  return json({ error: "acción desconocida" }, 400);
};
