// Ciclo del bot: evalúa el mercado, aplica todas las compuertas de riesgo y,
// solo si TODAS pasan, ejecuta. Usado por la función programada (bot-run) y
// por la ejecución manual desde la UI (bot-control).
import { getStore } from "@netlify/blobs";
import { BinanceFutures, roundStep, roundTick } from "./broker.mjs";
import { analyzeSymbol, buildSignal } from "./strategy.mjs";
import { getConfig, getRuntime, setRuntime, appendLog, todayKey } from "./botstate.mjs";

/** Compuertas que no dependen del mercado. Devuelve null si todo está OK. */
function hardGates(config) {
  if (process.env.BOT_ENABLED !== "true") {
    return "BOT_ENABLED no está en 'true' en Netlify — el bot solo simula.";
  }
  if (config.mode === "live" && process.env.BOT_ALLOW_LIVE !== "true") {
    return "Modo live sin BOT_ALLOW_LIVE — bloqueado por seguridad.";
  }
  const key = config.mode === "live" ? process.env.BROKER_API_KEY_LIVE : process.env.BROKER_API_KEY;
  const secret = config.mode === "live" ? process.env.BROKER_API_SECRET_LIVE : process.env.BROKER_API_SECRET;
  if (!key || !secret) return `Faltan las claves de API del broker (${config.mode}).`;
  return null;
}

function credsFor(config) {
  return config.mode === "live"
    ? { apiKey: process.env.BROKER_API_KEY_LIVE, apiSecret: process.env.BROKER_API_SECRET_LIVE }
    : { apiKey: process.env.BROKER_API_KEY, apiSecret: process.env.BROKER_API_SECRET };
}

export async function runCycle({ manual = false } = {}) {
  const config = await getConfig();
  const runtime = await getRuntime();
  const decisions = [];
  const summary = { at: Date.now(), manual, mode: config.mode, armed: config.armed, decisions };

  const gateMsg = hardGates(config);
  const canExecute = config.armed && !gateMsg;

  // Zonas IA vigentes — las calcula la function `zones`, acá solo se leen.
  let zones = null;
  try {
    const cache = getStore({ name: "ai-cache", consistency: "strong" });
    const z = await cache.get("zones", { type: "json" });
    zones = z?.data?.zones || null;
  } catch { /* sin zonas */ }

  if (!zones) {
    summary.note = "Sin zonas IA en cache: no hay niveles para operar.";
    await appendLog({ type: "cycle", ...summary });
    return summary;
  }

  let broker = null, account = null;
  if (!gateMsg) {
    try {
      broker = new BinanceFutures({ mode: config.mode, ...credsFor(config) });
      account = await broker.account();
      summary.equity = account.equity;
      summary.openPositions = account.positions;
    } catch (e) {
      summary.brokerError = String(e.message || e).slice(0, 200);
    }
  } else {
    summary.gate = gateMsg;
  }

  // Límite de pérdida diaria: si el capital cayó más del % configurado desde
  // la marca de apertura del día, el bot se desarma solo.
  if (account) {
    const key = todayKey();
    let mark = runtime.dayMark;
    if (!mark || mark.day !== key) {
      mark = { day: key, equity: account.equity };
      await setRuntime({ dayMark: mark });
    }
    const dd = mark.equity > 0 ? ((account.equity - mark.equity) / mark.equity) * 100 : 0;
    summary.dayPnlPct = Number(dd.toFixed(2));
    if (dd <= -Math.abs(config.dailyLossLimitPct)) {
      const { setConfig } = await import("./botstate.mjs");
      await setConfig({ armed: false });
      summary.note = `Límite de pérdida diaria alcanzado (${dd.toFixed(2)}%). Bot desarmado automáticamente.`;
      await appendLog({ type: "halt", ...summary });
      return summary;
    }
  }

  const openSymbols = new Set((account?.positions || []).map((p) => p.symbol));
  const symbolInfo = broker ? await broker.symbolInfo().catch(() => ({})) : {};

  for (const symbol of config.symbols) {
    try {
      if (openSymbols.has(symbol)) {
        decisions.push({ symbol, action: "hold", reason: "ya hay posición abierta en este símbolo" });
        continue;
      }
      if (openSymbols.size >= config.maxConcurrent) {
        decisions.push({ symbol, action: "none", reason: `máximo de ${config.maxConcurrent} posiciones simultáneas alcanzado` });
        continue;
      }
      const last = runtime.lastTrade?.[symbol];
      if (last && Date.now() - last < config.cooldownMin * 60000) {
        const mins = Math.ceil((config.cooldownMin * 60000 - (Date.now() - last)) / 60000);
        decisions.push({ symbol, action: "none", reason: `en enfriamiento, faltan ${mins} min` });
        continue;
      }

      const analysis = await analyzeSymbol(symbol, zones[symbol]);
      const signal = buildSignal({ symbol, analysis, zone: zones[symbol], config });

      if (signal.action === "none") { decisions.push(signal); continue; }

      if (!canExecute) {
        decisions.push({ ...signal, action: "signal-only", reason: `SEÑAL (no ejecutada — ${gateMsg || "bot desarmado"}): ${signal.reason}` });
        continue;
      }
      if (!account) {
        decisions.push({ ...signal, action: "signal-only", reason: `SEÑAL (sin conexión al broker): ${signal.reason}` });
        continue;
      }

      // ── Dimensionado ──────────────────────────────────────────────
      const info = symbolInfo[symbol] || { stepSize: 0.001, tickSize: 0.01, minNotional: 0, minQty: 0 };
      const px = await broker.price(symbol);
      const stopDist = px * signal.stopPct;
      const riskUsd = account.equity * (config.riskPctPerTrade / 100);
      let qty = riskUsd / stopDist;

      // Techo por apalancamiento y por margen realmente disponible.
      const maxNotional = Math.min(account.equity * config.maxLeverage, account.available * config.maxLeverage * 0.95);
      if (qty * px > maxNotional) qty = maxNotional / px;
      qty = roundStep(qty, info.stepSize);

      if (qty <= 0 || qty < info.minQty) {
        decisions.push({ ...signal, action: "skipped", reason: `cantidad calculada (${qty}) bajo el mínimo del símbolo` });
        continue;
      }
      if (info.minNotional && qty * px < info.minNotional) {
        decisions.push({ ...signal, action: "skipped", reason: `notional ${(qty * px).toFixed(2)} bajo el mínimo ${info.minNotional} — capital insuficiente para el riesgo configurado` });
        continue;
      }

      const long = signal.action === "long";
      const stopPrice = roundTick(long ? px * (1 - signal.stopPct) : px * (1 + signal.stopPct), info.tickSize);
      const tpPrice = roundTick(long ? px * (1 + signal.targetPct) : px * (1 - signal.targetPct), info.tickSize);

      await broker.setLeverage(symbol, config.maxLeverage);
      const order = await broker.openBracket({
        symbol, side: signal.side, quantity: qty, stopPrice, takeProfitPrice: tpPrice,
      });

      await setRuntime({ lastTrade: { ...(runtime.lastTrade || {}), [symbol]: Date.now() } });
      openSymbols.add(symbol);

      decisions.push({
        ...signal,
        action: "executed",
        qty, entryPrice: px, stopPrice, tpPrice,
        notional: Number((qty * px).toFixed(2)),
        riskUsd: Number(riskUsd.toFixed(2)),
        order,
      });
    } catch (e) {
      decisions.push({ symbol, action: "error", reason: String(e.message || e).slice(0, 200) });
    }
  }

  await appendLog({ type: "cycle", ...summary });
  return summary;
}
