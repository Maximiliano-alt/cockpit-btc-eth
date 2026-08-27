// Motor de asignación de tendencia — la estrategia que SÍ superó la Compuerta 0.
//
// Cambio de fondo respecto al motor anterior: ya no hay "operaciones" con stop
// y objetivo. Hay una EXPOSICIÓN que vale 1 (dentro) o 0 (en efectivo), y se
// revisa una vez por ciclo. Mientras el cierre diario esté sobre su media de
// 50, se mantiene la posición; cuando pierde la media, se sale a efectivo.
//
// Evidencia (tools/trend.mjs, 7 años, BTC y ETH, entrenamiento y verificación
// por separado): peor tramo +26%/año con la MA50, frente a las 15 variantes de
// operaciones con stop que fallaron todas. Detalle decisivo: las versiones
// largo/corto pierden dinero, por eso aquí NUNCA se abre un corto.
//
// Sin apalancamiento por diseño: el notional nunca supera el capital asignado.
import { BinanceFutures, roundStep } from "./broker.mjs";
import { fetchCandles } from "../../../src/data/candles.js";
import { getConfig, setConfig, getRuntime, setRuntime, appendLog, todayKey } from "./botstate.mjs";

/** Media simple de los últimos `n` cierres. */
function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

/**
 * Señal de exposición para un símbolo: 1 = dentro, 0 = efectivo.
 * Usa SOLO velas diarias ya cerradas, así que no depende de la vela en curso.
 */
/**
 * Trailing stop como red de seguridad, no como generador de rentabilidad.
 * Medido sobre 7 años: con 20% el peor tramo pasa de 26,0% a 28,3% anual y la
 * caída máxima apenas se mueve (59%), porque la salida por MA50 casi siempre
 * salta antes. Su valor real es cubrir un desplome más rápido de lo que la
 * media puede reaccionar. Con 10% recorta la caída al 54% pero destroza la
 * rentabilidad en tendencia (BTC de +73% a +27% anual), así que no se usa.
 */
export function trailingCheck({ peak, price, trailPct }) {
  if (!peak || !trailPct) return { hit: false, peak: Math.max(peak || 0, price) };
  const newPeak = Math.max(peak, price);
  return { hit: price <= newPeak * (1 - trailPct / 100), peak: newPeak, drawdownPct: ((price - newPeak) / newPeak) * 100 };
}

export async function trendSignal(symbol, maPeriod) {
  const candles = await fetchCandles(symbol, "1d", Math.max(maPeriod + 60, 200));
  if (candles.length < maPeriod + 2) {
    return { symbol, target: 0, reason: "sin histórico suficiente", ready: false };
  }
  // Descartamos la vela de hoy (aún abierta): la decisión se toma sobre cierres
  // confirmados, igual que en el backtest.
  const closed = candles.slice(0, -1);
  const closes = closed.map((c) => c.c);
  const last = closes[closes.length - 1];
  const ma = sma(closes, maPeriod);
  if (ma == null) return { symbol, target: 0, reason: "sin media", ready: false };

  const distPct = ((last - ma) / ma) * 100;
  const target = last > ma ? 1 : 0;
  return {
    symbol, target, ready: true,
    close: last, ma, distPct,
    reason: target === 1
      ? `cierre ${last.toFixed(0)} sobre MA${maPeriod} ${ma.toFixed(0)} (+${distPct.toFixed(1)}%) → dentro`
      : `cierre ${last.toFixed(0)} bajo MA${maPeriod} ${ma.toFixed(0)} (${distPct.toFixed(1)}%) → efectivo`,
  };
}

function hardGates(config) {
  if (process.env.BOT_ENABLED !== "true") {
    return "BOT_ENABLED no está en 'true' en Netlify — el bot solo simula.";
  }
  if (config.mode === "live" && process.env.BOT_ALLOW_LIVE !== "true") {
    return "Modo live sin BOT_ALLOW_LIVE — bloqueado por seguridad.";
  }
  if (!process.env.BROKER_API_KEY || !process.env.BROKER_API_SECRET) {
    return "Faltan BROKER_API_KEY o BROKER_API_SECRET.";
  }
  return null;
}

