import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Lock, AlertTriangle, CheckCircle2, XCircle,
  Calendar, ExternalLink, ShieldAlert, Target, Radio, RefreshCw,
  MessageSquare, Send, Stethoscope, Wifi, WifiOff
} from "lucide-react";

// ───────────────────────── CONFIG: zonas e indicadores ─────────────────────
// Zonas derivadas del análisis del 9 Jun 2026. Editables en un solo lugar.
const ASSETS = {
  BTCUSDT: {
    name: "BTC / USDT",
    tvSymbol: "BINANCE:BTCUSDT",
    zones: [
      { label: "Imán liquidez ↑", from: 80000, to: 85000, kind: "target" },
      { label: "POI acumulación (sell-side)", from: 58000, to: 60000, kind: "poi" },
    ],
    lines: [
      { label: "Invalidación HTF", price: 54500, kind: "stop" },
      { label: "Long 70k (error)", price: 70000, kind: "error" },
    ],
    poi: { lo: 58000, hi: 60000 },
    invalidation: 54500,
    target: 80000,
  },
  ETHUSDT: {
    name: "ETH / USDT",
    tvSymbol: "BINANCE:ETHUSDT",
    zones: [
      { label: "Imán liquidez ↑", from: 2400, to: 2500, kind: "target" },
      { label: "POI acumulación", from: 1500, to: 1550, kind: "poi" },
    ],
    lines: [{ label: "Invalidación HTF", price: 1400, kind: "stop" }],
    poi: { lo: 1500, hi: 1550 },
    invalidation: 1400,
    target: 2400,
  },
};

// Snapshot 9 Jun 2026 — NO es live (no hay API pública gratis para esto).
const SNAPSHOT = [
  { label: "Puell Multiple", value: "0.55", tag: "Infravalorado", tone: "good" },
  { label: "MVRV Z-Score", value: "0.32", tag: "Infravalorado", tone: "good" },
  { label: "Mayer Multiple", value: "0.81", tag: "< media 200D", tone: "good" },
  { label: "Cycle Top", value: "0/30", tag: "Hold", tone: "good" },
  { label: "RSI 22D", value: "31.9", tag: "Sobreventa", tone: "good" },
  { label: "Altcoin Season", value: "46", tag: "NO altseason", tone: "warn" },
];

const SOURCES = [
  { name: "CMC — Fear&Greed / Cycles / Dominance", url: "https://coinmarketcap.com/charts/fear-and-greed-index/" },
  { name: "Farside — BTC ETF Flow", url: "https://farside.co.uk/btc/" },
  { name: "Farside — ETH ETF Flow", url: "https://farside.co.uk/eth/" },
  { name: "Coinglass — BTC Liquidation Heatmap", url: "https://www.coinglass.com/pro/futures/LiquidationHeatMapModel3?coin=BTC&type=pair" },
  { name: "Coinglass — ETH Liquidation Heatmap", url: "https://www.coinglass.com/pro/futures/LiquidationHeatMapModel3?coin=ETH&type=pair" },
  { name: "Exness — Resumen de cuenta", url: "https://my.exness.market/pa/trading/orderSummary" },
  { name: "Exness — Web Trading", url: "https://my.exness.market/webtrading/" },
];

const INTERVALS = [
  { label: "1S", code: "1w" },
  { label: "1D", code: "1d" },
  { label: "4H", code: "4h" },
];
const toneClasses = {
  good: "text-emerald-400 border-emerald-500/30 bg-emerald-500/5",
  warn: "text-amber-400 border-amber-500/30 bg-amber-500/5",
  danger: "text-rose-400 border-rose-500/30 bg-rose-500/5",
};

// ───────────────────────── helpers de datos en vivo ────────────────────────
async function fetchJSON(url, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

function useLivePrices() {
  const [data, setData] = useState({ BTCUSDT: null, ETHUSDT: null, SOLUSDT: null });
  const [status, setStatus] = useState("loading"); // loading | live | offline
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const url = "https://api.binance.com/api/v3/ticker/24hr?symbols=" +
        encodeURIComponent('["BTCUSDT","ETHUSDT","SOLUSDT"]');
      const arr = await fetchJSON(url);
      const next = {};
      arr.forEach((t) => {
        next[t.symbol] = { price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent) };
      });
      setData(next);
      setStatus("live");
      setUpdated(new Date());
    } catch {
      try {
        const cg = await fetchJSON(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
        );
        setData({
          BTCUSDT: { price: cg.bitcoin.usd, change: cg.bitcoin.usd_24h_change },
          ETHUSDT: { price: cg.ethereum.usd, change: cg.ethereum.usd_24h_change },
          SOLUSDT: { price: cg.solana.usd, change: cg.solana.usd_24h_change },
        });
        setStatus("live");
        setUpdated(new Date());
      } catch {
        setStatus("offline");
      }
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  return { data, status, updated, reload: load };
}

