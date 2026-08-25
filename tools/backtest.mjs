// Backtester del motor de decisión del cockpit.
//
// Por qué existe: el bot ejecuta señales, pero hasta ahora NADIE había medido
// si esas señales tienen ventaja. Reglas que suenan razonables (SMC, sesgo
// multi-temporal) pueden perfectamente tener esperanza negativa después de
// comisiones. Esto lo mide sobre años de datos reales.
//
// Regla de oro implementada: CERO lookahead. En la barra i solo se usan datos
// hasta i, y la entrada ocurre a la apertura de i+1 (nunca al cierre que
// generó la señal, que sería imposible en vivo).
//
// Uso:
//   node tools/backtest.mjs [--symbol BTCUSDT] [--years 3] [--minScore 25]
//                           [--minRR 1.5] [--risk 1] [--atr 1.5] [--sweep]

import { timeframeBias, detectStructure } from "../src/ros/structure.js";
import { compositeBias } from "../src/ros/decisionEngine.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const SYMBOL = args.symbol || "BTCUSDT";
const YEARS = parseFloat(args.years || 3);
const MIN_SCORE = parseFloat(args.minScore || 25);
const MIN_ALIGN = parseFloat(args.minAlignment || 50);
const MIN_RR = parseFloat(args.minRR || 1.5);
const RISK_PCT = parseFloat(args.risk || 1);
const ATR_MULT = parseFloat(args.atr || 1.5);
const ALLOW_SHORTS = args.noShorts ? false : true;
const REQUIRE_TRIGGER = args.noTrigger ? false : true;
const COOLDOWN_BARS = parseInt(args.cooldownBars || 6, 10); // 6 barras 4H = 24 h

// Coste realista de ida y vuelta en Binance Futures: taker 0.05% por lado
// más deslizamiento. Se aplica al precio de entrada y de salida.
const COST_PER_SIDE = 0.0006;

const HOST = "https://data-api.binance.vision";

