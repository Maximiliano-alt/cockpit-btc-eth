// API de control del bot para el panel del cockpit.
// GET  → estado completo (config, cuenta, posiciones, bitácora)
// POST → { action: "arm" | "disarm" | "config" | "run" | "close-all" }
//
// Nota de seguridad: esta función NO permite pasar a modo real. Cambiar a
// "live" exige la variable BOT_ALLOW_LIVE en Netlify, que solo puede poner el
// dueño de la cuenta. El botón de pánico (disarm/close-all) siempre funciona,
// incluso si el resto está mal configurado.
import { BinanceFutures } from "./_lib/broker.mjs";
import { getConfig, setConfig, getLog, getRuntime } from "./_lib/botstate.mjs";
import { runTrendCycle, trendSignal } from "./_lib/trendengine.mjs";

function creds(config) {
  return config.mode === "live"
    ? { apiKey: process.env.BROKER_API_KEY_LIVE, apiSecret: process.env.BROKER_API_SECRET_LIVE }
    : { apiKey: process.env.BROKER_API_KEY, apiSecret: process.env.BROKER_API_SECRET };
}

/**
 * Estado de la cuenta con todo lo que el panel necesita: posiciones abiertas
 * con su P&L latente, órdenes pendientes e historial de cierres con P&L
 * acumulado. Cada parte se pide por separado para que el fallo de una no
 * tumbe al resto.
 */
async function accountSnapshot(config) {
  const c = creds(config);
  if (!c.apiKey || !c.apiSecret) return { connected: false, reason: "sin claves de API configuradas" };
  try {
    const broker = new BinanceFutures({ mode: config.mode, ...c });
    const a = await broker.account();
    const [pending, history] = await Promise.allSettled([
      broker.openOrders(),
      broker.closedTrades(90),
    ]);

    // Precio actual por símbolo para calcular el rendimiento de cada posición.
    const marks = {};
    await Promise.allSettled(a.positions.map(async (p) => {
      marks[p.symbol] = await broker.price(p.symbol);
    }));
    const positions = a.positions.map((p) => {
      const mark = marks[p.symbol] ?? null;
      const notional = mark ? Math.abs(p.amt) * mark : null;
      return {
        ...p, mark, notional,
        pnlPct: p.entry > 0 && mark ? ((mark - p.entry) / p.entry) * 100 * Math.sign(p.amt) : null,
      };
    });

    return {
      connected: true,
      ...a,
      positions,
      host: broker.host,
      pending: pending.status === "fulfilled" ? pending.value : [],
      pendingError: pending.status === "rejected" ? String(pending.reason?.message || pending.reason).slice(0, 120) : null,
      history: history.status === "fulfilled" ? history.value : null,
      historyError: history.status === "rejected" ? String(history.reason?.message || history.reason).slice(0, 120) : null,
    };
  } catch (e) {
    return { connected: false, reason: String(e.message || e).slice(0, 160) };
  }
}

/**
 * Diagnóstico de alcance: Binance bloquea por IP según el país, y las
 * functions corren en AWS (EE.UU.). Esto dice, desde el servidor real, qué
 * hosts responden y cuáles devuelven 451, que es lo que decide si el bot
 * puede operar desde aquí o hace falta otro alojamiento.
 */
async function reachability() {
  const hosts = {
    "demo-fapi.binance.com": "https://demo-fapi.binance.com/fapi/v1/ping",
    "testnet.binancefuture.com": "https://testnet.binancefuture.com/fapi/v1/ping",
    "fapi.binance.com": "https://fapi.binance.com/fapi/v1/ping",
    "data-api.binance.vision": "https://data-api.binance.vision/api/v3/ping",
  };
  const out = {};
  await Promise.all(Object.entries(hosts).map(async ([name, url]) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      out[name] = r.status;
    } catch (e) {
      out[name] = e.name === "AbortError" ? "timeout" : "error";
    } finally { clearTimeout(t); }
  }));
  return out;
}

export default async (req) => {
  const config = await getConfig();

  if (req.method === "GET" && new URL(req.url).searchParams.get("diag") === "1") {
    return Response.json({ reachability: await reachability(), region: process.env.AWS_REGION || null });
  }

  if (req.method === "GET") {
    const [account, log, runtime, ...sig] = await Promise.all([
      accountSnapshot(config), getLog(), getRuntime(),
      ...config.symbols.map((s) => trendSignal(s, config.maPeriod).catch((e) => ({ symbol: s, ready: false, reason: String(e.message || e).slice(0, 90) }))),
    ]);
    return Response.json({
      config,
      account,
      signals: sig,
      log: log.slice(0, 12),
      runtime,
      env: {
        enabled: process.env.BOT_ENABLED === "true",
        liveAllowed: process.env.BOT_ALLOW_LIVE === "true",
        hasKeys: !!(process.env.BROKER_API_KEY && process.env.BROKER_API_SECRET),
        demoHost: process.env.BROKER_DEMO_HOST || "demo",
      },
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body = {};
  try { body = await req.json(); } catch { /* sin cuerpo */ }
  const action = body.action;

  try {
    if (action === "arm") {
      if (process.env.BOT_ENABLED !== "true") {
        return Response.json({ error: "BOT_ENABLED no está activo en Netlify. El bot no puede armarse." }, { status: 400 });
      }
      const next = await setConfig({ armed: true });
      return Response.json({ ok: true, config: next });
    }

    if (action === "disarm") {
      const next = await setConfig({ armed: false });
      return Response.json({ ok: true, config: next });
    }

    if (action === "config") {
      const allowed = ["symbols", "maPeriod", "allocationPct", "dailyLossLimitPct"];
      const patch = Object.fromEntries(
        Object.entries(body.config || {}).filter(([k]) => allowed.includes(k))
      );
      const next = await setConfig(patch);
      return Response.json({ ok: true, config: next });
    }

    if (action === "run") {
      const summary = await runTrendCycle({ manual: true });
      return Response.json({ ok: true, summary });
    }

    if (action === "close-all") {
      const c = creds(config);
      if (!c.apiKey) return Response.json({ error: "sin claves de API" }, { status: 400 });
      const broker = new BinanceFutures({ mode: config.mode, ...c });
      const a = await broker.account();
      const closed = [];
      for (const p of a.positions) {
        try {
          await broker.closePosition(p.symbol, p.amt);
          closed.push(p.symbol);
        } catch (e) {
          closed.push(`${p.symbol}: ${String(e.message).slice(0, 80)}`);
        }
      }
      await setConfig({ armed: false });
      return Response.json({ ok: true, closed });
    }

    return Response.json({ error: "acción desconocida" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e).slice(0, 300) }, { status: 500 });
  }
};