// Fear&Greed + dominancia desde CoinMarketCap (vía function con cache).
// Fallback: alternative.me y CoinGecko si la function falla o no hay key.
function useMarketMeta() {
  const [fg, setFg] = useState(null);
  const [dom, setDom] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      let gotFg = false, gotDom = false;
      try {
        const j = await fetchJSON("/.netlify/functions/market", 12000);
        if (live && j?.fearGreed) { setFg(j.fearGreed); gotFg = true; }
        if (live && j?.dominance) { setDom(j.dominance); gotDom = true; }
      } catch { /* cae al fallback */ }
      if (!gotFg) {
        try {
          const j = await fetchJSON("https://api.alternative.me/fng/?limit=1");
          if (live && j?.data?.[0]) setFg({ value: +j.data[0].value, label: j.data[0].value_classification });
        } catch { /* mantiene snapshot */ }
      }
      if (!gotDom) {
        try {
          const j = await fetchJSON("https://api.coingecko.com/api/v3/global");
          const p = j?.data?.market_cap_percentage;
          if (live && p) setDom({ btc: p.btc, eth: p.eth });
        } catch { /* snapshot */ }
      }
    };
    load();
    const t = setInterval(load, 300000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return { fg, dom };
}

// Flujos diarios de ETF (Farside, scrapeado server-side). Refresco cada 30 min.
function useEtfFlows() {
  const [etf, setEtf] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await fetchJSON("/.netlify/functions/etf", 20000);
        if (live && (j?.btc || j?.eth)) setEtf(j);
      } catch { /* mantiene snapshot */ }
    };
    load();
    const t = setInterval(load, 1800000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return etf;
}

// Funding rate + open interest de Binance Futures (gratis, CORS abierto).
// Proxy de presión de liquidaciones ahora que Coinglass es de pago.
function useDerivs() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const syms = ["BTCUSDT", "ETHUSDT"];
        const next = {};
        await Promise.all(syms.map(async (s) => {
          const [pi, oi] = await Promise.all([
            fetchJSON("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + s),
            fetchJSON("https://fapi.binance.com/fapi/v1/openInterest?symbol=" + s),
          ]);
          next[s] = {
            funding: parseFloat(pi.lastFundingRate) * 100,
            oiUsd: parseFloat(oi.openInterest) * parseFloat(pi.markPrice),
          };
        }));
        if (live) setD(next);
      } catch { /* sin datos */ }
    };
    load();
    const t = setInterval(load, 120000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return d;
}

