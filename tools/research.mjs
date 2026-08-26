// Banco de pruebas de estrategias — la Compuerta 0.
//
// Objetivo: encontrar una variante con ventaja REAL, no una que se vea bien
// por casualidad. Por eso el criterio de aprobación es deliberadamente duro:
// la MISMA configuración debe ganar en BTC y en ETH, y además en un periodo
// que no se usó para elegirla (fuera de muestra). Una ventaja auténtica
// generaliza; un ajuste a la curva no.
//
// Para poder comparar decenas de variantes, las señales (sesgo por
// temporalidad, gatillos, ATR) se precalculan UNA vez por activo y se cachean
// en disco. Cambiar filtros o salidas ya no recalcula nada pesado.
//
// Uso:
//   node tools/research.mjs               → compara todas las variantes
//   node tools/research.mjs --years=4
//   node tools/research.mjs --only=trend-trail --verbose

import fs from "node:fs";
import path from "node:path";
import { timeframeBias, detectStructure } from "../src/ros/structure.js";
import { compositeBias } from "../src/ros/decisionEngine.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

const YEARS = parseFloat(args.years || 4);
const SYMBOLS = (args.symbols || "BTCUSDT,ETHUSDT").split(",");
const RISK_PCT = parseFloat(args.risk || 1);
const COST_PER_SIDE = 0.0006;      // taker 0.05% + deslizamiento
const TRAIN_FRAC = 0.6;            // 60% para elegir, 40% para verificar
const CACHE_DIR = path.join(process.cwd(), ".cache-research");

const HOST = "https://data-api.binance.vision";

// ─────────────────────────── datos ───────────────────────────
async function fetch4h(symbol, years) {
  const needed = Math.ceil((years * 365 * 24) / 4);
  const out = [];
  let end = Date.now();
  while (out.length < needed) {
    const res = await fetch(`${HOST}/api/v3/klines?symbol=${symbol}&interval=4h&limit=1000&endTime=${end}`);
    if (!res.ok) throw new Error("klines HTTP " + res.status);
    const j = await res.json();
    if (!j.length) break;
    out.unshift(...j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
    end = j[0][0] - 1;
    if (j.length < 1000) break;
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

function aggregate(c, n) {
  const out = [];
  for (let i = 0; i < c.length; i += n) {
    const g = c.slice(i, i + n);
    if (!g.length) continue;
    out.push({ t: g[0].t, o: g[0].o, c: g[g.length - 1].c,
      h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)) });
  }
  return out;
}

function atrSeries(c, period = 14) {
  const out = new Array(c.length).fill(null);
  let sum = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    sum += tr;
    if (i > period) {
      const p = c[i - period];
      const pp = c[i - period - 1];
      sum -= Math.max(p.h - p.l, Math.abs(p.h - pp.c), Math.abs(p.l - pp.c));
    }
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

const START = 1200; // historia mínima para que el mensual tenga sentido

/** Precalcula señal por barra. Sin lookahead: barra i usa datos hasta i. */
async function features(symbol) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${symbol}-${YEARS}y.json`);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - cached.at < 12 * 3600e3) return cached;
  }
  process.stdout.write(`  precalculando ${symbol}… `);
  const c4h = await fetch4h(symbol, YEARS);
  const atr = atrSeries(c4h);
  const rows = [];
  for (let i = START; i < c4h.length - 1; i++) {
    const hist = c4h.slice(Math.max(0, i - 199), i + 1);
    const upTo = c4h.slice(0, i + 1);
    const tf = {
      h4: timeframeBias(hist),
      d1: timeframeBias(aggregate(upTo, 6).slice(-200)),
      w1: timeframeBias(aggregate(upTo, 42).slice(-120)),
      mn: timeframeBias(aggregate(upTo, 180).slice(-60)),
    };
    const bias = compositeBias(tf);
    const trg = detectStructure(hist);
    rows.push({
      i, score: bias.score, align: bias.alignment,
      w1: tf.w1.score, d1: tf.d1.score, mn: tf.mn.score,
      trigger: !!(trg.choch || trg.bos || trg.liquiditySweep),
      atr: atr[i],
    });
  }
  const data = { at: Date.now(), symbol, candles: c4h, rows };
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${rows.length} barras`);
  return data;
}

