import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Shield, TrendingUp, Activity, Gavel, TrafficCone,
  Ban, BookOpen, Cpu,
} from "lucide-react";
import {
  computeRiskMetrics, computeExposure, classifyMarketPhase,
  runDecisionEngine, computeTrafficLight, computeAntiFomo,
  computeAllowedTrades, deriveBias, modeLabel, modeDescription,
  riskTone, exposureTone,
} from "./decisionEngine.js";
import { detectStructure, timeframeBias } from "./structure.js";
import { loadPortfolio, savePortfolio, loadJournal, saveJournal, todayKey } from "./storage.js";
import { TRADING_MODE } from "./types.js";

async function fetchJSON(url, ms = 10000) {
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

function useMacroMarkets() {
  const [macro, setMacro] = useState(null);
  useEffect(() => {
    let live = true;
    fetchJSON("/.netlify/functions/macro", 15000)
      .then((j) => { if (live) setMacro(j); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return macro;
}

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

const toneCard = {
  good: "border-emerald-500/40 bg-emerald-500/5",
  warn: "border-amber-500/40 bg-amber-500/5",
  danger: "border-rose-500/40 bg-rose-500/5",
};

function RosCard({ title, icon: Icon, children, tone = "default" }) {
  const border = tone === "default" ? "border-slate-700/60 bg-slate-950/40" : toneCard[tone];
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="flex items-center gap-1.5 mb-2">
        {Icon && <Icon size={14} className="text-slate-400" />}
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function RiskCard({ metrics }) {
  const tone = riskTone(metrics.riskUtilPct);
  return (
    <RosCard title="Riesgo" icon={Shield} tone={tone}>
      <dl className="space-y-1.5 font-mono text-xs">
        <div className="flex justify-between border-t border-slate-700/60 pt-1.5">
          <dt className="text-slate-400">Riesgo disponible</dt>
          <dd className={tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-rose-300"}>
            ${metrics.availableRisk.toFixed(0)}
          </dd>
        </div>
        <div className="text-[10px] text-slate-500">En uso: {metrics.riskUtilPct.toFixed(0)}%</div>
      </dl>
    </RosCard>
  );
}

function ExposureCard({ exposure }) {
  const tone = exposureTone(exposure.tone);
  const pct = Math.min(100, exposure.pct);
  return (
    <RosCard title="Exposición" icon={TrendingUp} tone={tone}>
      <div className="mb-2">
        <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
          <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all ${pct > 80 ? "bg-rose-500" : pct > 60 ? "bg-amber-400" : pct > 30 ? "bg-amber-300" : "bg-emerald-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <dl className="space-y-1 font-mono text-xs">
        <div className="flex justify-between"><dt className="text-slate-500">%</dt><dd className="text-slate-200">{pct.toFixed(0)}%</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Estado</dt>
          <dd className={tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-rose-300"}>{exposure.status}</dd>
        </div>
      </dl>
    </RosCard>
  );
}

function MarketPhaseCard({ marketPhase }) {
  return (
    <RosCard title="Estado del mercado" icon={Activity}>
      <div className="font-mono text-sm font-bold text-violet-300 mb-2">{marketPhase.phaseLabel}</div>
      <ul className="space-y-1">
        {marketPhase.reasons.map((r, i) => (
          <li key={i} className="text-[11px] text-slate-400 flex gap-1.5">
            <span className="text-slate-600">›</span>{r}
          </li>
        ))}
      </ul>
    </RosCard>
  );
}

function VerdictCard({ decision, traffic }) {
  const modeColors = {
    [TRADING_MODE.NO_TRADE]: "text-rose-300 border-rose-500/40 bg-rose-500/10",
    [TRADING_MODE.MANAGE]: "text-amber-200 border-amber-500/40 bg-amber-500/10",
    [TRADING_MODE.SWING]: "text-sky-300 border-sky-500/40 bg-sky-500/10",
    [TRADING_MODE.POSITION]: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
  };
  return (
    <RosCard title="Veredicto" icon={Gavel}>
      <div className={`rounded-md border px-2.5 py-2 font-mono text-sm font-bold ${modeColors[decision.mode] || ""}`}>
        {modeLabel(decision.mode)}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">{modeDescription(decision.mode)}</p>
      <p className="mt-1 text-[10px] text-slate-500">{decision.rationale}</p>
      <div className="mt-3 flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/60 px-2.5 py-2">
        <span className="text-lg">{traffic.emoji}</span>
        <span className="font-mono text-xs text-slate-300">{traffic.label}</span>
      </div>
    </RosCard>
  );
}

function DecisionEnginePanel({ inputs, outputs }) {
  const rows = [
    ["CHoCH 4H", inputs.structure?.choch4h ? "✓" : "✗"],
    ["BOS 4H", inputs.structure?.bos4h ? "✓" : "✗"],
    ["Barrido liquidez", inputs.structure?.liquiditySweep ? "✓" : "✗"],
    ["HTF alcista", inputs.structure?.htfBullish ? "✓" : "✗"],
    ["Semanal", inputs.structure?.weeklyBullish ? "✓" : "✗"],
    ["Mensual", inputs.structure?.monthlyBullish ? "✓" : "✗"],
    ["Macro risk-on", inputs.macroBullish ? "✓" : "✗"],
    ["Asimetría clara", inputs.hasClearAsymmetry ? "✓" : "✗"],
    ["Riesgo disp.", inputs.riskMetrics?.availableRisk > 0 ? `$${inputs.riskMetrics.availableRisk.toFixed(0)}` : "✗"],
  ];
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Cpu size={14} className="text-violet-400" />
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300">Decision Engine</h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 font-mono text-[11px] mb-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <span className="text-slate-500">{k}</span>
            <span className={v === "✓" ? "text-emerald-400" : v === "✗" ? "text-rose-400" : "text-slate-300"}>{v}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-slate-500 border-t border-slate-700/60 pt-2">
        Regla: sin asimetría HTF + liquidez + macro → <span className="text-rose-400">NO_TRADE</span>
        {" · "}Salida: <span className="text-violet-300">{modeLabel(outputs.mode)}</span>
      </p>
    </div>
  );
}

function AntiFomoBlock({ blockers }) {
  if (!blockers.length) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300 font-mono">
        Sin bloqueos anti-FOMO activos.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {blockers.map((b) => (
        <div key={b.id} className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <Ban size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-xs font-mono font-bold text-amber-200">⚠️ {b.text}</div>
            <div className="text-[10px] text-amber-200/70">{b.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AllowedTradesPanel({ allowed }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <TrafficCone size={14} className="text-sky-400" />
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300">Operaciones permitidas</h3>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
        <div className="flex justify-between"><dt className="text-slate-500">Máx. position</dt><dd className="text-slate-200">{allowed.maxPositionTrades}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Máx. swing</dt><dd className="text-slate-200">{allowed.maxSwingTrades}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Simultáneos</dt><dd className="text-slate-200">{allowed.maxSimultaneous}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Máx. riesgo</dt><dd className="text-slate-200">{allowed.maxRiskPct}%</dd></div>
        <div className="flex justify-between col-span-2 border-t border-slate-700/60 pt-1.5 mt-1">
          <dt className="text-slate-400">Nuevas entradas disponibles</dt>
          <dd className={allowed.newEntriesAvailable > 0 ? "text-emerald-300" : "text-rose-300"}>{allowed.newEntriesAvailable}</dd>
        </div>
      </dl>
    </div>
  );
}

function PortfolioEditor({ portfolio, onChange }) {
  const set = (patch) => onChange({ ...portfolio, ...patch });
  return (
    <details className="rounded-lg border border-slate-700/60 bg-slate-950/30 p-3">
      <summary className="text-xs font-mono text-slate-400 cursor-pointer">Configurar capital y exposición</summary>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ["Balance $", "accountBalance", "805"],
          ["Expuesto $", "exposedCapital", "180"],
          ["Riesgo/trade %", "maxRiskPerTradePct", "1"],
          ["Riesgo total %", "maxPortfolioRiskPct", "2"],
        ].map(([label, key, hint]) => (
          <label key={key} className="block">
            <span className="text-[10px] text-slate-500 uppercase">{label}</span>
            <input
              type="number"
              value={portfolio[key]}
              onChange={(e) => set({ [key]: +e.target.value || 0 })}
              className="mt-0.5 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1 font-mono text-xs text-slate-100"
              placeholder={hint}
            />
          </label>
        ))}
      </div>
    </details>
  );
}

function PositionsEditor({ portfolio, onChange }) {
  const add = () => {
    onChange({
      ...portfolio,
      positions: [...portfolio.positions, {
        id: Date.now().toString(),
        asset: "BTC",
        type: "swing",
        riskUsd: portfolio.accountBalance * portfolio.maxRiskPerTradePct / 100,
      }],
    });
  };
  const remove = (id) => onChange({ ...portfolio, positions: portfolio.positions.filter((p) => p.id !== id) });
  const update = (id, patch) => {
    onChange({
      ...portfolio,
      positions: portfolio.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-slate-400">Posiciones abiertas (manual)</span>
        <button type="button" onClick={add} className="flex items-center gap-1 text-[10px] font-mono text-sky-400 hover:text-sky-300">
          <Plus size={12} /> Añadir
        </button>
      </div>
      {portfolio.positions.length === 0 ? (
        <p className="text-[11px] text-slate-500">Sin posiciones registradas — veredicto favorece NO_TRADE/SWING.</p>
      ) : (
        <div className="space-y-2">
          {portfolio.positions.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-slate-700 bg-slate-900/60 p-2">
              <select value={p.asset} onChange={(e) => update(p.id, { asset: e.target.value })}
                className="rounded bg-slate-950 border border-slate-700 px-1.5 py-0.5 text-xs font-mono">
                <option value="BTC">BTC</option><option value="ETH">ETH</option>
              </select>
              <select value={p.type} onChange={(e) => update(p.id, { type: e.target.value })}
                className="rounded bg-slate-950 border border-slate-700 px-1.5 py-0.5 text-xs font-mono">
                <option value="swing">swing</option><option value="position">position</option>
              </select>
              <label className="text-[10px] text-slate-500">Riesgo $
                <input type="number" value={p.riskUsd} onChange={(e) => update(p.id, { riskUsd: +e.target.value || 0 })}
                  className="ml-1 w-16 rounded bg-slate-950 border border-slate-700 px-1 py-0.5 text-xs font-mono" />
              </label>
              <button type="button" onClick={() => remove(p.id)} className="text-rose-400 hover:text-rose-300 ml-auto">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DailyJournalPanel({ entry, onNotesChange, history }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <BookOpen size={14} className="text-slate-400" />
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300">Bitácora diaria</h3>
      </div>
      {entry && (
        <div className="rounded-md border border-slate-700 bg-slate-900/60 p-2.5 mb-3">
          <div className="font-mono text-xs text-slate-300 mb-2">
            {new Date(entry.date + "T12:00:00").toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" })}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] mb-2">
            <div><span className="text-slate-500">Fase</span> <span className="text-violet-300">{entry.marketPhase}</span></div>
            <div><span className="text-slate-500">Sesgo</span> <span className="text-slate-200">{entry.bias}</span></div>
            <div><span className="text-slate-500">Decisión</span> <span className="text-slate-200">{entry.decision}</span></div>
            <div><span className="text-slate-500">Trades perm.</span> <span className="text-slate-200">{entry.allowedTrades}</span></div>
          </dl>
          <textarea
            value={entry.notes}
            onChange={(e) => onNotesChange(e.target.value)}
            rows={2}
            placeholder="Notas: ej. Esperar CHoCH H4…"
            className="w-full rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-slate-300 font-mono resize-none"
          />
        </div>
      )}
      {history.length > 1 && (
        <details>
          <summary className="text-[10px] font-mono text-slate-500 cursor-pointer">Historial ({history.length - 1} días)</summary>
          <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
            {history.slice(1, 8).map((h) => (
              <li key={h.date} className="text-[10px] font-mono text-slate-500">
                {h.date} · {h.decision} · {h.allowedTrades} trades
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Risk Operating System — no ejecuta órdenes, solo gestiona decisiones.
 */
export default function RiskPortfolioManager({
  btc, eth, fg, etf, derivs, onchain, daily, macro: macroProp,
  btcCfg, ethCfg, btcChange, ethChange,
}) {
  const [portfolio, setPortfolio] = useState(loadPortfolio);
  const [journal, setJournal] = useState(loadJournal);
  const [notes, setNotes] = useState("");
  const macroFetched = useMacroMarkets();
  const macro = macroProp ?? macroFetched;
  const structure = useBtcStructure(btcCfg);

  const persistPortfolio = useCallback((next) => {
    setPortfolio(next);
    savePortfolio(next);
  }, []);

  const ros = useMemo(() => {
    const riskMetrics = computeRiskMetrics(portfolio);
    const exposure = computeExposure(portfolio);
    const ctx = {
      btc, eth, fg, onchain, etf, derivs, daily, macro, structure,
      btcCfg, ethCfg, btcChange, ethChange, exposure,
    };
    const marketPhase = classifyMarketPhase(ctx);
    const macroBullish =
      (macro?.sp500?.changePct ?? 0) > 0 &&
      (macro?.dxy?.changePct ?? 0) <= 0.3 &&
      (etf?.btc?.total ?? 0) >= 0;
    const hasClearAsymmetry =
      structure?.choch4h &&
      (structure?.liquiditySweep || structure?.htfBullish) &&
      (macroBullish || marketPhase.phase !== "MANIPULATION");

    const decision = runDecisionEngine({
      structure, marketPhase, riskMetrics, exposure, portfolio, macroBullish, hasClearAsymmetry,
    });
    const blockers = computeAntiFomo({ ...ctx, structure });
    const traffic = computeTrafficLight(decision.mode, blockers);
    const allowed = computeAllowedTrades(portfolio, decision.mode, exposure);
    const bias = deriveBias(marketPhase, structure);

    return {
      riskMetrics, exposure, marketPhase, decision, blockers, traffic, allowed, bias,
      macroBullish, hasClearAsymmetry,
    };
  }, [portfolio, btc, eth, fg, onchain, etf, derivs, daily, macro, structure, btcCfg, ethCfg, btcChange, ethChange]);

  useEffect(() => {
    const key = todayKey();
    const entry = {
      date: key,
      marketPhase: ros.marketPhase.phaseLabel,
      bias: ros.bias,
      decision: modeLabel(ros.decision.mode),
      allowedTrades: ros.allowed.newEntriesAvailable,
      portfolioRisk: ros.riskMetrics.currentPortfolioRisk,
      notes,
    };
    const prev = loadJournal();
    const idx = prev.findIndex((e) => e.date === key);
    const next = idx >= 0
      ? prev.map((e, i) => (i === idx ? { ...entry, notes: notes || e.notes } : e))
      : [entry, ...prev];
    setJournal(next);
    saveJournal(next);
  }, [ros.marketPhase.phaseLabel, ros.bias, ros.decision.mode, ros.allowed.newEntriesAvailable, ros.riskMetrics.currentPortfolioRisk, notes]);

  useEffect(() => {
    const key = todayKey();
    const today = journal.find((e) => e.date === key);
    if (today?.notes && !notes) setNotes(today.notes);
  }, [journal, notes]);

  const todayEntry = journal.find((e) => e.date === todayKey());

  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-emerald-400" />
          <h2 className="text-sm font-mono tracking-wide text-slate-200">RISK &amp; PORTFOLIO MANAGER</h2>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-slate-600 text-slate-400">
          ROS · no ejecuta órdenes
        </span>
      </div>
      <p className="text-[11px] text-slate-500">
        Motor de decisiones institucional. Prioridad: preservación de capital. Responde: ¿Debo actuar hoy? ¿Cuánto puedo arriesgar?
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <RiskCard metrics={ros.riskMetrics} />
        <ExposureCard exposure={ros.exposure} />
        <MarketPhaseCard marketPhase={ros.marketPhase} />
        <VerdictCard decision={ros.decision} traffic={ros.traffic} />
      </div>

      <DecisionEnginePanel
        inputs={{ structure, macroBullish: ros.macroBullish, hasClearAsymmetry: ros.hasClearAsymmetry, riskMetrics: ros.riskMetrics }}
        outputs={ros.decision}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Ban size={14} className="text-amber-400" />
            <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300">Bloqueador anti-FOMO</h3>
          </div>
          <AntiFomoBlock blockers={ros.blockers} />
        </div>
        <AllowedTradesPanel allowed={ros.allowed} />
      </div>

      <PositionsEditor portfolio={portfolio} onChange={persistPortfolio} />

      <DailyJournalPanel
        entry={todayEntry}
        onNotesChange={setNotes}
        history={journal}
      />

      {(macro?.dxy || macro?.sp500) && (
        <p className="text-[10px] font-mono text-slate-600">
          Macro: DXY {macro.dxy ? macro.dxy.price?.toFixed(2) : "—"} ({macro.dxy?.changePct?.toFixed(2) ?? "—"}%)
          {" · "}SP500 {macro.sp500 ? macro.sp500.price?.toFixed(0) : "—"} ({macro.sp500?.changePct?.toFixed(2) ?? "—"}%)
        </p>
      )}
    </section>
  );
}