/**
 * Un ciclo completo: lee señal por símbolo, la compara con la posición real
 * y ajusta. Idempotente — si la exposición ya coincide, no toca nada.
 */
export async function runTrendCycle({ manual = false } = {}) {
  const config = await getConfig();
  const decisions = [];
  const summary = {
    at: Date.now(), manual, strategy: "trend", mode: config.mode,
    armed: config.armed, maPeriod: config.maPeriod, decisions,
  };

  const gateMsg = hardGates(config);
  const canExecute = config.armed && !gateMsg;
  if (gateMsg) summary.gate = gateMsg;

  // Señales primero: siempre se calculan, aunque no se pueda ejecutar. Así la
  // bitácora sirve para observar la estrategia antes de armarla.
  const signals = [];
  for (const symbol of config.symbols) {
    try {
      signals.push(await trendSignal(symbol, config.maPeriod));
    } catch (e) {
      signals.push({ symbol, target: 0, ready: false, reason: `error de datos: ${String(e.message || e).slice(0, 90)}` });
    }
  }

  if (!canExecute) {
    for (const s of signals) {
      decisions.push({ symbol: s.symbol, action: "signal-only", target: s.target, reason: `${s.reason} — no ejecutado (${gateMsg || "bot desarmado"})` });
    }
    await appendLog({ type: "cycle", ...summary });
    return summary;
  }

  const broker = new BinanceFutures({
    mode: config.mode,
    apiKey: process.env.BROKER_API_KEY,
    apiSecret: process.env.BROKER_API_SECRET,
  });

  let account;
  try {
    account = await broker.account();
  } catch (e) {
    summary.error = `No se pudo leer la cuenta: ${String(e.message || e).slice(0, 140)}`;
    await appendLog({ type: "error", ...summary });
    return summary;
  }
  summary.equity = account.equity;

  // Corte por pérdida diaria: si el capital cae más del límite respecto al
  // inicio del día, se desarma y se sale de todo.
  const rt = await getRuntime();
  const key = todayKey();
  if (rt.dayKey !== key) await setRuntime({ dayKey: key, dayStartEquity: account.equity });
  const dayStart = rt.dayKey === key ? rt.dayStartEquity : account.equity;
  if (dayStart > 0) {
    const dd = ((account.equity - dayStart) / dayStart) * 100;
    summary.dayPnlPct = dd;
    if (dd <= -Math.abs(config.dailyLossLimitPct)) {
      summary.halt = `Pérdida diaria ${dd.toFixed(2)}% supera el límite ${config.dailyLossLimitPct}% — bot desarmado.`;
      for (const p of account.positions) {
        try { await broker.closePosition(p.symbol, p.amt); } catch { /* se reintenta al siguiente ciclo */ }
      }
      await setConfig({ armed: false });
      await appendLog({ type: "halt", ...summary });
      return summary;
    }
  }

  const info = await broker.symbolInfo();
  const held = Object.fromEntries(account.positions.map((p) => [p.symbol, p.amt]));

  // Estado del trailing por símbolo: máximo alcanzado desde la entrada y si
  // el trailing ya saltó (en ese caso no se reentra hasta que la señal base
  // se apague, para no volver a comprar al día siguiente).
  const trail = { ...(rt.trail || {}) };

  // Capital por símbolo: se reparte el capital entre los activos configurados.
  // Sin apalancamiento: la suma de notional nunca supera el capital.
  const perSymbol = (account.equity * (config.allocationPct / 100)) / config.symbols.length;

  for (const s of signals) {
    const amt = held[s.symbol] || 0;
    const f = info[s.symbol];
    if (!s.ready) { decisions.push({ symbol: s.symbol, action: "skip", reason: s.reason }); continue; }
    if (!f) { decisions.push({ symbol: s.symbol, action: "skip", reason: "símbolo no disponible en el broker" }); continue; }

    // Seguridad: si por lo que sea existiera un corto, se cierra. Esta
    // estrategia solo opera largo o efectivo.
    if (amt < 0) {
      try {
        await broker.closePosition(s.symbol, amt);
        decisions.push({ symbol: s.symbol, action: "close-short", reason: "esta estrategia no opera cortos — posición corta cerrada" });
      } catch (e) {
        decisions.push({ symbol: s.symbol, action: "error", reason: String(e.message || e).slice(0, 120) });
      }
      continue;
    }

    const inPosition = amt > 0;
    const st = trail[s.symbol] || {};

    // Si la señal base se apagó, se levanta cualquier bloqueo de trailing.
    if (s.target === 0 && st.lockedOut) { trail[s.symbol] = {}; }

    // Trailing: se evalúa con el precio en vivo, no con el cierre diario,
    // que es justo el caso que la MA no cubre (desplome intradía).
    if (inPosition && config.trailPct > 0) {
      let price;
      try { price = await broker.price(s.symbol); } catch { price = null; }
      if (price) {
        const t = trailingCheck({ peak: st.peak || price, price, trailPct: config.trailPct });
        if (t.hit) {
          try {
            await broker.closePosition(s.symbol, amt);
            trail[s.symbol] = { lockedOut: true };
            decisions.push({
              symbol: s.symbol, action: "trail-exit", qty: amt, price,
              reason: `trailing ${config.trailPct}%: ${price.toFixed(0)} cayó ${Math.abs(t.drawdownPct).toFixed(1)}% desde el máximo ${t.peak.toFixed(0)} de esta posición`,
            });
          } catch (e) {
            decisions.push({ symbol: s.symbol, action: "error", reason: String(e.message || e).slice(0, 120) });
          }
          continue;
        }
        trail[s.symbol] = { ...st, peak: t.peak };
      }
    }

    // Bloqueado tras un trailing: no reentrar mientras la señal siga encendida.
    if (!inPosition && st.lockedOut && s.target === 1) {
      decisions.push({ symbol: s.symbol, action: "stay-out", reason: `bloqueado tras salida por trailing — se reentra cuando la señal se apague y vuelva a encenderse` });
      continue;
    }

    if (s.target === 1 && !inPosition) {
      try {
        const price = await broker.price(s.symbol);
        const qty = roundStep(perSymbol / price, f.stepSize);
        if (qty <= 0 || qty * price < f.minNotional) {
          decisions.push({ symbol: s.symbol, action: "skip", reason: `capital insuficiente: ${(perSymbol).toFixed(0)} USDT no alcanza el mínimo de ${f.minNotional}` });
          continue;
        }
        await broker.setLeverage(s.symbol, 1);
        const r = await broker.marketOrder({ symbol: s.symbol, side: "BUY", quantity: qty });
        trail[s.symbol] = { peak: price };
        decisions.push({ symbol: s.symbol, action: "enter", qty, price, orderId: r.orderId, reason: s.reason });
      } catch (e) {
        decisions.push({ symbol: s.symbol, action: "error", reason: String(e.message || e).slice(0, 120) });
      }
    } else if (s.target === 0 && inPosition) {
      try {
        await broker.closePosition(s.symbol, amt);
        trail[s.symbol] = {};
        decisions.push({ symbol: s.symbol, action: "exit", qty: amt, reason: s.reason });
      } catch (e) {
        decisions.push({ symbol: s.symbol, action: "error", reason: String(e.message || e).slice(0, 120) });
      }
    } else {
      decisions.push({
        symbol: s.symbol,
        action: inPosition ? "hold" : "stay-out",
        reason: inPosition ? `mantener posición · ${s.reason}` : `seguir en efectivo · ${s.reason}`,
      });
    }
  }

  await setRuntime({ trail });
  await appendLog({ type: "cycle", ...summary });
  return summary;
}
