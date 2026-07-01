import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Lock, CheckCircle2,
  Calendar, ExternalLink, ShieldAlert, Target, Radio, RefreshCw,
  Stethoscope, Wifi, WifiOff
} from "lucide-react";
import RiskPortfolioManager from "./ros/RiskPortfolioManager.jsx";
import { detectStructure, timeframeBias } from "./ros/structure.js";

// ───────────────────────── CONFIG: activos (zonas vienen de IA) ────────────
const ASSETS = {
  BTCUSDT: {
    name: "BTC / USDT",
    tvSymbol: "BINANCE:BTCUSDT",
    zones: [],
    lines: [],
    poi: null,
    invalidation: null,
    target: null,
  },
  ETHUSDT: {
    name: "ETH / USDT",
    tvSymbol: "BINANCE:ETHUSDT",
    zones: [],
    lines: [],
    poi: null,
    invalidation: null,
    target: null,
  },
  SOLUSDT: {
    name: "SOL / USDT",
    tvSymbol: "BINANCE:SOLUSDT",
    zones: [],
    lines: [],
    poi: null,
    invalidation: null,
    target: null,
  },
};

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
  { label: "4H", code: "4h" },
  { label: "1D", code: "1d" },
  { label: "1W", code: "1w" },
  { label: "1M", code: "1M" },
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

// ───────────────────────── indicadores técnicos ────────────────────────────
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    if (i <= period) {
      avgG += g / period;
      avgL += l / period;
      if (i === period) out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] == null) { ok = false; break; }
      s += values[j];
    }
    if (ok) out[i] = s / period;
  }
  return out;
}

function macdSeries(closes, fast = 12, slow = 26, signalP = 9) {
  const emaF = emaSeries(closes, fast);
  const emaS = emaSeries(closes, slow);
  const macd = closes.map((_, i) => emaF[i] - emaS[i]);
  const signal = emaSeries(macd, signalP);
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
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

// On-chain + ciclo (Puell, MVRV-Z, Altseason, Cycle Top) — function con cache 6 h.
function useOnchain() {
  const [oc, setOc] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await fetchJSON("/.netlify/functions/onchain", 30000);
        if (live && j) setOc(j);
      } catch { /* sin datos */ }
    };
    load();
    const t = setInterval(load, 3600000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return oc;
}

// Macro (DXY + SP500) vía function server-side (Yahoo Finance, sin key).
function useMacro() {
  const [macro, setMacro] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await fetchJSON("/.netlify/functions/macro", 15000);
        if (live && j) setMacro(j);
      } catch { /* sin datos */ }
    };
    load();
    const t = setInterval(load, 900000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return macro;
}

// Estructura técnica de BTC en 4H + sesgo semanal/mensual — alimenta el
// veredicto del Risk Manager y el diagnóstico IA con "todas las temporalidades".
function useBtcStructure(btcCfg) {
  const [structure, setStructure] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [k4h, k1w, k1M] = await Promise.all([
          fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=120"),
          fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=30"),
          fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1M&limit=24"),
        ]);
        const toC = (k) => k.map((c) => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
        const c4h = toC(k4h);
        const base = detectStructure(c4h, btcCfg?.poi?.lo, btcCfg?.invalidation);
        if (live) {
          setStructure({
            ...base,
            weeklyBullish: timeframeBias(toC(k1w)),
            monthlyBullish: timeframeBias(toC(k1M)),
          });
        }
      } catch { /* sin estructura */ }
    };
    load();
    const t = setInterval(load, 300000);
    return () => { live = false; clearInterval(t); };
  }, [btcCfg?.poi?.lo, btcCfg?.invalidation]);
  return structure;
}

// Mayer Multiple (precio / media 200D) y RSI 22D calculados de velas diarias.
function useBtcDaily() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await fetchJSON("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=260");
        const closes = j.map((k) => +k[4]);
        if (closes.length < 222) return;
        const last = closes[closes.length - 1];
        const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
        const rsi = rsiSeries(closes, 22);
        if (live) setS({ mayer: last / ma200, rsi22: rsi[rsi.length - 1] });
      } catch { /* sin datos */ }
    };
    load();
    const t = setInterval(load, 3600000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return s;
}

// Diagnóstico IA — solo cuando las zonas dinámicas ya están listas.
function useAiDiagnosis(online, ctxRef, aiZones) {
  const [ai, setAi] = useState(null);
  const [aiError, setAiError] = useState(null);
  const zonesReady = !!(aiZones?.zones?.BTCUSDT && aiZones?.zones?.ETHUSDT);
  useEffect(() => {
    if (!online || !zonesReady) return;
    let live = true;
    let retries = 0;
    const load = async () => {
      try {
        const res = await fetch("/.netlify/functions/diagnosis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctxRef.current),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (res.status === 500 && err.error?.includes("API_KEY")) {
            if (live) setAiError("Sin API keys configuradas. Revisa .env (GEMINI_API_KEY o ANTHROPIC_API_KEY).");
            return;
          }
          if (retries < 2) { retries++; } else { return; }
          return;
        }
        const j = await res.json();
        if (live && j?.text) { setAi(j); setAiError(null); retries = 0; }
      } catch (e) {
        if (retries < 2) { retries++; } else if (live) setAiError("Error al cargar diagnóstico: " + String(e).slice(0, 50));
      }
    };
    load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, [online, zonesReady, aiZones?.at, ctxRef]);
  return ai || (aiError ? { error: aiError } : null);
}