// ─────────────────────────── simulación ───────────────────────────
/**
 * @param {object} v variante de estrategia
 * exit: "fixed"  → stop y objetivo fijos en múltiplos de ATR
 *       "trail"  → stop que persigue al precio (deja correr al ganador)
 *       "hybrid" → asegura 1R y luego persigue
 */
function simulate(data, v, from, to) {
  const { candles: c, rows } = data;
  let equity = 10000;
  const start = equity;
  let peak = equity, maxDD = 0;
  let open = null, lastExit = -Infinity;
  const trades = [];

  for (const r of rows) {
    const i = r.i;
    if (i < from || i > to) continue;
    const bar = c[i];

    if (open) {
      // El trailing se actualiza con la barra YA cerrada, nunca con la actual.
      let exit = null;
      const hitStop = open.dir === 1 ? bar.l <= open.stop : bar.h >= open.stop;
      const hitTgt = open.target != null && (open.dir === 1 ? bar.h >= open.target : bar.l <= open.target);
      if (hitStop) exit = open.stop;              // pesimista si ambos caben
      else if (hitTgt) exit = open.target;

      if (exit != null) {
        const gross = (exit - open.entry) * open.dir;
        const pnlPerUnit = gross - (open.entry + exit) * COST_PER_SIDE;
        equity += pnlPerUnit * open.qty;
        trades.push({ r: pnlPerUnit / open.riskPerUnit, bars: i - open.bar });
        open = null; lastExit = i;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
      } else if (v.exit !== "fixed" && r.atr) {
        const move = (bar.c - open.entry) * open.dir;
        const armed = v.exit === "trail" || move >= open.riskPerUnit;
        if (armed) {
          const cand = open.dir === 1
            ? bar.h - r.atr * v.trailMult
            : bar.l + r.atr * v.trailMult;
          open.stop = open.dir === 1 ? Math.max(open.stop, cand) : Math.min(open.stop, cand);
        }
      }
    }
    if (open || i - lastExit < v.cooldownBars) continue;

    // ── filtros de entrada
    if (Math.abs(r.score) < v.minScore) continue;
    if (r.align < v.minAlign) continue;
    const dir = r.score > 0 ? 1 : -1;
    if (dir === -1 && !v.allowShorts) continue;
    if (v.requireTrigger && !r.trigger) continue;
    // Filtro de régimen: no operar contra la tendencia semanal.
    if (v.regime && Math.sign(r.w1) !== dir) continue;
    if (!r.atr) continue;

    const entry = c[i + 1].o;
    const riskPerUnit = r.atr * v.atrMult;
    if (!riskPerUnit) continue;
    open = {
      dir, entry, riskPerUnit, bar: i + 1,
      stop: entry - dir * riskPerUnit,
      target: v.exit === "fixed" ? entry + dir * riskPerUnit * v.rr : null,
      qty: (equity * (RISK_PCT / 100)) / riskPerUnit,
    };
  }

  const wins = trades.filter((t) => t.r > 0);
  const gw = wins.reduce((s, t) => s + t.r, 0);
  const gl = Math.abs(trades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0));
  const days = (c[Math.min(to, c.length - 1)].t - c[from].t) / 864e5;
  const ret = ((equity - start) / start) * 100;
  return {
    trades: trades.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    pf: gl ? gw / gl : (gw ? Infinity : 0),
    expR: trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0,
    ret, annual: days > 0 ? ret / (days / 365) : 0,
    maxDD: maxDD * 100,
  };
}