function useKlines(symbol, interval) {
  const [candles, setCandles] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setCandles(null); setErr(false);
    const load = async () => {
      try {
        const j = await fetchJSON(
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=150`
        );
        if (!live) return;
        setCandles(j.map((k) => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
      } catch {
        if (live) setErr(true);
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => { live = false; clearInterval(t); };
  }, [symbol, interval]);
  return { candles, err };
}

// ───────────────────────── gráfico con zonas (SVG) ─────────────────────────
function ZoneChart({ cfg, candles, err, live }) {
  const W = 720, H = 360, padTop = 10, padBot = 16, padRight = 64;
  const view = useMemo(() => {
    if (!candles || !candles.length) return null;
    const cs = candles.slice(-150);
    let lo = Infinity, hi = -Infinity;
    cs.forEach((c) => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    cfg.zones.forEach((z) => { lo = Math.min(lo, z.from); hi = Math.max(hi, z.to); });
    cfg.lines.forEach((l) => { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); });
    if (live) { lo = Math.min(lo, live); hi = Math.max(hi, live); }
    const span = hi - lo || 1;
    lo -= span * 0.03; hi += span * 0.03;
    const y = (p) => padTop + (1 - (p - lo) / (hi - lo)) * (H - padTop - padBot);
    const plotW = W - padRight;
    const step = plotW / cs.length;
    const bw = Math.max(1.2, step * 0.62);
    return { cs, lo, hi, y, step, bw, plotW };
  }, [candles, cfg, live]);

  if (err) return (
    <div className="grid place-items-center text-center text-xs text-rose-300 py-16 px-4">
      No se pudieron cargar velas en vivo (Binance bloqueado o sin red). Las zonas siguen abajo.
      <ZoneList cfg={cfg} />
    </div>
  );
  if (!view) return (
    <div className="grid place-items-center text-xs text-slate-500 py-16">Cargando velas en vivo…</div>
  );

  const { cs, lo, hi, y, step, bw, plotW } = view;
  const ticks = 5;
  const zoneColor = (k) =>
    k === "target" ? "rgba(52,211,153,0.13)" : k === "poi" ? "rgba(56,189,248,0.13)" : "rgba(251,113,133,0.13)";
  const lineColor = (k) => (k === "stop" ? "#fb7185" : k === "error" ? "#f43f5e" : "#94a3b8");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ display: "block" }}>
      {/* gridlines + price axis */}
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const p = lo + ((hi - lo) * i) / ticks;
        const yy = y(p);
        return (
          <g key={i}>
            <line x1={0} x2={plotW} y1={yy} y2={yy} stroke="#1e293b" strokeWidth="1" />
            <text x={plotW + 6} y={yy + 3} fill="#64748b" fontSize="10" fontFamily="monospace">
              {p >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(0)}
            </text>
          </g>
        );
      })}
      {/* zones */}
      {cfg.zones.map((z, i) => {
        const yt = y(z.to), yb = y(z.from);
        return (
          <g key={"z" + i}>
            <rect x={0} y={yt} width={plotW} height={Math.max(2, yb - yt)} fill={zoneColor(z.kind)} />
            <text x={6} y={yt + 12} fill={z.kind === "target" ? "#6ee7b7" : "#7dd3fc"} fontSize="10" fontFamily="monospace">
              {z.label}
            </text>
          </g>
        );
      })}
      {/* candles */}
      {cs.map((c, i) => {
        const x = i * step + step / 2;
        const up = c.c >= c.o;
        const col = up ? "#34d399" : "#f87171";
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
            <rect x={x - bw / 2} y={Math.min(yo, yc)} width={bw} height={Math.max(1, Math.abs(yc - yo))} fill={col} />
          </g>
        );
      })}
      {/* lines */}
      {cfg.lines.map((l, i) => (
        <g key={"l" + i}>
          <line x1={0} x2={plotW} y1={y(l.price)} y2={y(l.price)} stroke={lineColor(l.kind)} strokeWidth="1" strokeDasharray="5 4" />
          <text x={plotW - 4} y={y(l.price) - 3} textAnchor="end" fill={lineColor(l.kind)} fontSize="10" fontFamily="monospace">
            {l.label} {Math.round(l.price).toLocaleString()}
          </text>
        </g>
      ))}
      {/* live price */}
      {live && (
        <g>
          <line x1={0} x2={plotW} y1={y(live)} y2={y(live)} stroke="#e2e8f0" strokeWidth="1" />
          <rect x={plotW} y={y(live) - 8} width={padRight} height={16} fill="#e2e8f0" />
          <text x={plotW + 4} y={y(live) + 3} fill="#0f172a" fontSize="10" fontWeight="700" fontFamily="monospace">
            {Math.round(live).toLocaleString()}
          </text>
        </g>
      )}
    </svg>
  );
}

function ZoneList({ cfg }) {
  return (
    <div className="mt-3 space-y-1 text-left">
      {cfg.zones.map((z, i) => (
        <div key={i} className="font-mono text-[11px] text-slate-400">
          {z.label}: {z.from.toLocaleString()}–{z.to.toLocaleString()}
        </div>
      ))}
    </div>
  );
}

function ChartCard({ symbol, cfg, live }) {
  const [iv, setIv] = useState("1d");
  const { candles, err } = useKlines(symbol, iv);
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm tracking-wide text-slate-200">{cfg.name}</span>
          {live != null && (
            <span className="font-mono text-xs text-slate-400">
              ${live >= 1000 ? Math.round(live).toLocaleString() : live.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {INTERVALS.map((i) => (
            <button key={i.code} onClick={() => setIv(i.code)}
              className={`px-2 py-0.5 text-xs font-mono rounded transition ${
                iv === i.code ? "bg-slate-200 text-slate-900" : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
              }`}>{i.label}</button>
          ))}
          <a href={`https://www.tradingview.com/chart/?symbol=${cfg.tvSymbol}`} target="_blank" rel="noopener noreferrer"
            className="ml-1 text-slate-500 hover:text-slate-300" title="Abrir en TradingView">
            <ExternalLink size={13} />
          </a>
        </div>
      </div>
      <ZoneChart cfg={cfg} candles={candles} err={err} live={live} />
    </div>
  );
}

// ───────────────────────── calendario económico ────────────────────────────
// Exness bloquea el iframe (x-frame-options: SAMEORIGIN). TradingView ofrece
// el mismo calendario como widget embebible gratuito.
function EconomicCalendar() {
  const src =
    "https://s.tradingview.com/embed-widget/events/?locale=es#" +
    encodeURIComponent(JSON.stringify({
      colorTheme: "dark",
      isTransparent: true,
      width: "100%",
      height: 450,
      importanceFilter: "0,1",
    }));
  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Calendar size={16} className="text-slate-300" />
        <h2 className="text-sm font-mono tracking-wide text-slate-300">Calendario económico (TradingView)</h2>
      </div>
      <iframe
        src={src}
        title="Calendario económico"
        className="w-full rounded-md border border-slate-700"
        style={{ height: 450, border: 0 }}
      />
      <p className="mt-2 text-[11px] text-slate-500">Eventos de impacto medio y alto. Antes de CPI/FOMC: manos quietas.</p>
    </section>
  );
}

// ───────────────────────── diagnóstico dinámico ────────────────────────────
function Diagnosis({ btc, fg, etf }) {
  const cfg = ASSETS.BTCUSDT;
  const bullets = [];
  let verdict, vtone;

  if (btc == null) {
    verdict = "Sin precio en vivo — diagnóstico en pausa.";
    vtone = "warn";
  } else if (btc < cfg.invalidation) {
    verdict = "INVALIDACIÓN: tesis de acumulación rota. Sin long.";
    vtone = "danger";
    bullets.push(`BTC ${Math.round(btc).toLocaleString()} bajo invalidación (${cfg.invalidation.toLocaleString()}).`);
  } else if (btc >= cfg.poi.lo && btc <= cfg.poi.hi) {
    verdict = "Precio EN el POI. Si hay CHoCH en LTF, considerar entrada (pásala por el filtro).";
    vtone = "good";
    bullets.push(`BTC dentro del POI ${cfg.poi.lo.toLocaleString()}–${cfg.poi.hi.toLocaleString()}.`);
  } else if (btc < cfg.poi.lo) {
    verdict = "Bajo el POI pero sobre invalidación — barrido de liquidez. Vigilar reacción.";
    vtone = "warn";
    bullets.push(`BTC bajo el POI; ${cfg.invalidation.toLocaleString()} es la línea que no se cruza.`);
  } else {
    verdict = "Precio POR ENCIMA del POI. No perseguir. Esperar retroceso al POI o CHoCH confirmado.";
    vtone = "warn";
    bullets.push(`BTC ${Math.round(btc).toLocaleString()} vs POI ${cfg.poi.lo.toLocaleString()}–${cfg.poi.hi.toLocaleString()}: comprar acá es perseguir.`);
  }

  const fgv = fg?.value;
  if (fgv != null) {
    bullets.push(fgv <= 25
      ? `Fear&Greed ${fgv} (${fg.label}): zona contrarian, favorece acumulación paciente — no euforia.`
      : `Fear&Greed ${fgv} (${fg.label}): contexto de sentimiento, sin señal de extremo.`);
  }
  bullets.push("Cycle Top 0/30: riesgo de comprar un techo = bajo. El riesgo real es timing/estructura.");
  if (etf?.btc) {
    const f = etf.btc;
    bullets.push(`Flujos ETF BTC ${f.total >= 0 ? "+" : "−"}${Math.abs(f.total).toFixed(1)}M (${f.date}): ${
      f.total >= 0 ? "entrada — un día no confirma reversión." : "salida — sin reversión confirmada, no anticipar."}`);
  } else {
    bullets.push("Flujos ETF aún en salida (BTC −91M el 8 Jun): sin reversión confirmada, no anticipar.");
  }
  bullets.push("Altseason 46 = NO altseason. Alts fuera (y bloqueadas por mandato).");

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Stethoscope size={16} className="text-slate-300" />
        <h2 className="text-sm font-mono tracking-wide text-slate-300">Diagnóstico (dinámico)</h2>
      </div>
      <div className={`rounded-md px-3 py-2.5 text-sm font-semibold border ${
        vtone === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
        : vtone === "danger" ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
        : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
        {verdict}
      </div>
      <ul className="mt-3 space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-xs text-slate-400">
            <span className="text-slate-600 mt-0.5">›</span>{b}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-slate-500">
        Acción hoy: gestionar (cerrar el long 70k incoherente) + limits en POI. No market entry.
      </p>
    </div>
  );
}

// ───────────────────────── filtro R:R + checklist (igual) ──────────────────
function RiskGate() {
  const [entry, setEntry] = useState(""), [stop, setStop] = useState(""), [target, setTarget] = useState("");
  const [risk, setRisk] = useState("100"), [ppl, setPpl] = useState("1");
  const r = useMemo(() => {
    const e = +entry, s = +stop, t = +target, rk = +risk, p = +ppl;
    if ([e, s, t].some((x) => !isFinite(x) || x === 0) && (entry === "" || stop === "" || target === "")) return null;
    if (![e, s, t].every(isFinite)) return null;
    const sd = Math.abs(e - s), rw = Math.abs(t - e);
    const rr = sd === 0 ? 0 : rw / sd;
    const lots = sd && p ? rk / (sd * p) : 0;
    const round = e % 1000 === 0 || e % 500 === 0;
    return { sd, rr, lots, round, pass: rr >= 1.5 && !round };
  }, [entry, stop, target, risk, ppl]);
  const F = ({ label, val, set, hint }) => (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-slate-400">{label}</span>
      <input value={val} onChange={(e) => set(e.target.value)} inputMode="decimal" placeholder={hint}
        className="mt-1 w-full rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5 font-mono text-sm text-slate-100 focus:border-slate-400 focus:outline-none" />
    </label>
  );
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Target size={16} className="text-slate-300" />
        <h3 className="font-mono text-sm tracking-wide text-slate-200">Filtro R:R + Lotaje</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <F label="Entrada" val={entry} set={setEntry} hint="58500" />
        <F label="Stop" val={stop} set={setStop} hint="54800" />
        <F label="Target" val={target} set={setTarget} hint="80000" />
        <F label="Riesgo $" val={risk} set={setRisk} hint="100" />
        <F label="$/punto/lote" val={ppl} set={setPpl} hint="BTC≈1 · ETH verificar" />
      </div>
      {r && (
        <div className="mt-4 space-y-2">
          {r.round && (
            <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2">
              <AlertTriangle size={15} className="text-rose-400 mt-0.5 shrink-0" />
              <span className="text-xs text-rose-200">Número redondo = trampa de liquidez. Mueve el POI cerca de la invalidación.</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 font-mono text-sm">
            <div className="rounded-md bg-slate-950 border border-slate-700 px-2 py-2"><div className="text-[10px] uppercase text-slate-500">Stop pts</div><div className="text-slate-100">{r.sd.toLocaleString()}</div></div>
            <div className="rounded-md bg-slate-950 border border-slate-700 px-2 py-2"><div className="text-[10px] uppercase text-slate-500">R:R</div><div className={r.rr >= 1.5 ? "text-emerald-400" : "text-rose-400"}>1:{r.rr.toFixed(2)}</div></div>
            <div className="rounded-md bg-slate-950 border border-slate-700 px-2 py-2"><div className="text-[10px] uppercase text-slate-500">Lotaje</div><div className="text-slate-100">{r.lots.toFixed(3)}</div></div>
          </div>
          <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${r.pass ? "bg-emerald-500/10 border border-emerald-500/40 text-emerald-300" : "bg-rose-500/10 border border-rose-500/40 text-rose-300"}`}>
            {r.pass ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            {r.pass ? "Cumple R:R ≥ 1.5 y no es número redondo." : "RECHAZADO. R:R < 1.5 o número redondo."}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px] text-slate-500">KPI objetivo: payoff ≥ 1.5. Tu real histórico: 0.41.</p>
    </div>
  );
}

