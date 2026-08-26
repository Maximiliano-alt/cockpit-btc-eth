// Segunda familia de estrategia: seguimiento de tendencia por ASIGNACIÓN.
//
// El banco de pruebas anterior (research.mjs) descartó 15 variantes de
// "operaciones discretas con stop": todas se dejaban comer por el lateral y
// ninguna generalizaba a ETH. El problema no eran los parámetros sino el
// enfoque — entrar y salir con stops en 4H paga costes y ruido constantes.
//
// Aquí se prueba lo contrario, que es como opera de verdad la industria de
// managed futures: NO hay operaciones con stop, hay una posición que se
// mantiene mientras la tendencia siga viva y se pasa a efectivo cuando muere.
// Menos decisiones, menos costes, y captura los tramos largos que es donde
// el cripto genera su rentabilidad.
//
// Uso: node tools/trend.mjs [--years=6]

import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

const YEARS = parseFloat(args.years || 6);
const SYMBOLS = (args.symbols || "BTCUSDT,ETHUSDT").split(",");
const COST = 0.0006;          // coste por cambio de posición
const TRAIN_FRAC = 0.6;
const CACHE = path.join(process.cwd(), ".cache-research");
const HOST = "https://data-api.binance.vision";

async function daily(symbol, years) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${symbol}-1d-${years}y.json`);
  if (fs.existsSync(f)) {
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Date.now() - c.at < 12 * 3600e3) return c.rows;
  }
  const needed = Math.ceil(years * 365);
  const out = [];
  let end = Date.now();
  while (out.length < needed) {
    const res = await fetch(`${HOST}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&endTime=${end}`);
    const j = await res.json();
    if (!j.length) break;
    out.unshift(...j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
    end = j[0][0] - 1;
    if (j.length < 1000) break;
  }
  const seen = new Set();
  const rows = out.filter((c) => !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
  fs.writeFileSync(f, JSON.stringify({ at: Date.now(), rows }));
  return rows;
}

const sma = (v, i, n) => {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += v[k];
  return s / n;
};

/**
 * Simula una asignación: cada día la señal dice qué exposición tener
 * (1 = comprado, 0 = efectivo, -1 = corto). La entrada de cada día se
 * ejecuta a la APERTURA del día siguiente — la señal usa el cierre de hoy,
 * que ya ocurrió, así que no hay lookahead.
 */
function allocate(candles, signalFn, from, to, allowShort = false) {
  const closes = candles.map((c) => c.c);
  let equity = 1, pos = 0, peak = 1, maxDD = 0, switches = 0;
  const daysHeld = { long: 0, flat: 0, short: 0 };

  for (let i = from; i < to; i++) {
    // Rendimiento del día siguiente aplicado a la posición vigente.
    const ret = candles[i + 1].c / candles[i + 1].o - 1
      + (candles[i + 1].o / candles[i].c - 1);
    equity *= 1 + pos * ret;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    daysHeld[pos > 0 ? "long" : pos < 0 ? "short" : "flat"]++;

    let want = signalFn(closes, candles, i);
    if (!allowShort && want < 0) want = 0;
    if (want !== pos) {
      equity *= 1 - COST * Math.abs(want - pos);
      switches++;
      pos = want;
    }
  }
  const days = (candles[to].t - candles[from].t) / 864e5;
  const total = (equity - 1) * 100;
  return {
    total, annual: (Math.pow(equity, 365 / days) - 1) * 100,
    maxDD: maxDD * 100, switches,
    exposure: (daysHeld.long + daysHeld.short) / (days || 1) * 100,
  };
}

const buyHold = (c, from, to) => {
  const eq = c[to].c / c[from].c;
  const days = (c[to].t - c[from].t) / 864e5;
  let peak = 0, dd = 0;
  for (let i = from; i <= to; i++) { peak = Math.max(peak, c[i].c); dd = Math.max(dd, (peak - c[i].c) / peak); }
  return { total: (eq - 1) * 100, annual: (Math.pow(eq, 365 / days) - 1) * 100, maxDD: dd * 100, switches: 0, exposure: 100 };
};

// ── señales candidatas ──
const STRATS = [
  { name: "MA 200",           warm: 200, fn: (cl, _, i) => cl[i] > sma(cl, i, 200) ? 1 : 0 },
  { name: "MA 100",           warm: 100, fn: (cl, _, i) => cl[i] > sma(cl, i, 100) ? 1 : 0 },
  { name: "MA 50",            warm: 50,  fn: (cl, _, i) => cl[i] > sma(cl, i, 50) ? 1 : 0 },
  { name: "cruce 50/200",     warm: 200, fn: (cl, _, i) => sma(cl, i, 50) > sma(cl, i, 200) ? 1 : 0 },
  { name: "cruce 20/100",     warm: 100, fn: (cl, _, i) => sma(cl, i, 20) > sma(cl, i, 100) ? 1 : 0 },
  { name: "momento 90d",      warm: 90,  fn: (cl, _, i) => cl[i] > cl[i - 90] ? 1 : 0 },
  { name: "momento 180d",     warm: 180, fn: (cl, _, i) => cl[i] > cl[i - 180] ? 1 : 0 },
  { name: "MA200 + mom90",    warm: 200, fn: (cl, _, i) => (cl[i] > sma(cl, i, 200) && cl[i] > cl[i - 90]) ? 1 : 0 },
  { name: "MA100 + mom90",    warm: 100, fn: (cl, _, i) => (cl[i] > sma(cl, i, 100) && cl[i] > cl[i - 90]) ? 1 : 0 },
  { name: "MA200 largo/corto", warm: 200, fn: (cl, _, i) => cl[i] > sma(cl, i, 200) ? 1 : -1, short: true },
  { name: "cruce 50/200 L/C", warm: 200, fn: (cl, _, i) => sma(cl, i, 50) > sma(cl, i, 200) ? 1 : -1, short: true },
];

console.log(`\n${"═".repeat(92)}`);
console.log(`COMPUERTA 0 · SEGUIMIENTO DE TENDENCIA (asignación diaria) · ${YEARS} años · coste ${COST * 100}% por cambio`);
console.log(`${"═".repeat(92)}\n`);

const data = {};
for (const s of SYMBOLS) data[s] = await daily(s, YEARS);

for (const s of SYMBOLS) {
  const c = data[s];
  const split = Math.floor(c.length * TRAIN_FRAC);
  console.log(`${s}: ${c.length} días · ${new Date(c[0].t).toISOString().slice(0, 10)} → ${new Date(c[c.length - 1].t).toISOString().slice(0, 10)}`);
  console.log(`  comprar y mantener: entren. ${buyHold(c, 200, split).annual.toFixed(0)}%/a (caída ${buyHold(c, 200, split).maxDD.toFixed(0)}%) · verif. ${buyHold(c, split, c.length - 2).annual.toFixed(0)}%/a (caída ${buyHold(c, split, c.length - 2).maxDD.toFixed(0)}%)`);
}

console.log(`\n${"─".repeat(92)}`);
console.log("estrategia".padEnd(22) + "│ " + SYMBOLS.map((s) => `${s.replace("USDT", "")} entren.   ${s.replace("USDT", "")} verif.`).join("  "));
console.log("─".repeat(92));

const results = [];
for (const st of STRATS) {
  const cells = [], per = {};
  for (const s of SYMBOLS) {
    const c = data[s];
    const split = Math.floor(c.length * TRAIN_FRAC);
    const tr = allocate(c, st.fn, Math.max(st.warm, 200), split, st.short);
    const te = allocate(c, st.fn, split, c.length - 2, st.short);
    per[s] = { tr, te };
    const f = (r) => `${(r.annual >= 0 ? "+" : "") + r.annual.toFixed(0)}%/a dd${r.maxDD.toFixed(0)}`.padEnd(15);
    cells.push(f(tr) + f(te));
  }
  results.push({ st, per });
  console.log(st.name.padEnd(22) + "│ " + cells.join(" "));
}
console.log("─".repeat(92));

console.log("\nAPROBACIÓN (positivo en ambos activos y ambos periodos):\n");
let ok = 0;
for (const { st, per } of results) {
  const all = SYMBOLS.flatMap((s) => [per[s].tr, per[s].te]);
  if (all.every((r) => r.annual > 0)) {
    ok++;
    const worst = Math.min(...all.map((r) => r.annual));
    const dd = Math.max(...all.map((r) => r.maxDD));
    const exp = (all.reduce((s, r) => s + r.exposure, 0) / all.length).toFixed(0);
    console.log(`  ✅ ${st.name.padEnd(20)} peor tramo ${worst.toFixed(1)}%/a · caída máx ${dd.toFixed(0)}% · expuesto ${exp}% del tiempo`);
  }
}
if (!ok) console.log("  ❌ Ninguna pasa.");
console.log();