// Zonas dinámicas por LLM — reemplazan por completo las zonas estáticas.
function useAiZones(online, ctxRef) {
  const [z, setZ] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!online) return;
    let live = true;
    const load = async () => {
      setLoading(true);
      try {
        const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
        const assets = {};
        await Promise.all(syms.map(async (s) => {
          const k = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=1d&limit=120`);
          assets[s] = {
            price: +k[k.length - 1][4],
            velasDiarias: k.map((c) => [+(+c[2]).toPrecision(6), +(+c[3]).toPrecision(6), +(+c[4]).toPrecision(6)]),
          };
        }));
        const { zonasIA, ...contexto } = ctxRef.current || {};
        const res = await fetch("/.netlify/functions/zones", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assets, contexto }),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (live && j?.zones) setZ(j);
      } catch { /* sin zonas */ }
      finally { if (live) setLoading(false); }
    };
    const first = setTimeout(load, 2000);
    const t = setInterval(load, 4 * 60 * 60 * 1000);
    return () => { live = false; clearTimeout(first); clearInterval(t); };
  }, [online, ctxRef]);
  return { data: z, loading };
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
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=400`
        );
        if (!live) return;
        setCandles(j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
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
const CHART_BASE_COUNT = 150;
const CHART_MIN_COUNT = 12;

function fmtCandleTime(t, interval) {
  const d = new Date(t);
  if (interval === "4h") {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (interval === "1w" || interval === "1M") {
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
}

function ZoneChart({ cfg, candles, err, live, interval }) {
  const W = 720, PRICE_H = 360, IND_H = 90, GAP = 14, padTop = 10, padBot = 16, padRight = 64;
  const RSI_TOP = PRICE_H + GAP;
  const MACD_TOP = RSI_TOP + IND_H + GAP;
  const H_TOT = MACD_TOP + IND_H + 4;
  const [hover, setHover] = useState(null);
  const [candleHover, setCandleHover] = useState(null);
  const [zoom, setZoom] = useState(1);
  const touchRef = useRef(null);
  const wrapRef = useRef(null);

  const applyZoomDelta = useCallback((delta) => {
    setZoom((z) => {
      const next = z * (delta > 0 ? 1.18 : 1 / 1.18);
      return Math.max(1, Math.min(8, next));
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      applyZoomDelta(e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoomDelta]);

  const visibleCount = Math.max(CHART_MIN_COUNT, Math.round(CHART_BASE_COUNT / zoom));

  const view = useMemo(() => {
    if (!candles || !candles.length) return null;
    const cs = candles.slice(-visibleCount);
    let lo = Infinity, hi = -Infinity;
    cs.forEach((c) => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    cfg.zones.forEach((z) => { lo = Math.min(lo, z.from); hi = Math.max(hi, z.to); });
    cfg.lines.forEach((l) => { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); });
    if (live) { lo = Math.min(lo, live); hi = Math.max(hi, live); }
    const span = hi - lo || 1;
    lo -= span * 0.03; hi += span * 0.03;
    const y = (p) => padTop + (1 - (p - lo) / (hi - lo)) * (PRICE_H - padTop - padBot);
    const plotW = W - padRight;
    const step = plotW / cs.length;
    const bw = Math.max(1.2, step * 0.62);
    const closes = candles.map((c) => c.c);
    const off = candles.length - cs.length;
    const rsi = rsiSeries(closes, 14).slice(off);
    const rsiMa = smaSeries(rsiSeries(closes, 14), 14).slice(off);
    const mz = macdSeries(closes);
    const macd = mz.macd.slice(off), signal = mz.signal.slice(off), hist = mz.hist.slice(off);
    let maxAbs = 0;
    macd.forEach((v, i) => { maxAbs = Math.max(maxAbs, Math.abs(v), Math.abs(signal[i]), Math.abs(hist[i])); });
    if (!maxAbs) maxAbs = 1;
    return { cs, lo, hi, y, step, bw, plotW, rsi, rsiMa, macd, signal, hist, maxAbs };
  }, [candles, cfg, live, visibleCount]);

  const onTouchStart = (e) => {
    touchRef.current = { y: e.touches[0].clientY, zoom };
  };
  const onTouchMove = (e) => {
    if (!touchRef.current) return;
    const dy = e.touches[0].clientY - touchRef.current.y;
    if (Math.abs(dy) < 18) return;
    applyZoomDelta(dy > 0 ? 1 : -1);
    touchRef.current = { y: e.touches[0].clientY, zoom };
  };
  const onTouchEnd = () => { touchRef.current = null; };

  if (err) return (
    <div className="grid place-items-center text-center text-xs text-rose-300 py-16 px-4">
      No se pudieron cargar velas en vivo (Binance bloqueado o sin red).
      {cfg.zones.length > 0 && <ZoneList cfg={cfg} />}
    </div>
  );
  if (!view) return (
    <div className="grid place-items-center text-xs text-slate-500 py-16">Cargando velas en vivo…</div>
  );

  const { cs, lo, hi, y, step, bw, plotW, rsi, rsiMa, macd, signal, hist, maxAbs } = view;
  const ticks = 5;
  const xAt = (i) => i * step + step / 2;
  const rsiY = (v) => RSI_TOP + (1 - v / 100) * IND_H;
  const macdMid = MACD_TOP + IND_H / 2;
  const macdY = (v) => macdMid - (v / maxAbs) * (IND_H / 2 - 6);
  const toPoints = (arr, fy) =>
    arr.map((v, i) => (v == null ? null : `${xAt(i)},${fy(v)}`)).filter(Boolean).join(" ");
  const lastVal = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const zoneColor = (k, hovered) =>
    k === "target" ? `rgba(52,211,153,${hovered ? 0.32 : 0.13})`
    : k === "poi" ? `rgba(56,189,248,${hovered ? 0.32 : 0.13})`
    : `rgba(251,113,133,${hovered ? 0.32 : 0.13})`;
  const zoneStroke = (k) => (k === "target" ? "#34d399" : k === "poi" ? "#38bdf8" : "#fb7185");
  const lineColor = (k) => (k === "stop" ? "#fb7185" : k === "error" ? "#f43f5e" : "#94a3b8");
  const fmtP = (p) => (p >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(0));

  return (
    <div
      ref={wrapRef}
      className="relative touch-none select-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {zoom > 1 && (
        <div className="absolute top-1 right-2 z-10 text-[9px] font-mono text-violet-300 bg-slate-950/80 px-1.5 py-0.5 rounded border border-violet-500/30">
          zoom {zoom.toFixed(1)}× · {visibleCount} velas
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H_TOT}`} className="w-full" style={{ display: "block" }}>
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
        {cfg.zones.map((z, i) => {
          const yt = y(z.to), yb = y(z.from);
          const hovered = hover === i;
          return (
            <g key={"z" + i}>
              <rect
                x={0} y={yt} width={plotW} height={Math.max(2, yb - yt)}
                fill={zoneColor(z.kind, hovered)}
                stroke={hovered ? zoneStroke(z.kind) : "none"} strokeWidth="1"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
              <text x={6} y={yt + 12} fill={z.kind === "target" ? "#6ee7b7" : "#7dd3fc"} fontSize="10" fontFamily="monospace" pointerEvents="none">
                {z.label} · {fmtP(z.from)}–{fmtP(z.to)}
              </text>
            </g>
          );
        })}
        {cs.map((c, i) => {
          const x = i * step + step / 2;
          const up = c.c >= c.o;
          const col = up ? "#34d399" : "#f87171";
          const yo = y(c.o), yc = y(c.c);
          const hitW = Math.max(bw + 2, step * 0.85);
          return (
            <g key={i}>
              <rect
                x={x - hitW / 2} y={padTop} width={hitW} height={PRICE_H - padTop - padBot}
                fill="transparent"
                onMouseEnter={() => setCandleHover(i)}
                onMouseLeave={() => setCandleHover(null)}
              />
              <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
              <rect x={x - bw / 2} y={Math.min(yo, yc)} width={bw} height={Math.max(1, Math.abs(yc - yo))} fill={col} pointerEvents="none" />
            </g>
          );
        })}
        {cfg.lines.map((l, i) => (
          <g key={"l" + i}>
            <line x1={0} x2={plotW} y1={y(l.price)} y2={y(l.price)} stroke={lineColor(l.kind)} strokeWidth="1" strokeDasharray="5 4" />
            <text x={plotW - 4} y={y(l.price) - 3} textAnchor="end" fill={lineColor(l.kind)} fontSize="10" fontFamily="monospace">
              {l.label} {Math.round(l.price).toLocaleString()}
            </text>
          </g>
        ))}
        {live && (
          <g>
            <line x1={0} x2={plotW} y1={y(live)} y2={y(live)} stroke="#e2e8f0" strokeWidth="1" />
            <rect x={plotW} y={y(live) - 8} width={padRight} height={16} fill="#e2e8f0" />
            <text x={plotW + 4} y={y(live) + 3} fill="#0f172a" fontSize="10" fontWeight="700" fontFamily="monospace">
              {Math.round(live).toLocaleString()}
            </text>
          </g>
        )}
        {hover != null && cfg.zones[hover] && (() => {
          const z = cfg.zones[hover];
          const txt = `${z.label}: ${fmtP(z.from)} – ${fmtP(z.to)}`;
          const dist = live ? ` · dist ${(((z.from + z.to) / 2 - live) / live * 100).toFixed(1)}%` : "";
          const full = txt + dist;
          const tw = full.length * 6.3 + 18;
          const ty = Math.max(padTop + 2, Math.min(y(z.to) + 8, PRICE_H - padBot - 26));
          return (
            <g pointerEvents="none">
              <rect x={8} y={ty} width={tw} height={20} rx={4} fill="#0f172a" stroke={zoneStroke(z.kind)} strokeWidth="1" opacity="0.95" />
              <text x={17} y={ty + 13.5} fill="#e2e8f0" fontSize="10" fontFamily="monospace">{full}</text>
            </g>
          );
        })()}
        {candleHover != null && cs[candleHover]?.t && (() => {
          const c = cs[candleHover];
          const label = fmtCandleTime(c.t, interval);
          const x = xAt(candleHover);
          const tw = label.length * 6.5 + 16;
          const tx = Math.max(4, Math.min(x - tw / 2, plotW - tw - 4));
          return (
            <g pointerEvents="none">
              <line x1={x} x2={x} y1={PRICE_H - padBot} y2={PRICE_H - 2} stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 2" />
              <rect x={tx} y={PRICE_H - padBot + 2} width={tw} height={18} rx={3} fill="#0f172a" stroke="#475569" strokeWidth="1" opacity="0.95" />
              <text x={tx + 8} y={PRICE_H - padBot + 14} fill="#e2e8f0" fontSize="10" fontFamily="monospace">{label}</text>
            </g>
          );
        })()}

        <g>
          <rect x={0} y={RSI_TOP} width={plotW} height={IND_H} fill="rgba(167,139,250,0.06)" />
          <rect x={0} y={rsiY(70)} width={plotW} height={rsiY(30) - rsiY(70)} fill="rgba(148,163,184,0.07)" />
          {[70, 50, 30].map((v) => (
            <g key={v}>
              <line x1={0} x2={plotW} y1={rsiY(v)} y2={rsiY(v)} stroke="#334155" strokeWidth="1" strokeDasharray={v === 50 ? "2 4" : "4 4"} />
              <text x={plotW + 6} y={rsiY(v) + 3} fill="#64748b" fontSize="9" fontFamily="monospace">{v}</text>
            </g>
          ))}
          <polyline points={toPoints(rsi, rsiY)} fill="none" stroke="#a78bfa" strokeWidth="1.3" />
          <polyline points={toPoints(rsiMa, rsiY)} fill="none" stroke="#eab308" strokeWidth="1" />
          <text x={6} y={RSI_TOP + 11} fill="#a78bfa" fontSize="10" fontFamily="monospace">
            RSI 14 {lastVal(rsi) != null ? lastVal(rsi).toFixed(1) : ""}
          </text>
          <text x={110} y={RSI_TOP + 11} fill="#eab308" fontSize="10" fontFamily="monospace">
            media 14 {lastVal(rsiMa) != null ? lastVal(rsiMa).toFixed(1) : ""}
          </text>
        </g>

        <g>
          <rect x={0} y={MACD_TOP} width={plotW} height={IND_H} fill="rgba(96,165,250,0.05)" />
          <line x1={0} x2={plotW} y1={macdMid} y2={macdMid} stroke="#334155" strokeWidth="1" />
          {hist.map((v, i) => (
            <rect
              key={i}
              x={xAt(i) - bw / 2}
              y={v >= 0 ? macdY(v) : macdMid}
              width={bw}
              height={Math.max(0.5, Math.abs(macdY(v) - macdMid))}
              fill={v >= 0 ? "rgba(52,211,153,0.55)" : "rgba(248,113,113,0.55)"}
            />
          ))}
          <polyline points={toPoints(macd, macdY)} fill="none" stroke="#60a5fa" strokeWidth="1.3" />
          <polyline points={toPoints(signal, macdY)} fill="none" stroke="#fb923c" strokeWidth="1" />
          <text x={6} y={MACD_TOP + 11} fill="#60a5fa" fontSize="10" fontFamily="monospace">
            MACD 12·26·9 {lastVal(macd) != null ? lastVal(macd).toFixed(lastVal(macd) >= 100 ? 0 : 2) : ""}
          </text>
          <text x={160} y={MACD_TOP + 11} fill="#fb923c" fontSize="10" fontFamily="monospace">
            señal {lastVal(signal) != null ? lastVal(signal).toFixed(lastVal(signal) >= 100 ? 0 : 2) : ""}
          </text>
        </g>
      </svg>
      <p className="px-2 pb-2 text-[10px] text-slate-500 font-mono">
        Desliza ↓ o rueda ↓ para ampliar · ↑ para volver · pasa el cursor sobre una vela para ver la fecha
      </p>
    </div>
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

function ChartCard({ symbol, cfg, live, aiTag, zonesPending }) {
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
          {aiTag && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-300">
              zonas IA
            </span>
          )}
          {zonesPending && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full border border-slate-600 text-slate-400 animate-pulse">
              calculando…
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
      {cfg.comment && (
        <p className="px-3 py-1.5 text-[11px] text-slate-400 border-b border-slate-700/60">{cfg.comment}</p>
      )}
      <ZoneChart cfg={cfg} candles={candles} err={err} live={live} interval={iv} />
    </div>
  );
}

// ───────────────────────── reloj local en vivo ─────────────────────────────
function LocalClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-800/60 px-2.5 py-1 text-xs font-mono text-slate-300">
      {now.toLocaleTimeString()} · {tz.split("/").pop().replace(/_/g, " ")}
    </span>
  );
}

// ───────────────────────── calendario económico ────────────────────────────
function ImpactIcon({ impact }) {
  const level = (impact || "Low").toLowerCase();
  const bars = level === "high" ? 3 : level === "medium" ? 2 : 1;
  const color = level === "high" ? "bg-rose-500" : level === "medium" ? "bg-amber-400" : "bg-slate-500";
  const title = level === "high" ? "Alto impacto" : level === "medium" ? "Impacto medio" : "Bajo impacto";
  return (
    <span className="inline-flex items-end gap-0.5 h-4" title={title}>
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} className={`w-1 rounded-sm ${color}`} style={{ height: 6 + i * 4 }} />
      ))}
      {level === "low" && Array.from({ length: 2 }).map((_, i) => (
        <span key={"e" + i} className="w-1 rounded-sm bg-slate-700" style={{ height: 6 }} />
      ))}
    </span>
  );
}

function useEconomicCalendar() {
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const j = await fetchJSON("/.netlify/functions/calendar", 15000);
        if (live && j?.events) { setEvents(j.events); setErr(false); }
      } catch { if (live) setErr(true); }
    };
    load();
    const t = setInterval(load, 3600000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return { events, err };
}

function EconomicCalendar() {
  const { events, err } = useEconomicCalendar();
  const nowRowRef = useRef(null);
  const eventKey = (e) => e.date + "|" + e.title;

  const { grouped, currentKey } = useMemo(() => {
    if (!events?.length) return { grouped: [], currentKey: null };
    const now = Date.now();
    // El evento "del momento": el próximo que aún no pasó (o el último si ya pasaron todos).
    const next = events.find((e) => new Date(e.date).getTime() >= now);
    const currentKey = eventKey(next || events[events.length - 1]);
    const map = new Map();
    events.forEach((e) => {
      const day = new Date(e.date).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(e);
    });
    return { grouped: [...map.entries()], currentKey };
  }, [events]);

  // Al abrir/recargar la página, llevar la vista directo al evento vigente según la hora.
  useEffect(() => {
    if (nowRowRef.current) nowRowRef.current.scrollIntoView({ block: "center" });
  }, [currentKey]);

  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Calendar size={16} className="text-slate-300" />
        <h2 className="text-sm font-mono tracking-wide text-slate-300">Calendario económico</h2>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-slate-600 text-slate-400">
          solo impacto relevante para cripto
        </span>
      </div>
      {err && !events && (
        <p className="text-xs text-rose-300">No se pudo cargar el calendario.</p>
      )}
      {!events && !err && (
        <p className="text-xs text-slate-500">Cargando eventos de la semana…</p>
      )}
      {events && !events.length && (
        <p className="text-xs text-slate-500">Sin eventos de alto/medio impacto relevantes esta semana.</p>
      )}
      {grouped.length > 0 && (
        <div className="max-h-[450px] overflow-y-auto rounded-md border border-slate-700/60">
          {grouped.map(([day, evs]) => (
            <div key={day}>
              <div className="sticky top-0 z-10 bg-slate-900/95 px-3 py-2 text-xs font-mono uppercase tracking-wider text-slate-400 border-b border-slate-700/60">
                {day}
              </div>
              <table className="w-full text-left text-xs">
                <tbody>
                  {evs.map((e, i) => {
                    const isCurrent = eventKey(e) === currentKey;
                    return (
                      <tr
                        key={i}
                        ref={isCurrent ? nowRowRef : null}
                        className={`border-b border-slate-800/80 hover:bg-slate-800/40 ${
                          isCurrent ? "bg-violet-500/10 ring-1 ring-inset ring-violet-500/40" : ""
                        }`}
                      >
                        <td className="py-2 pl-3 pr-2 font-mono text-slate-400 whitespace-nowrap w-16">
                          {isCurrent && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-400 align-middle animate-pulse" />}
                          {new Date(e.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="py-2 px-2 w-10 font-mono text-slate-500">{e.country}</td>
                        <td className="py-2 px-2 w-12"><ImpactIcon impact={e.impact} /></td>
                        <td className={`py-2 px-2 ${isCurrent ? "text-violet-200 font-semibold" : "text-slate-200"}`}>
                          {e.title}
                          {isCurrent && <span className="ml-2 text-[9px] font-mono uppercase tracking-wider text-violet-400">ahora</span>}
                        </td>
                        <td className="py-2 px-2 font-mono text-slate-400 text-right hidden sm:table-cell">{e.forecast || "—"}</td>
                        <td className="py-2 pr-3 pl-2 font-mono text-slate-500 text-right hidden sm:table-cell">{e.previous || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-500">Antes de CPI/FOMC: manos quietas. Iconos: rojo = alto · ámbar = medio. Solo se muestran eventos de alto impacto (cualquier divisa) o impacto medio en USD.</p>
    </section>
  );
}

// ───────────────────────── diagnóstico dinámico ────────────────────────────
function Diagnosis({ btc, fg, etf, onchain, ai, cfg = ASSETS.BTCUSDT, zonesLoading }) {
  const bullets = [];
  let verdict, vtone;
  const hasZones = cfg.poi && cfg.invalidation != null;

  if (btc == null) {
    verdict = "Sin precio en vivo — diagnóstico en pausa.";
    vtone = "warn";
  } else if (zonesLoading || !hasZones) {
    verdict = "Calculando zonas y diagnóstico dinámicos (IA)…";
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
  if (onchain?.cycleTop) {
    bullets.push(`Cycle Top ${onchain.cycleTop.hit}/${onchain.cycleTop.total}: ${
      onchain.cycleTop.hit === 0 ? "riesgo de comprar un techo = bajo. El riesgo real es timing/estructura." : "indicadores de techo activos — subir la cautela."}`);
  }
  if (etf?.btc) {
    const f = etf.btc;
    bullets.push(`Flujos ETF BTC ${f.total >= 0 ? "+" : "−"}${Math.abs(f.total).toFixed(1)}M (${f.date}): ${
      f.total >= 0 ? "entrada — un día no confirma reversión." : "salida — sin reversión confirmada, no anticipar."}`);
  }
  if (onchain?.altseason) {
    bullets.push(`Altseason ${onchain.altseason.value} = ${onchain.altseason.value >= 75 ? "ALTSEASON activa." : "NO altseason."} Alts fuera (y bloqueadas por mandato).`);
  }

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Stethoscope size={16} className="text-slate-300" />
          <h2 className="text-sm font-mono tracking-wide text-slate-300">Diagnóstico (dinámico)</h2>
        </div>
        {ai && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-300">
            {ai.model || "IA"} · {new Date(ai.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      {/* veredicto por reglas — instantáneo, no depende de la IA */}
      <div className={`rounded-md px-3 py-2.5 text-sm font-semibold border ${
        vtone === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
        : vtone === "danger" ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
        : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
        {verdict}
      </div>
      {ai?.error ? (
        <p className="mt-3 text-xs text-rose-300">{ai.error}</p>
      ) : ai?.text ? (
        <div className="mt-3 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{ai.text}</div>
      ) : zonesLoading || !hasZones ? (
        <p className="mt-3 text-xs text-slate-500">Esperando análisis de Gemini Pro con velas y contexto en vivo…</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-xs text-slate-400">
              <span className="text-slate-600 mt-0.5">›</span>{b}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────── playbook de posiciones ──────────────────────────
function Playbook({ data, aiModel, loading }) {
  if (loading && !data?.length) {
    return (
      <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Target size={16} className="text-slate-300" />
          <h2 className="text-sm font-mono tracking-wide text-slate-300">Posibles posiciones — semanal · mensual · anual</h2>
        </div>
        <p className="text-xs text-slate-500">Generando escenarios dinámicos a partir de la estructura actual…</p>
      </section>
    );
  }
  if (!data?.length) {
    return (
      <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Target size={16} className="text-slate-300" />
          <h2 className="text-sm font-mono tracking-wide text-slate-300">Posibles posiciones — semanal · mensual · anual</h2>
        </div>
        <p className="text-xs text-slate-500">Sin playbook IA disponible. Revisa la key de Gemini en Netlify.</p>
      </section>
    );
  }
  const rows = data;
  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-slate-300" />
          <h2 className="text-sm font-mono tracking-wide text-slate-300">Posibles posiciones — semanal · mensual · anual</h2>
        </div>
        {data?.length && aiModel ? (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-300">
            {aiModel}
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-slate-500 mb-3">Escenarios, no señales. Antes de ejecutar: confirma R:R ≥ 1.5 y revisa la compuerta pre-trade.</p>
      <div className="grid gap-3 lg:grid-cols-3">
        {rows.map((h) => (
          <div key={h.horizon} className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
            <div className="font-mono text-xs uppercase tracking-wider text-slate-400 mb-2">{h.horizon}</div>
            <div className="space-y-3">
              {h.ideas.map((p, i) => (
                <div key={i} className="rounded-md border border-slate-700 bg-slate-900/60 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-bold text-slate-100">{p.asset}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300">{p.side}</span>
                  </div>
                  <dl className="mt-2 space-y-1 text-[11px] font-mono">
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">Entrada</dt><dd className="text-slate-200 text-right">{p.entry}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">Stop</dt><dd className="text-rose-300 text-right">{p.stop}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">Target</dt><dd className="text-emerald-300 text-right">{p.target}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-slate-500">R:R</dt><dd className="text-slate-200 text-right">{p.rr}</dd></div>
                  </dl>
                  <p className="mt-1.5 text-[11px] text-slate-400">{p.cond}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ───────────────────────── checklist pre-trade ──────────────────────────────
const CHECKS = [
  "Veredicto de hoy (Risk & Portfolio Manager) revisado ANTES de ejecutar",
  "El activo es BTC o ETH (nada más)",
  "R:R ≥ 1.5 confirmado",
  "Entrada en POI estructural, NO en número redondo",
  "Stop por DEBAJO del cluster retail obvio",
  "Sin evento macro de alto impacto pendiente (CPI/FOMC)",
];
// Lista de referencia, sin interacción — el control real es el veredicto del Risk Manager.
function Checklist() {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 mb-3"><ShieldAlert size={16} className="text-slate-300" /><h3 className="font-mono text-sm tracking-wide text-slate-200">Compuerta pre-trade (referencia)</h3></div>
      <ul className="space-y-1.5">
        {CHECKS.map((c, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <CheckCircle2 size={14} className="text-slate-500 mt-0.5 shrink-0" />
            <span className="text-xs text-slate-400">{c}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-slate-500">Si una sola no se cumple, no hay trade.</p>
    </div>
  );
}

// ───────────────────────── app ─────────────────────────────────────────────
export default function Cockpit() {
  const { data: prices, status, updated, reload } = useLivePrices();
  const { fg, dom } = useMarketMeta();
  const etf = useEtfFlows();
  const derivs = useDerivs();
  const onchain = useOnchain();
  const daily = useBtcDaily();
  const macro = useMacro();
  const btc = prices.BTCUSDT?.price ?? null;
  const eth = prices.ETHUSDT?.price ?? null;
  const sol = prices.SOLUSDT?.price ?? null;

  // Contexto completo para la IA — siempre con el último estado.
  const ctxRef = useRef(null);
  const ready = status === "live" && btc != null;
  const { data: aiZones, loading: zonesLoading } = useAiZones(ready, ctxRef);
  const ai = useAiDiagnosis(ready, ctxRef, aiZones);

  // Config de cada activo: zonas IA si llegaron, estáticas si no.
  const mergedAssets = useMemo(() => {
    const out = {};
    for (const sym of Object.keys(ASSETS)) {
      const base = ASSETS[sym];
      const az = aiZones?.zones?.[sym];
      if (!az) { out[sym] = base; continue; }
      const poiZone = az.zones.find((z) => z.kind === "poi");
      const stopLine = az.lines.find((l) => l.kind === "stop");
      const targetZone = az.zones.find((z) => z.kind === "target");
      out[sym] = {
        ...base,
        zones: az.zones,
        lines: az.lines,
        comment: az.comment,
        poi: poiZone ? { lo: poiZone.from, hi: poiZone.to } : base.poi,
        invalidation: stopLine ? stopLine.price : base.invalidation,
        target: targetZone ? targetZone.from : base.target,
      };
    }
    return out;
  }, [aiZones]);

  // Estructura técnica multi-temporal de BTC (4H + semanal + mensual) —
  // alimenta el veredicto del Risk Manager y el resumen completo de la IA.
  const structure = useBtcStructure(mergedAssets.BTCUSDT);

  ctxRef.current = {
    precios: { btc, eth, sol },
    cambio24h: {
      btc: prices.BTCUSDT?.change ?? null,
      eth: prices.ETHUSDT?.change ?? null,
      sol: prices.SOLUSDT?.change ?? null,
    },
    fearGreed: fg,
    dominancia: dom,
    etfFlujosUsdM: etf,
    derivados: derivs,
    onchain,
    mayer200d: daily?.mayer ?? null,
    rsi22d: daily?.rsi22 ?? null,
    zonasIA: aiZones?.zones ?? null,
    macro: macro ? { dxy: macro.dxy ?? null, sp500: macro.sp500 ?? null } : null,
    estructuraBTC: structure ? {
      choch4h: structure.choch4h,
      bos4h: structure.bos4h,
      liquiditySweep: structure.liquiditySweep,
      htfBullish: structure.htfBullish,
      weeklyBullish: structure.weeklyBullish,
      monthlyBullish: structure.monthlyBullish,
      trend: structure.trend,
    } : null,
  };

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
              <h1 className="text-xl md:text-2xl font-bold tracking-tight text-slate-50">CRYPTO TRADING</h1>
              <p className="text-xs text-slate-400 font-mono">Monitoreo</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <LocalClock />
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

        {/* charts con zonas */}
        <section className="grid gap-4 lg:grid-cols-3">
          <ChartCard symbol="BTCUSDT" cfg={mergedAssets.BTCUSDT} live={btc} aiTag={!!aiZones?.zones?.BTCUSDT} zonesPending={zonesLoading && !mergedAssets.BTCUSDT.zones.length} />
          <ChartCard symbol="ETHUSDT" cfg={mergedAssets.ETHUSDT} live={eth} aiTag={!!aiZones?.zones?.ETHUSDT} zonesPending={zonesLoading && !mergedAssets.ETHUSDT.zones.length} />
          <ChartCard symbol="SOLUSDT" cfg={mergedAssets.SOLUSDT} live={sol} aiTag={!!aiZones?.zones?.SOLUSDT} zonesPending={zonesLoading && !mergedAssets.SOLUSDT.zones.length} />
        </section>

        <EconomicCalendar />

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
          <div className="flex items-center gap-2 mb-2"><Radio size={15} className="text-emerald-400" /><h2 className="text-sm font-mono tracking-wide text-slate-300">On-chain & ciclo — live, actualización diaria</h2></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Live label="Puell Multiple" value={onchain?.puell ? onchain.puell.value.toFixed(2) : "—"}
              sub={onchain?.puell ? (onchain.puell.value < 0.8 ? "Infravalorado" : onchain.puell.value > 3 ? "Sobrecalentado" : "Neutral") : "bitcoin-data.com"}
              tone={onchain?.puell ? (onchain.puell.value < 0.8 ? toneClasses.good : onchain.puell.value > 3 ? toneClasses.danger : toneClasses.warn) : toneClasses.warn} />
            <Live label="MVRV Z-Score" value={onchain?.mvrvz ? onchain.mvrvz.value.toFixed(2) : "—"}
              sub={onchain?.mvrvz ? (onchain.mvrvz.value < 1 ? "Zona de valor" : onchain.mvrvz.value > 5 ? "Zona de techo" : "Neutral") : "bitcoin-data.com"}
              tone={onchain?.mvrvz ? (onchain.mvrvz.value < 1 ? toneClasses.good : onchain.mvrvz.value > 5 ? toneClasses.danger : toneClasses.warn) : toneClasses.warn} />
            <Live label="Mayer Multiple" value={daily ? daily.mayer.toFixed(2) : "—"}
              sub={daily ? (daily.mayer < 1 ? "< media 200D" : daily.mayer > 2.4 ? "> 2.4 techo" : "Sobre la media") : "calculado de Binance"}
              tone={daily ? (daily.mayer < 1 ? toneClasses.good : daily.mayer > 2.4 ? toneClasses.danger : toneClasses.warn) : toneClasses.warn} />
            <Live label="RSI 22D" value={daily?.rsi22 != null ? daily.rsi22.toFixed(1) : "—"}
              sub={daily?.rsi22 != null ? (daily.rsi22 <= 30 ? "Sobreventa" : daily.rsi22 >= 70 ? "Sobrecompra" : "Neutral") : "calculado de Binance"}
              tone={daily?.rsi22 != null ? (daily.rsi22 <= 30 ? toneClasses.good : daily.rsi22 >= 70 ? toneClasses.danger : toneClasses.warn) : toneClasses.warn} />
            <Live label="Cycle Top" value={onchain?.cycleTop ? `${onchain.cycleTop.hit}/${onchain.cycleTop.total}` : "—"}
              sub={onchain?.cycleTop ? (onchain.cycleTop.hit === 0 ? "Hold" : "Señales de techo") : "Coinglass"}
              tone={onchain?.cycleTop ? (onchain.cycleTop.hit === 0 ? toneClasses.good : onchain.cycleTop.hit < 5 ? toneClasses.warn : toneClasses.danger) : toneClasses.warn} />
            <Live label="Altcoin Season" value={onchain?.altseason ? String(onchain.altseason.value) : "—"}
              sub={onchain?.altseason ? (onchain.altseason.value >= 75 ? "Altseason" : onchain.altseason.value <= 25 ? "Bitcoin season" : "NO altseason") : "CoinMarketCap"}
              tone={onchain?.altseason ? (onchain.altseason.value >= 75 ? toneClasses.danger : toneClasses.warn) : toneClasses.warn} />
          </div>
        </section>

        <RiskPortfolioManager
          btc={btc}
          eth={eth}
          btcChange={prices.BTCUSDT?.change ?? null}
          ethChange={prices.ETHUSDT?.change ?? null}
          fg={fg}
          etf={etf}
          derivs={derivs}
          onchain={onchain}
          daily={daily}
          macro={macro}
          structure={structure}
          btcCfg={mergedAssets.BTCUSDT}
          ethCfg={mergedAssets.ETHUSDT}
        />

        <Diagnosis btc={btc} fg={fg} etf={etf} onchain={onchain} ai={ai} cfg={mergedAssets.BTCUSDT} zonesLoading={zonesLoading} />

        <Playbook data={aiZones?.playbook} aiModel={aiZones?.model} loading={zonesLoading} />

        {/* disciplina */}
        <Checklist />

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
          Live: precios y velas (Binance), Fear&Greed y dominancia (CoinMarketCap), flujos ETF (Farside), funding/OI (Binance Futures), on-chain (bitcoin-data.com), Cycle Top (Coinglass), altseason (CMC), calendario (TradingView). Diagnóstico generado por Claude con este contexto. No ejecuta trades.
        </footer>
      </div>
    </div>
  );
}
