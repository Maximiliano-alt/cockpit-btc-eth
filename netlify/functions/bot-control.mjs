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
import { runCycle } from "./_lib/botengine.mjs";

function creds(config) {
  return config.mode === "live"
    ? { apiKey: process.env.BROKER_API_KEY_LIVE, apiSecret: process.env.BROKER_API_SECRET_LIVE }
    : { apiKey: process.env.BROKER_API_KEY, apiSecret: process.env.BROKER_API_SECRET };
}

async function accountSnapshot(config) {
  const c = creds(config);
  if (!c.apiKey || !c.apiSecret) return { connected: false, reason: "sin claves de API configuradas" };
  try {
    const broker = new BinanceFutures({ mode: config.mode, ...c });
    const a = await broker.account();
    return { connected: true, ...a };
  } catch (e) {
    return { connected: false, reason: String(e.message || e).slice(0, 160) };
  }
}

export default async (req) => {
  const config = await getConfig();

  if (req.method === "GET") {
    const [account, log, runtime] = await Promise.all([
      accountSnapshot(config), getLog(), getRuntime(),
    ]);
    return Response.json({
      config,
      account,
      log: log.slice(0, 12),
      runtime,
      env: {
        enabled: process.env.BOT_ENABLED === "true",
        liveAllowed: process.env.BOT_ALLOW_LIVE === "true",
        hasKeys: !!(process.env.BROKER_API_KEY && process.env.BROKER_API_SECRET),
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
      const allowed = [
        "symbols", "riskPctPerTrade", "maxConcurrent", "maxLeverage",
        "minScore", "minAlignment", "minRR", "maxChasePct",
        "dailyLossLimitPct", "cooldownMin", "allowShorts",
      ];
      const patch = Object.fromEntries(
        Object.entries(body.config || {}).filter(([k]) => allowed.includes(k))
      );
      const next = await setConfig(patch);
      return Response.json({ ok: true, config: next });
    }

    if (action === "run") {
      const summary = await runCycle({ manual: true });
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
