import React, { useMemo } from "react";
import { Shield, Activity, Gavel } from "lucide-react";
import {
  classifyMarketPhase, computeDailyVerdict, modeLabel, modeDescription,
} from "./decisionEngine.js";
import { TRADING_MODE } from "./types.js";

const TRAFFIC = {
  [TRADING_MODE.NO_TRADE]: { emoji: "🔴", label: "NO HACER NADA" },
  [TRADING_MODE.WAIT_TRIGGER]: { emoji: "🟠", label: "VIGILAR — FALTA GATILLO" },
  [TRADING_MODE.SWING]: { emoji: "🟡", label: "OPERABLE — CONDICIONADO" },
  [TRADING_MODE.POSITION]: { emoji: "🟢", label: "ACTUAR" },
};

const MODE_COLORS = {
  [TRADING_MODE.NO_TRADE]: "text-rose-300 border-rose-500/40 bg-rose-500/10",
  [TRADING_MODE.WAIT_TRIGGER]: "text-amber-200 border-amber-500/40 bg-amber-500/10",
  [TRADING_MODE.SWING]: "text-sky-300 border-sky-500/40 bg-sky-500/10",
  [TRADING_MODE.POSITION]: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
};

function RosCard({ title, icon: Icon, children }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        {Icon && <Icon size={14} className="text-slate-400" />}
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">{title}</h3>
      </div>
      {children}
    </div>
  );
}

const scoreColor = (s) =>
  s >= 45 ? "text-emerald-300" : s >= 15 ? "text-emerald-400/80"
  : s <= -45 ? "text-rose-300" : s <= -15 ? "text-rose-400/80" : "text-slate-400";

// Barra divergente centrada en 0: se ve de un vistazo hacia dónde carga el peso.
function ScoreBar({ score }) {
  const pct = Math.min(50, Math.abs(score) / 2);
  return (
    <div className="relative h-1.5 flex-1 rounded-full bg-slate-800 overflow-hidden min-w-[60px]">
      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
      <div
        className={`absolute inset-y-0 ${score >= 0 ? "bg-emerald-400/70" : "bg-rose-400/70"}`}
        style={score >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
    </div>
  );
}

function TimeframeRow({ label, tf }) {
  if (!tf) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span className="text-slate-500 w-16 shrink-0">{label}</span>
      <ScoreBar score={tf.score} />
      <span className={`w-9 text-right shrink-0 ${scoreColor(tf.score)}`}>
        {tf.score >= 0 ? "+" : ""}{tf.score}
      </span>
      <span className="text-slate-500 w-24 shrink-0 text-right hidden sm:inline">{tf.label}</span>
    </div>
  );
}

function MarketPhaseCard({ marketPhase }) {
  const { bias, valuation } = marketPhase;
  return (
    <RosCard title="Estado del mercado" icon={Activity}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-sm font-bold text-violet-300">{marketPhase.phaseLabel}</span>
        <span className="font-mono text-[10px] text-slate-500">
          valuación <span className={scoreColor(valuation.score)}>
            {valuation.score >= 0 ? "+" : ""}{valuation.score}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2 font-mono text-[11px] mb-2 pb-2 border-b border-slate-700/60">
        <span className="text-slate-500 w-16 shrink-0">Compuesto</span>
        <ScoreBar score={bias.score} />
        <span className={`w-9 text-right shrink-0 font-bold ${scoreColor(bias.score)}`}>
          {bias.score >= 0 ? "+" : ""}{bias.score}
        </span>
        <span className="text-slate-500 w-24 shrink-0 text-right hidden sm:inline">{bias.alignment}% alineado</span>
      </div>
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

function VerdictCard({ decision, timeframes, triggers }) {
  const traffic = TRAFFIC[decision.mode] || TRAFFIC[TRADING_MODE.NO_TRADE];
  const trg = [
    ["CHoCH 4H", triggers?.choch],
    ["BOS 4H", triggers?.bos],
    ["Barrido liq.", triggers?.liquiditySweep],
  ];
  return (
    <RosCard title="Veredicto de hoy" icon={Gavel}>
      <div className={`rounded-md border px-2.5 py-2 font-mono text-sm font-bold ${MODE_COLORS[decision.mode] || ""}`}>
        {modeLabel(decision.mode)}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">{modeDescription(decision.mode)}</p>
      <p className="mt-1 text-[10px] text-slate-500">{decision.rationale}</p>

      <div className="mt-3 space-y-1.5 border-t border-slate-700/60 pt-2">
        <TimeframeRow label="4H" tf={timeframes?.h4} />
        <TimeframeRow label="Diario" tf={timeframes?.d1} />
        <TimeframeRow label="Semanal" tf={timeframes?.w1} />
        <TimeframeRow label="Mensual" tf={timeframes?.mn} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] border-t border-slate-700/60 pt-2">
        {trg.map(([k, v]) => (
          <span key={k} className="text-slate-500">
            {k} <span className={v ? "text-emerald-400" : "text-slate-600"}>{v ? "✓" : "✗"}</span>
          </span>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-md border border-slate-700/60 bg-slate-900/60 px-2.5 py-2">
        <span className="text-lg">{traffic.emoji}</span>
        <span className="font-mono text-xs text-slate-300">{traffic.label}</span>
      </div>
    </RosCard>
  );
}

/**
 * Risk Operating System — solo lectura: estado del mercado y veredicto del
 * día a partir del sesgo graduado de todas las temporalidades.
 */
export default function RiskPortfolioManager({
  fg, etf, derivs, onchain, daily, macro, timeframes, triggers, btcCfg,
}) {
  const ros = useMemo(() => {
    const marketPhase = classifyMarketPhase({ fg, onchain, etf, derivs, daily, timeframes });
    const macroBullish =
      (macro?.sp500?.changePct ?? 0) > 0 &&
      (macro?.dxy?.changePct ?? 0) <= 0.3 &&
      (etf?.btc?.total ?? 0) >= 0;
    const decision = computeDailyVerdict({
      timeframes, triggers, marketPhase, macroBullish,
      hasZones: !!(btcCfg?.poi && btcCfg?.invalidation != null),
    });
    return { marketPhase, decision };
  }, [fg, onchain, etf, derivs, daily, macro, timeframes, triggers, btcCfg]);

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
        Sesgo graduado (−100 a +100) por temporalidad, ponderado en un compuesto. El veredicto se mueve con el mercado, no con banderas fijas.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <MarketPhaseCard marketPhase={ros.marketPhase} />
        <VerdictCard decision={ros.decision} timeframes={timeframes} triggers={triggers} />
      </div>
    </section>
  );
}