const CHECKS = [
  "Registrado en la Bitácora ANTES de ejecutar",
  "El activo es BTC o ETH (nada más)",
  "R:R ≥ 1.5 confirmado",
  "Entrada en POI estructural, NO en número redondo",
  "Stop por DEBAJO del cluster retail obvio",
  "Sin evento macro de alto impacto pendiente (CPI/FOMC)",
];
function Checklist() {
  const [s, setS] = useState(CHECKS.map(() => false));
  const all = s.every(Boolean);
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 mb-3"><ShieldAlert size={16} className="text-slate-300" /><h3 className="font-mono text-sm tracking-wide text-slate-200">Compuerta pre-trade</h3></div>
      <ul className="space-y-1.5">
        {CHECKS.map((c, i) => (
          <li key={i}>
            <button onClick={() => setS((x) => x.map((v, j) => (j === i ? !v : v)))} className="flex w-full items-center gap-2.5 text-left group">
              <span className={`grid place-items-center h-4 w-4 rounded border shrink-0 ${s[i] ? "bg-emerald-500 border-emerald-500" : "border-slate-600 group-hover:border-slate-400"}`}>
                {s[i] && <CheckCircle2 size={12} className="text-slate-950" />}
              </span>
              <span className={`text-xs ${s[i] ? "text-slate-300" : "text-slate-400"}`}>{c}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className={`mt-3 rounded-md px-3 py-2 text-xs font-semibold ${all ? "bg-emerald-500/10 border border-emerald-500/40 text-emerald-300" : "bg-slate-800/60 border border-slate-700 text-slate-400"}`}>
        {all ? "Compuerta abierta — recién ahora se considera el trade." : "Compuerta cerrada. Faltan condiciones."}
      </div>
    </div>
  );
}

// ───────────────────────── chat con Claude Sonnet ──────────────────────────
function CoachChat({ btc, eth, fg }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, loading]);

  const system = () =>
    `Eres el coach institucional de trading de Maximiliano (Max). Estilo: directo, sin azúcar, brutalmente honesto, en español. ` +
    `REGLAS NO NEGOCIABLES que debes hacer cumplir: (1) Universo SOLO BTC y ETH hasta lograr 3 meses consecutivos rentables en demo. ` +
    `Rechaza SOL, altcoins, TSLA, NVDA, US500 y cualquier expansión de scope. (2) Nunca animes a resetear la cuenta demo — destruye el track record. ` +
    `(3) El problema central de Max es el R:R / payoff ratio (real histórico 0.41 vs objetivo 1.5), no la dirección: gana 62% pero pierde plata porque las pérdidas (~$11.59) superan a las ganancias (~$4.79). Esperanza negativa. ` +
    `(4) Entrar en números redondos (70000, 2000) es un defecto: trampa de liquidez, stops inflados. Entradas en POI cerca de la invalidación. ` +
    `(5) No ejecutas trades; la Bitácora pre-log es la compuerta. ` +
    `Contexto actual: BTC ${btc ? "$" + Math.round(btc).toLocaleString() : "?"}, ETH ${eth ? "$" + Math.round(eth).toLocaleString() : "?"}, Fear&Greed ${fg?.value ?? "?"}. ` +
    `Estructura semanal bajista, on-chain en zona de valor (MVRV-Z 0.32, Puell 0.55, Mayer 0.81, Cycle 0/30), flujos ETF aún en salida. ` +
    `BTC POI acumulación 58k-60k, invalidación 54.5k, imán 80k-85k. Sé conciso (máx ~150 palabras). Si Max intenta romper una regla, dícelo sin suavizar.`;

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const history = [...msgs, { role: "user", content: text }];
    setMsgs(history);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/.netlify/functions/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: system(),
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const reply = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      setMsgs((m) => [...m, { role: "assistant", content: reply || "Sin respuesta. Reintenta." }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "No se pudo conectar con Claude. Revisa la conexión y reintenta." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 flex flex-col" style={{ minHeight: 380 }}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700/60">
        <MessageSquare size={16} className="text-slate-300" />
        <h2 className="text-sm font-mono tracking-wide text-slate-300">Pregunta al coach (Claude Sonnet)</h2>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ maxHeight: 360 }}>
        {msgs.length === 0 && (
          <p className="text-xs text-slate-500">
            Conoce tu contexto (BTC/ETH-only, payoff 0.41, zonas de hoy). Pregunta cosas como “¿la posición de 70k la cierro o la mantengo?” o “¿dónde pongo el stop si entro en el POI?”. No espera que le des la razón.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === "user" ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-200 border border-slate-700"}`}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div className="text-xs text-slate-500 font-mono">pensando…</div>}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 p-3 border-t border-slate-700/60">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="Escribe tu pregunta…"
          className="flex-1 rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:border-slate-400 focus:outline-none"
        />
        <button onClick={send} disabled={loading}
          className="grid place-items-center h-9 w-9 rounded-md bg-slate-200 text-slate-900 disabled:opacity-40 hover:bg-white transition">
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── app ─────────────────────────────────────────────
export default function Cockpit() {
  const { data: prices, status, updated, reload } = useLivePrices();
  const { fg, dom } = useMarketMeta();
  const etf = useEtfFlows();
  const derivs = useDerivs();
  const btc = prices.BTCUSDT?.price ?? null;
  const eth = prices.ETHUSDT?.price ?? null;
  const sol = prices.SOLUSDT?.price ?? null;

  const Live = ({ label, value, sub, tone }) => (
    <div className={`rounded-md border px-2.5 py-2 ${tone || "border-slate-700 bg-slate-800/40 text-slate-200"}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="font-mono text-base font-bold">{value}</div>
      {sub && <div className="text-[10px] opacity-80">{sub}</div>}
    </div>
  );
  const chg = (s) => prices[s] ? `${prices[s].change >= 0 ? "+" : ""}${prices[s].change.toFixed(2)}% 24h` : "";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">

        <header className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-slate-50">Cockpit BTC / ETH</h1>
              <p className="text-xs text-slate-400 font-mono">Monitoreo + disciplina · solo BTC/ETH</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-mono ${
                status === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : status === "offline" ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-slate-600 text-slate-400"}`}>
                {status === "offline" ? <WifiOff size={12} /> : <Wifi size={12} />}
                {status === "live" ? `LIVE · ${updated?.toLocaleTimeString()}` : status === "offline" ? "Sin red" : "Conectando…"}
                {status !== "loading" && <button onClick={reload} className="ml-1 hover:text-white"><RefreshCw size={11} /></button>}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">
                <Lock size={13} /> BTC · ETH
              </span>
            </div>
          </div>

          {/* live ticker */}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Live label="BTC/USDT" value={btc ? "$" + Math.round(btc).toLocaleString() : "—"} sub={chg("BTCUSDT")}
              tone={prices.BTCUSDT && prices.BTCUSDT.change < 0 ? toneClasses.danger : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"} />
            <Live label="ETH/USDT" value={eth ? "$" + Math.round(eth).toLocaleString() : "—"} sub={chg("ETHUSDT")}
              tone={prices.ETHUSDT && prices.ETHUSDT.change < 0 ? toneClasses.danger : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"} />
            <Live label="SOL/USDT (solo monitoreo)" value={sol ? "$" + sol.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} sub={chg("SOLUSDT")}
              tone={prices.SOLUSDT && prices.SOLUSDT.change < 0 ? toneClasses.danger : "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"} />
          </div>
        </header>

        <EconomicCalendar />

        <Diagnosis btc={btc} fg={fg} etf={etf} />

        {/* charts con zonas */}
        <section className="grid gap-4 lg:grid-cols-3">
          <ChartCard symbol="BTCUSDT" cfg={ASSETS.BTCUSDT} live={btc} />
          <ChartCard symbol="ETHUSDT" cfg={ASSETS.ETHUSDT} live={eth} />
          <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 grid place-items-center p-6 text-center">
            <Lock size={22} className="text-amber-400 mb-2" />
            <div className="font-mono text-sm text-amber-300">SOL / USDT — BLOQUEADO</div>
            <p className="mt-1 text-[11px] text-amber-200/70 max-w-[220px]">Se desbloquea tras 3 meses consecutivos rentables en demo.</p>
          </div>
        </section>

        {/* indicadores: live vs snapshot, separados y honestos */}
        <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 mb-2"><Radio size={15} className="text-emerald-400" /><h2 className="text-sm font-mono tracking-wide text-slate-300">En vivo</h2></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
            <Live label="Fear & Greed" value={fg ? String(fg.value) : "16"} sub={fg ? fg.label : "snapshot"} tone={(fg?.value ?? 16) <= 25 ? toneClasses.danger : toneClasses.warn} />
            <Live label="BTC Dominance" value={dom ? dom.btc.toFixed(1) + "%" : "58.2%"} sub={dom ? "live" : "snapshot"} tone={toneClasses.warn} />
            <Live label="ETH Dominance" value={dom ? dom.eth.toFixed(1) + "%" : "9.3%"} sub={dom ? "live" : "snapshot"} tone={toneClasses.warn} />
            <Live label={`ETF BTC${etf?.btc ? " (" + etf.btc.date.slice(0, 6) + ")" : ""}`}
              value={etf?.btc ? `${etf.btc.total >= 0 ? "+" : "−"}${Math.abs(etf.btc.total).toFixed(1)}M` : "−91.4M"}
              sub={etf?.btc ? (etf.btc.total >= 0 ? "Entrada" : "Salida") : "snapshot"}
              tone={(etf?.btc ? etf.btc.total : -91.4) >= 0 ? toneClasses.good : toneClasses.danger} />
            <Live label={`ETF ETH${etf?.eth ? " (" + etf.eth.date.slice(0, 6) + ")" : ""}`}
              value={etf?.eth ? `${etf.eth.total >= 0 ? "+" : "−"}${Math.abs(etf.eth.total).toFixed(1)}M` : "+82.4M"}
              sub={etf?.eth ? (etf.eth.total >= 0 ? "Entrada" : "Salida") : "snapshot"}
              tone={(etf?.eth ? etf.eth.total : 82.4) >= 0 ? toneClasses.good : toneClasses.danger} />
            <Live label="Funding BTC" value={derivs?.BTCUSDT ? derivs.BTCUSDT.funding.toFixed(4) + "%" : "—"}
              sub={derivs?.BTCUSDT ? (derivs.BTCUSDT.funding < 0 ? "Shorts pagan" : "Longs pagan") : "Binance Futures"}
              tone={derivs?.BTCUSDT && derivs.BTCUSDT.funding < 0 ? toneClasses.good : toneClasses.warn} />
            <Live label="Funding ETH" value={derivs?.ETHUSDT ? derivs.ETHUSDT.funding.toFixed(4) + "%" : "—"}
              sub={derivs?.ETHUSDT ? (derivs.ETHUSDT.funding < 0 ? "Shorts pagan" : "Longs pagan") : "Binance Futures"}
              tone={derivs?.ETHUSDT && derivs.ETHUSDT.funding < 0 ? toneClasses.good : toneClasses.warn} />
            <Live label="Open Interest BTC+ETH"
              value={derivs ? "$" + ((derivs.BTCUSDT?.oiUsd ?? 0) + (derivs.ETHUSDT?.oiUsd ?? 0) > 1e9
                ? (((derivs.BTCUSDT?.oiUsd ?? 0) + (derivs.ETHUSDT?.oiUsd ?? 0)) / 1e9).toFixed(1) + "B"
                : (((derivs.BTCUSDT?.oiUsd ?? 0) + (derivs.ETHUSDT?.oiUsd ?? 0)) / 1e6).toFixed(0) + "M") : "—"}
              sub="Proxy de presión de liquidación" tone={toneClasses.warn} />
          </div>
          <div className="flex items-center gap-2 mb-2"><AlertTriangle size={15} className="text-amber-400" /><h2 className="text-sm font-mono tracking-wide text-slate-300">Snapshot 9 Jun — refrescar manual (no hay API gratis)</h2></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {SNAPSHOT.map((s) => (
              <div key={s.label} className={`rounded-md border px-2.5 py-2 ${toneClasses[s.tone]}`}>
                <div className="text-[10px] uppercase tracking-wider opacity-70">{s.label}</div>
                <div className="font-mono text-base font-bold">{s.value}</div>
                <div className="text-[10px] opacity-80">{s.tag}</div>
              </div>
            ))}
          </div>
        </section>

        {/* disciplina + chat */}
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4"><RiskGate /><Checklist /></div>
          <CoachChat btc={btc} eth={eth} fg={fg} />
        </section>

        {/* fuentes */}
        <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
          <h2 className="text-sm font-mono tracking-wide text-slate-300 mb-1">Fuentes externas</h2>
          <p className="text-[11px] text-slate-500 mb-3">CMC, Coinglass, Farside y Exness bloquean el embebido. Se abren en pestaña aparte.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SOURCES.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100 transition">
                <span>{s.name}</span><ExternalLink size={13} className="shrink-0 opacity-60" />
              </a>
            ))}
          </div>
        </section>

        <footer className="text-center text-[11px] text-slate-600 pb-2">
          Live: precios (Binance), Fear&Greed y dominancia (CoinMarketCap), flujos ETF (Farside), funding/OI (Binance Futures), calendario (TradingView). Lo demás es snapshot etiquetado. No ejecuta trades.
        </footer>
      </div>
    </div>
  );
}