async function fetchAll4h(symbol, years) {
  const out = [];
  const needed = Math.ceil((years * 365 * 24) / 4);
  let end = Date.now();
  while (out.length < needed) {
    const url = `${HOST}/api/v3/klines?symbol=${symbol}&interval=4h&limit=1000&endTime=${end}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("klines HTTP " + res.status);
    const j = await res.json();
    if (!j.length) break;
    out.unshift(...j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
    end = j[0][0] - 1;
    if (j.length < 1000) break;
  }
  // Deduplicar y ordenar por si acaso.
  const seen = new Set();
  return out.filter((c) => !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

/** Agrupa velas de 4H en marcos mayores (n = cuántas 4H por vela). */
function aggregate(c4h, n) {
  const out = [];
  for (let i = 0; i < c4h.length; i += n) {
    const g = c4h.slice(i, i + n);
    if (!g.length) continue;
    out.push({
      t: g[0].t, o: g[0].o, c: g[g.length - 1].c,
      h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
    });
  }
  return out;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const p = candles[i - 1];
    sum += Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - p.c),
      Math.abs(candles[i].l - p.c)
    );
  }
  return sum / period;
}

function runBacktest(c4h, opts) {
  const { minScore, minAlign, minRR, riskPct, atrMult, allowShorts, requireTrigger } = opts;

  // Se necesita historia suficiente para que los marcos altos tengan sentido:
  // 180 barras de 4H ≈ 30 días → arrancamos bien pasado eso.
  const START = 1200;
  let equity = 10000;
  const startEquity = equity;
  let peak = equity;
  let maxDD = 0;
  const trades = [];
  let open = null;
  let lastExitBar = -Infinity;
  const equityCurve = [];

  for (let i = START; i < c4h.length - 1; i++) {
    const bar = c4h[i];

    // ── Gestión de la posición abierta: ¿tocó stop o target en ESTA barra?
    if (open) {
      const hitStop = open.dir === 1 ? bar.l <= open.stop : bar.h >= open.stop;
      const hitTgt = open.dir === 1 ? bar.h >= open.target : bar.l <= open.target;
      let exit = null;
      // Pesimista a propósito: si la barra abarca ambos, asumimos que saltó
      // el stop primero. Sin datos intrabar no se puede saber, y suponer lo
      // contrario infla los resultados de forma sistemática.
      if (hitStop) exit = { price: open.stop, why: "stop" };
      else if (hitTgt) exit = { price: open.target, why: "target" };

      if (exit) {
        const gross = (exit.price - open.entry) * open.dir;
        const costs = (open.entry + exit.price) * COST_PER_SIDE;
        const pnlPerUnit = gross - costs;
        const pnl = pnlPerUnit * open.qty;
        equity += pnl;
        trades.push({
          dir: open.dir, entry: open.entry, exit: exit.price, why: exit.why,
          pnl, r: pnlPerUnit / open.riskPerUnit, bars: i - open.bar,
          t: new Date(open.t).toISOString().slice(0, 10),
        });
        open = null;
        lastExitBar = i;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
      }
    }
    equityCurve.push(equity);
    if (open || i - lastExitBar < COOLDOWN_BARS) continue;

    // ── Señal: SOLO con datos hasta la barra i (sin mirar el futuro).
    const hist4h = c4h.slice(Math.max(0, i - 199), i + 1);
    const upTo = c4h.slice(0, i + 1);
    const tf = {
      h4: timeframeBias(hist4h),
      d1: timeframeBias(aggregate(upTo, 6).slice(-200)),
      w1: timeframeBias(aggregate(upTo, 42).slice(-120)),
      mn: timeframeBias(aggregate(upTo, 180).slice(-60)),
    };
    const bias = compositeBias(tf);
    if (Math.abs(bias.score) < minScore) continue;
    if (bias.alignment < minAlign) continue;

    const dir = bias.score > 0 ? 1 : -1;
    if (dir === -1 && !allowShorts) continue;

    if (requireTrigger) {
      const trg = detectStructure(hist4h);
      if (!(trg.choch || trg.bos || trg.liquiditySweep)) continue;
    }

    const a = atr(hist4h);
    if (!a) continue;

    // Entrada a la apertura de la SIGUIENTE barra: lo único ejecutable en vivo.
    const entry = c4h[i + 1].o;
    const riskPerUnit = a * atrMult;
    const stop = entry - dir * riskPerUnit;
    const target = entry + dir * riskPerUnit * minRR;

    const riskUsd = equity * (riskPct / 100);
    const qty = riskUsd / riskPerUnit;

    open = { dir, entry, stop, target, qty, riskPerUnit, bar: i + 1, t: c4h[i + 1].t };
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalR = trades.reduce((s, t) => s + t.r, 0);

  return {
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : 0),
    expectancyR: trades.length ? totalR / trades.length : 0,
    totalReturnPct: ((equity - startEquity) / startEquity) * 100,
    maxDDPct: maxDD * 100,
    finalEquity: equity,
    list: trades,
    equityCurve,
  };
}

function fmt(n, d = 2) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

const c4h = await fetchAll4h(SYMBOL, YEARS);
const days = (c4h[c4h.length - 1].t - c4h[0].t) / 864e5;
const bh = ((c4h[c4h.length - 1].c - c4h[0].c) / c4h[0].c) * 100;

console.log(`\n${"═".repeat(74)}`);
console.log(`BACKTEST · ${SYMBOL} · ${c4h.length} velas 4H · ${(days / 365).toFixed(1)} años`);
console.log(`${new Date(c4h[0].t).toISOString().slice(0, 10)} → ${new Date(c4h[c4h.length - 1].t).toISOString().slice(0, 10)}`);
console.log(`Comprar y mantener en el mismo periodo: ${bh >= 0 ? "+" : ""}${fmt(bh, 1)}%`);
console.log(`${"═".repeat(74)}\n`);

const baseOpts = {
  minScore: MIN_SCORE, minAlign: MIN_ALIGN, minRR: MIN_RR,
  riskPct: RISK_PCT, atrMult: ATR_MULT,
  allowShorts: ALLOW_SHORTS, requireTrigger: REQUIRE_TRIGGER,
};

if (args.sweep) {
  console.log("Barrido de parámetros (riesgo 1%/trade):\n");
  console.log("minScore  R:R   trades  aciertos  factor  esperanza   retorno   maxDD");
  console.log("─".repeat(74));
  for (const ms of [15, 25, 35, 45]) {
    for (const rr of [1.5, 2, 3]) {
      const r = runBacktest(c4h, { ...baseOpts, minScore: ms, minRR: rr });
      console.log(
        `${String(ms).padStart(6)}  ${String(rr).padStart(4)}  ${String(r.trades).padStart(6)}  ` +
        `${fmt(r.winRate, 1).padStart(7)}%  ${fmt(r.profitFactor).padStart(6)}  ` +
        `${(r.expectancyR >= 0 ? "+" : "") + fmt(r.expectancyR)}R`.padStart(10) +
        `  ${((r.totalReturnPct >= 0 ? "+" : "") + fmt(r.totalReturnPct, 1) + "%").padStart(8)}` +
        `  ${fmt(r.maxDDPct, 1).padStart(5)}%`
      );
    }
  }
  console.log("─".repeat(74));
  console.log("\nesperanza = R promedio por operación. Positiva y estable = hay ventaja.");
} else {
  const r = runBacktest(c4h, baseOpts);
  console.log(`Operaciones:        ${r.trades}`);
  console.log(`Aciertos:           ${fmt(r.winRate, 1)}%`);
  console.log(`Factor de ganancia: ${fmt(r.profitFactor)}   (>1 gana, >1.5 decente)`);
  console.log(`Esperanza:          ${r.expectancyR >= 0 ? "+" : ""}${fmt(r.expectancyR)}R por operación`);
  console.log(`Retorno total:      ${r.totalReturnPct >= 0 ? "+" : ""}${fmt(r.totalReturnPct, 1)}%  (riesgo ${RISK_PCT}%/trade)`);
  console.log(`Retorno anualizado: ${r.totalReturnPct >= 0 ? "+" : ""}${fmt(r.totalReturnPct / (days / 365), 1)}%`);
  console.log(`Caída máxima:       −${fmt(r.maxDDPct, 1)}%`);
  console.log(`Capital final:      $${fmt(r.finalEquity, 0)} (desde $10.000)`);
  if (r.list.length) {
    console.log(`\nÚltimas 8 operaciones:`);
    for (const t of r.list.slice(-8)) {
      console.log(`  ${t.t}  ${t.dir === 1 ? "LONG " : "SHORT"}  ${t.why.padEnd(6)}  ${(t.r >= 0 ? "+" : "") + fmt(t.r)}R  ${(t.pnl >= 0 ? "+" : "") + fmt(t.pnl, 0)}$`);
    }
  }
}
console.log();