// ─────────────────────────── variantes a probar ───────────────────────────
const BASE = {
  minScore: 25, minAlign: 50, atrMult: 1.5, rr: 1.5, trailMult: 2.5,
  cooldownBars: 6, allowShorts: true, requireTrigger: true, regime: false,
};
const VARIANTS = [
  { name: "actual (bot hoy)", exit: "fixed" },
  { name: "solo largos", exit: "fixed", allowShorts: false },
  { name: "sin gatillo", exit: "fixed", requireTrigger: false },
  { name: "filtro régimen", exit: "fixed", regime: true },
  { name: "trailing", exit: "trail" },
  { name: "trailing + largos", exit: "trail", allowShorts: false },
  { name: "trailing + régimen", exit: "trail", regime: true },
  { name: "híbrido 1R+trail", exit: "hybrid" },
  { name: "híbrido + régimen", exit: "hybrid", regime: true },
  { name: "trail sin gatillo", exit: "trail", requireTrigger: false },
  { name: "trail régimen s/gatillo", exit: "trail", regime: true, requireTrigger: false },
  { name: "trail fuerte (score 40)", exit: "trail", minScore: 40 },
  { name: "trail rég. score40", exit: "trail", regime: true, minScore: 40 },
  { name: "trail rég. trail1.5", exit: "trail", regime: true, trailMult: 1.5 },
  { name: "trail rég. trail4", exit: "trail", regime: true, trailMult: 4 },
];

console.log(`\n${"═".repeat(96)}`);
console.log(`COMPUERTA 0 · ${YEARS} años · ${SYMBOLS.join(" + ")} · riesgo ${RISK_PCT}%/op · costes ${COST_PER_SIDE * 200}% ida y vuelta`);
console.log(`${"═".repeat(96)}\n`);

const feats = {};
for (const s of SYMBOLS) feats[s] = await features(s);

for (const s of SYMBOLS) {
  const c = feats[s].candles;
  const split = Math.floor(c.length * TRAIN_FRAC);
  const bhTrain = ((c[split].c - c[START].c) / c[START].c) * 100;
  const bhTest = ((c[c.length - 1].c - c[split].c) / c[split].c) * 100;
  console.log(`${s}: comprar y mantener → entrenamiento ${bhTrain >= 0 ? "+" : ""}${bhTrain.toFixed(0)}% · verificación ${bhTest >= 0 ? "+" : ""}${bhTest.toFixed(0)}%`);
}

const list = args.only ? VARIANTS.filter((v) => v.name.includes(args.only)) : VARIANTS;
const results = [];

console.log(`\n${"─".repeat(96)}`);
console.log("variante".padEnd(24) + "│ " + SYMBOLS.map((s) => `${s.replace("USDT", "")} entren.    ${s.replace("USDT", "")} verif.`).join("   "));
console.log("─".repeat(96));

for (const raw of list) {
  const v = { ...BASE, ...raw };
  const cells = [];
  const per = {};
  for (const s of SYMBOLS) {
    const c = feats[s].candles;
    const split = Math.floor(c.length * TRAIN_FRAC);
    const tr = simulate(feats[s], v, START, split);
    const te = simulate(feats[s], v, split + 1, c.length - 2);
    per[s] = { tr, te };
    const f = (r) => `${(r.annual >= 0 ? "+" : "") + r.annual.toFixed(0)}%/a ${r.trades}op`.padEnd(13);
    cells.push(f(tr) + f(te));
  }
  results.push({ v, per });
  console.log(v.name.padEnd(24) + "│ " + cells.join("  "));
}
console.log("─".repeat(96));

// Criterio de aprobación: rentable en TODOS los activos y en AMBOS periodos,
// con muestra suficiente para no ser casualidad.
console.log("\nAPROBACIÓN (positivo en ambos activos Y ambos periodos, ≥25 ops por tramo):\n");
let passed = 0;
for (const { v, per } of results) {
  const all = SYMBOLS.flatMap((s) => [per[s].tr, per[s].te]);
  const ok = all.every((r) => r.annual > 0 && r.trades >= 25);
  if (ok) {
    passed++;
    const worst = Math.min(...all.map((r) => r.annual));
    const dd = Math.max(...all.map((r) => r.maxDD));
    console.log(`  ✅ ${v.name} — peor tramo ${worst.toFixed(1)}%/año, caída máx ${dd.toFixed(1)}%`);
  }
}
if (!passed) {
  console.log("  ❌ Ninguna variante pasa. No hay ventaja demostrable todavía.");
  const best = results
    .map(({ v, per }) => {
      const all = SYMBOLS.flatMap((s) => [per[s].tr, per[s].te]);
      return { name: v.name, worst: Math.min(...all.map((r) => r.annual)) };
    })
    .sort((a, b) => b.worst - a.worst)[0];
  console.log(`     La menos mala: "${best.name}" con ${best.worst.toFixed(1)}%/año en su peor tramo.`);
}
console.log();
