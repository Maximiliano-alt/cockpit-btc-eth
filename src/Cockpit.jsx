import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Lock, AlertTriangle, CheckCircle2, XCircle,
  Calendar, ExternalLink, ShieldAlert, Target, Radio, RefreshCw,
  Stethoscope, Wifi, WifiOff
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
  SOLUSDT: {
    name: "SOL / USDT",
    tvSymbol: "BINANCE:SOLUSDT",
    zones: [],   // sin análisis de zonas aún — solo monitoreo
    lines: [],
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

// Diagnóstico IA (claude-sonnet-4-6 vía function con cache 15 min).
// Solo dispara cuando el dashboard está online y con precio cargado, para no
// gastar tokens; el primer request espera 5 s a que llegue el resto del contexto.
function useAiDiagnosis(online, ctxRef) {
  const [ai, setAi] = useState(null);
  useEffect(() => {
    if (!online) return;
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/.netlify/functions/diagnosis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctxRef.current),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (live && j?.text) setAi(j);
      } catch { /* fallback a reglas */ }
    };
    const first = setTimeout(load, 5000);
    const t = setInterval(load, 15 * 60 * 1000);
    return () => { live = false; clearTimeout(first); clearInterval(t); };
  }, [online, ctxRef]);
  return ai;
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
  // Tres paneles: precio (con zonas), RSI 14 + media 14, MACD 12·26·9.
  const W = 720, PRICE_H = 360, IND_H = 90, GAP = 14, padTop = 10, padBot = 16, padRight = 64;
  const RSI_TOP = PRICE_H + GAP;
  const MACD_TOP = RSI_TOP + IND_H + GAP;
  const H_TOT = MACD_TOP + IND_H + 4;
  const [hover, setHover] = useState(null); // índice de zona bajo el mouse
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
    const y = (p) => padTop + (1 - (p - lo) / (hi - lo)) * (PRICE_H - padTop - padBot);
    const plotW = W - padRight;
    const step = plotW / cs.length;
    const bw = Math.max(1.2, step * 0.62);
    // Indicadores calculados sobre TODAS las velas (warmup) y recortados a la vista.
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
    <svg viewBox={`0 0 ${W} ${H_TOT}`} className="w-full" style={{ display: "block" }}>
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
      {/* zones (con precios y hover) */}
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
      {/* tooltip de zona en hover */}
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

      {/* ── panel RSI 14 + media 14 ── */}
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

      {/* ── panel MACD 12·26·9 ── */}
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
function Diagnosis({ btc, fg, etf, onchain, ai }) {
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
            claude-sonnet-4-6 · {new Date(ai.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
      {ai?.text ? (
        <div className="mt-3 text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{ai.text}</div>
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
// Escenarios condicionados a estructura — NO son señales. Derivados de las
// zonas de ASSETS (POI, invalidación, imanes). Todo pasa por el filtro R:R.
const PLAYBOOK = [
  {
    horizon: "Semanal",
    ideas: [
      { asset: "BTC", side: "Long swing", entry: "POI 58,000–60,000", stop: "54,500", target: "65,000–68,000", rr: "≈1.6–2.0", cond: "Solo con CHoCH confirmado en 4H dentro del POI. Sin confirmación, no hay trade." },
      { asset: "ETH", side: "Long swing", entry: "POI 1,500–1,550", stop: "1,400", target: "1,750–1,850", rr: "≈1.8–2.4", cond: "Reacción visible en el POI y BTC sosteniendo el suyo." },
    ],
  },
  {
    horizon: "Mensual",
    ideas: [
      { asset: "BTC", side: "Long posición", entry: "Limits escalonados 58,000–60,000", stop: "54,500", target: "Imán 80,000–85,000", rr: "≈4.5–5.5", cond: "La semanal debe dejar de hacer mínimos decrecientes; flujos ETF en reversión." },
      { asset: "ETH", side: "Long posición", entry: "POI 1,500–1,550", stop: "1,400", target: "Imán 2,400–2,500", rr: "≈7–8", cond: "ETH sigue a BTC: sin BTC constructivo no se abre." },
    ],
  },
  {
    horizon: "Anual",
    ideas: [
      { asset: "BTC", side: "Acumulación", entry: "Escalonada 54,500–60,000", stop: "Cierre semanal bajo 54,500", target: "85,000+ (reevaluar en el imán)", rr: "—", cond: "Tesis on-chain: MVRV-Z < 1, Puell < 1, Cycle Top 0/30. Si cambia, se reevalúa." },
      { asset: "ETH", side: "Acumulación", entry: "Escalonada 1,400–1,550", stop: "Cierre semanal bajo 1,400", target: "2,500+ (vigilar dominancia)", rr: "—", cond: "Mientras NO haya altseason y ETH/BTC no rompa a la baja." },
    ],
  },
];

function Playbook() {
  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Target size={16} className="text-slate-300" />
        <h2 className="text-sm font-mono tracking-wide text-slate-300">Posibles posiciones — semanal · mensual · anual</h2>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">Escenarios, no señales. Antes de ejecutar: filtro R:R + Bitácora.</p>
      <div className="grid gap-3 lg:grid-cols-3">
        {PLAYBOOK.map((h) => (
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
// Lista de referencia, sin interacción — el control real es la Bitácora pre-log.
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
  const btc = prices.BTCUSDT?.price ?? null;
  const eth = prices.ETHUSDT?.price ?? null;
  const sol = prices.SOLUSDT?.price ?? null;

  // Contexto completo para el diagnóstico IA — siempre con el último estado.
  const ctxRef = useRef(null);
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
  };
  const ai = useAiDiagnosis(status === "live" && btc != null, ctxRef);

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

        <EconomicCalendar />

        {/* charts con zonas */}
        <section className="grid gap-4 lg:grid-cols-3">
          <ChartCard symbol="BTCUSDT" cfg={ASSETS.BTCUSDT} live={btc} />
          <ChartCard symbol="ETHUSDT" cfg={ASSETS.ETHUSDT} live={eth} />
          <ChartCard symbol="SOLUSDT" cfg={ASSETS.SOLUSDT} live={sol} />
        </section>

        <Diagnosis btc={btc} fg={fg} etf={etf} onchain={onchain} ai={ai} />

        <Playbook />

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

        {/* disciplina */}
        <section className="grid gap-4 lg:grid-cols-2">
          <RiskGate />
          <Checklist />
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
          Live: precios y velas (Binance), Fear&Greed y dominancia (CoinMarketCap), flujos ETF (Farside), funding/OI (Binance Futures), on-chain (bitcoin-data.com), Cycle Top (Coinglass), altseason (CMC), calendario (TradingView). Diagnóstico generado por Claude con este contexto. No ejecuta trades.
        </footer>
      </div>
    </div>
  );
}
