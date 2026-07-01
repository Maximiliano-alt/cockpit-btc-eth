import React, { useMemo } from "react";
import { Shield, Activity, Gavel } from "lucide-react";
import { classifyMarketPhase, computeDailyVerdict, modeLabel, modeDescription } from "./decisionEngine.js";
import { TRADING_MODE } from "./types.js";

const toneCard = {
  good: "border-emerald-500/40 bg-emerald-500/5",
  warn: "border-amber-500/40 bg-amber-500/5",
  danger: "border-rose-500/40 bg-rose-500/5",
};

const TRAFFIC = {
  [TRADING_MODE.NO_TRADE]: { emoji: "🔴", label: "NO HACER NADA" },
  [TRADING_MODE.SWING]: { emoji: "🟡", label: "GESTIONAR / CONDICIONADO" },
  [TRADING_MODE.POSITION]: { emoji: "🟢", label: "ACTUAR (con filtro)" },
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

function VerdictCard({ decision }) {
  const modeColors = {
    [TRADING_MODE.NO_TRADE]: "text-rose-300 border-rose-500/40 bg-rose-500/10",
    [TRADING_MODE.SWING]: "text-sky-300 border-sky-500/40 bg-sky-500/10",
    [TRADING_MODE.POSITION]: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
  };
  const traffic = TRAFFIC[decision.mode] || TRAFFIC[TRADING_MODE.NO_TRADE];
  const tf = decision.timeframes || {};
  const rows = [
    ["4H (CHoCH/BOS)", tf.h4],
    ["Semanal", tf.weekly],
    ["Mensual", tf.monthly],
    ["Macro", tf.macro],
  ];
  return (
    <RosCard title="Veredicto de hoy" icon={Gavel}>
      <div className={`rounded-md border px-2.5 py-2 font-mono text-sm font-bold ${modeColors[decision.mode] || ""}`}>
        {modeLabel(decision.mode)}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">{modeDescription(decision.mode)}</p>
      <p className="mt-1 text-[10px] text-slate-500">{decision.rationale}</p>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px]">
        {rows.map(([label, ok]) => (
          <div key={label} className="flex justify-between gap-2">
            <span className="text-slate-500">{label}</span>
            <span className={ok ? "text-emerald-400" : "text-rose-400"}>{ok ? "✓" : "✗"}</span>
          </div>
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
 * día según todas las temporalidades (4H, semanal, mensual, macro).
 */
export default function RiskPortfolioManager({
  btc, eth, fg, etf, derivs, onchain, daily, macro, structure,
  btcCfg, ethCfg, btcChange, ethChange,
}) {
  const ros = useMemo(() => {
    const ctx = {
      btc, eth, fg, onchain, etf, derivs, daily, macro, structure,
      btcCfg, ethCfg, btcChange, ethChange,
    };
    const marketPhase = classifyMarketPhase(ctx);
    const macroBullish =
      (macro?.sp500?.changePct ?? 0) > 0 &&
      (macro?.dxy?.changePct ?? 0) <= 0.3 &&
      (etf?.btc?.total ?? 0) >= 0;
    const decision = computeDailyVerdict({ structure, marketPhase, macroBullish });
    return { marketPhase, decision };
  }, [btc, eth, fg, onchain, etf, derivs, daily, macro, structure, btcCfg, ethCfg, btcChange, ethChange]);

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
        Estado del mercado y veredicto del día, derivados de todas las temporalidades (4H, semanal, mensual) y el contexto macro.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <MarketPhaseCard marketPhase={ros.marketPhase} />
        <VerdictCard decision={ros.decision} />
      </div>
    </section>
  );
}
