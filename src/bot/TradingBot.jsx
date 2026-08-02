import React, { useState, useEffect, useCallback } from "react";
import { Bot, Play, Power, PowerOff, RefreshCw, AlertTriangle, XOctagon, Settings } from "lucide-react";

async function api(body) {
  const res = await fetch("/.netlify/functions/bot-control", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Cuidado: en desarrollo local (sin functions) el servidor devuelve el HTML
  // del SPA con estado 200. Sin esta comprobación, `j` quedaba vacío y el
  // panel reventaba al leer config.armed, tumbando todo el cockpit.
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch {
    throw new Error(res.ok ? "El backend del bot no está disponible aquí (functions no activas)." : `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const ACTION_STYLE = {
  executed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "signal-only": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  hold: "border-slate-600 text-slate-400",
  skipped: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  error: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  none: "border-slate-700 text-slate-500",
};
const ACTION_LABEL = {
  executed: "EJECUTADA", "signal-only": "SEÑAL", hold: "EN POSICIÓN",
  skipped: "OMITIDA", error: "ERROR", none: "SIN SEÑAL",
};

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-2 font-mono text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 text-right">{children}</span>
    </div>
  );
}

function ConfigPanel({ config, onSave, busy }) {
  const [c, setC] = useState(config);
  useEffect(() => setC(config), [config]);
  const field = (key, label, hint) => (
    <label key={key} className="block">
      <span className="text-[10px] text-slate-500 uppercase">{label}</span>
      <input
        type="number" step="any" value={c[key]}
        onChange={(e) => setC({ ...c, [key]: e.target.value === "" ? "" : +e.target.value })}
        className="mt-0.5 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 font-mono text-xs text-slate-100"
        title={hint}
      />
    </label>
  );
  return (
    <details className="rounded-lg border border-slate-700/60 bg-slate-950/30 p-3">
      <summary className="flex items-center gap-1.5 text-xs font-mono text-slate-400 cursor-pointer">
        <Settings size={12} /> Parámetros de la estrategia
      </summary>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {field("riskPctPerTrade", "Riesgo/trade %", "% del capital que se pierde si salta el stop")}
        {field("maxLeverage", "Apalancamiento máx.")}
        {field("maxConcurrent", "Posiciones máx.")}
        {field("minRR", "R:R mínimo")}
        {field("minScore", "Sesgo mínimo", "|score| compuesto necesario para operar")}
        {field("minAlignment", "Alineación mín. %")}
        {field("maxChasePct", "Máx. persecución %", "cuánto tolera por encima del POI")}
        {field("dailyLossLimitPct", "Límite pérdida diaria %")}
        {field("cooldownMin", "Enfriamiento (min)")}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
        <input
          type="checkbox" checked={!!c.allowShorts}
          onChange={(e) => setC({ ...c, allowShorts: e.target.checked })}
          className="accent-sky-500"
        />
        Permitir posiciones cortas
      </label>
      <button
        type="button" disabled={busy} onClick={() => onSave(c)}
        className="mt-3 rounded-md border border-slate-600 px-3 py-1 text-[11px] font-mono text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      >
        Guardar parámetros
      </button>
    </details>
  );
}

export default function TradingBot() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await api();
      if (!s?.config) throw new Error("Respuesta inesperada del backend del bot.");
      setState(s);
      setErr(null);
    } catch (e) { setErr(String(e.message || e)); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (body) => {
    setBusy(true);
    try {
      const r = await api(body);
      if (r.summary) setLastRun(r.summary);
      await load();
      setErr(null);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  if (!state?.config) {
    return (
      <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Bot size={16} className="text-sky-400" />
          <h2 className="text-sm font-mono tracking-wide text-slate-200">BOT DE EJECUCIÓN</h2>
        </div>
        <p className="text-xs text-slate-500">{err || "Cargando estado del bot…"}</p>
      </section>
    );
  }

  const { config, account = { connected: false, reason: "sin datos" }, env = {}, log = [] } = state;
  const armed = config.armed;
  const decisions = lastRun?.decisions || log?.[0]?.decisions || [];

  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-sky-400" />
          <h2 className="text-sm font-mono tracking-wide text-slate-200">BOT DE EJECUCIÓN</h2>
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
            config.mode === "demo"
              ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
            {config.mode === "demo" ? "CUENTA DEMO (testnet)" : "CUENTA REAL"}
          </span>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded-full border ${
          armed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-slate-600 text-slate-400"}`}>
          {armed ? <Power size={12} /> : <PowerOff size={12} />}
          {armed ? "ARMADO — puede operar" : "DESARMADO — solo señales"}
        </span>
      </div>

      {!env.enabled && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200">
            <b>BOT_ENABLED</b> no está configurado en Netlify. El bot analiza y registra señales, pero no puede ejecutar
            nada hasta que actives esa variable y cargues las claves de la cuenta demo.
          </div>
        </div>
      )}
      {err && <p className="text-[11px] text-rose-300">{err}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">Cuenta</h3>
          {account.connected ? (
            <div className="space-y-1">
              <Row label="Capital">${account.equity?.toFixed(2)}</Row>
              <Row label="Disponible">${account.available?.toFixed(2)}</Row>
              <Row label="Posiciones">{account.positions?.length ?? 0}</Row>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">Sin conexión: {account.reason}</p>
          )}
        </div>

        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">Riesgo</h3>
          <div className="space-y-1">
            <Row label="Riesgo/trade">{config.riskPctPerTrade}%</Row>
            <Row label="Apalancamiento">{config.maxLeverage}×</Row>
            <Row label="R:R mínimo">{config.minRR}</Row>
            <Row label="Corte diario">−{config.dailyLossLimitPct}%</Row>
          </div>
        </div>

        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">Control</h3>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button" disabled={busy || !env.enabled}
              onClick={() => act({ action: armed ? "disarm" : "arm" })}
              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-mono disabled:opacity-40 ${
                armed ? "border-rose-500/50 text-rose-300 hover:bg-rose-500/10"
                      : "border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10"}`}
            >
              {armed ? <><PowerOff size={12} /> Desarmar</> : <><Power size={12} /> Armar</>}
            </button>
            <button
              type="button" disabled={busy} onClick={() => act({ action: "run" })}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] font-mono text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <Play size={12} /> Evaluar ahora
            </button>
            <button
              type="button" disabled={busy || !account.connected} onClick={() => act({ action: "close-all" })}
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/50 px-2.5 py-1 text-[11px] font-mono text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
            >
              <XOctagon size={12} /> Cerrar todo
            </button>
            <button
              type="button" disabled={busy} onClick={load}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] font-mono text-slate-400 hover:bg-slate-800"
            >
              <RefreshCw size={11} />
            </button>
          </div>
          <p className="mt-2 text-[10px] text-slate-600">Evalúa solo cada 15 min automáticamente.</p>
        </div>
      </div>

      {account.connected && account.positions?.length > 0 && (
        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">Posiciones abiertas</h3>
          <div className="space-y-1">
            {account.positions.map((p) => (
              <div key={p.symbol} className="flex flex-wrap items-center gap-x-4 font-mono text-[11px]">
                <span className="text-slate-200 font-bold w-20">{p.symbol}</span>
                <span className={p.amt > 0 ? "text-emerald-400" : "text-rose-400"}>
                  {p.amt > 0 ? "LONG" : "SHORT"} {Math.abs(p.amt)}
                </span>
                <span className="text-slate-500">entrada {p.entry}</span>
                <span className={`ml-auto font-bold ${p.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {p.pnl >= 0 ? "+" : ""}{p.pnl.toFixed(2)} USDT
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">
          Última evaluación {lastRun ? "(manual)" : log?.[0] ? `· ${new Date(log[0].at).toLocaleTimeString()}` : ""}
        </h3>
        {decisions.length === 0 ? (
          <p className="text-[11px] text-slate-500">Todavía sin evaluaciones registradas. Pulsa “Evaluar ahora”.</p>
        ) : (
          <div className="space-y-1.5">
            {decisions.map((d, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                <span className="font-mono font-bold text-slate-200 w-20 shrink-0">{d.symbol}</span>
                <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${ACTION_STYLE[d.action] || ACTION_STYLE.none}`}>
                  {ACTION_LABEL[d.action] || d.action}
                </span>
                <span className="text-slate-400 flex-1 min-w-[200px]">{d.reason}</span>
                {d.action === "executed" && (
                  <span className="font-mono text-[10px] text-slate-500">
                    {d.qty} @ {d.entryPrice} · SL {d.stopPrice} · TP {d.tpPrice}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfigPanel config={config} busy={busy} onSave={(c) => act({ action: "config", config: c })} />

      <p className="text-[10px] text-slate-600 leading-relaxed">
        El bot aplica reglas fijas sobre las zonas que ya calculó la IA (no llama a la IA en cada ciclo: sería
        impredecible y quemaría la cuota). Ejecuta solo si el sesgo compuesto, la alineación entre temporalidades,
        el gatillo de 4H y el R:R mínimo se cumplen a la vez. Esto es una herramienta tuya, no una recomendación
        de inversión: revisa los resultados en demo antes de considerar dinero real.
      </p>
    </section>
  );
}
