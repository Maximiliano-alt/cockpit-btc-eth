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
  enter: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  exit: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  hold: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "stay-out": "border-slate-600 text-slate-400",
  "close-short": "border-rose-500/40 bg-rose-500/10 text-rose-300",
  "signal-only": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  skip: "border-slate-700 text-slate-500",
  error: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  none: "border-slate-700 text-slate-500",
};
const ACTION_LABEL = {
  enter: "ENTRADA", exit: "SALIDA", hold: "MANTIENE", "stay-out": "EN EFECTIVO",
  "close-short": "CORTO CERRADO", "signal-only": "SEÑAL", skip: "OMITIDO",
  error: "ERROR", none: "SIN SEÑAL",
};

const usd = (n, d = 2) =>
  `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

// Los precios vienen del broker como flotantes crudos (79065.09999999999).
// Se recortan a 2 decimales y se quitan los ceros sobrantes.
const px = (n) =>
  n == null ? "—" : Number(n.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 });

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-2 font-mono text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 text-right">{children}</span>
    </div>
  );
}

/**
 * Historial completo: posiciones abiertas con P&L latente, órdenes pendientes
 * y cierres realizados con el acumulado neto (P&L menos comisiones y funding,
 * que es lo que de verdad queda en la cuenta).
 */
function TradeHistory({ account, liveAt }) {
  const [tab, setTab] = useState("open");
  const h = account.history;
  const open = account.positions || [];
  const pending = account.pending || [];

  const tabs = [
    ["open", `Abiertas (${open.length})`],
    ["pending", `Pendientes (${pending.length})`],
    ["closed", `Cerradas (${h?.count ?? 0})`],
  ];

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Operaciones</h3>
        {liveAt && (
          <span className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            en vivo · {new Date(liveAt).toLocaleTimeString()}
          </span>
        )}
        <div className="flex gap-1 ml-auto">
          {tabs.map(([k, label]) => (
            <button
              key={k} type="button" onClick={() => setTab(k)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded border transition ${
                tab === k ? "border-slate-500 bg-slate-800 text-slate-100"
                          : "border-slate-700 text-slate-500 hover:text-slate-300"}`}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Acumulado: siempre visible, es el número que de verdad importa. */}
      {h && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 pb-3 border-b border-slate-700/60">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">P&L neto ({h.days}d)</div>
            <div className={`font-mono text-base font-bold ${h.net >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
              {usd(h.net)}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Realizado</div>
            <div className={`font-mono text-sm ${h.realized >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{usd(h.realized)}</div>
            <div className="text-[9px] text-slate-600">comis. {usd(h.fees)} · fund. {usd(h.funding)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Aciertos</div>
            <div className="font-mono text-sm text-slate-200">{h.count ? `${h.winRate.toFixed(0)}%` : "—"}</div>
            <div className="text-[9px] text-slate-600">{h.count} cierres</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Mejor / peor</div>
            <div className="font-mono text-[11px] text-emerald-400">{h.count ? usd(h.bestPnl) : "—"}</div>
            <div className="font-mono text-[11px] text-rose-400">{h.count ? usd(h.worstPnl) : "—"}</div>
          </div>
        </div>
      )}
      {account.historyError && (
        <p className="text-[10px] text-amber-300 mb-2">Historial no disponible: {account.historyError}</p>
      )}

      {tab === "open" && (
        open.length === 0
          ? <p className="text-[11px] text-slate-500">Sin posiciones abiertas — el bot está en efectivo.</p>
          : <div className="space-y-1.5">
              {open.map((p) => (
                <div key={p.symbol} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
                  <span className="text-slate-200 font-bold w-20 shrink-0">{p.symbol}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${
                    p.amt > 0 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
                    {p.amt > 0 ? "LARGO" : "CORTO"}
                  </span>
                  <span className="text-slate-400">{Math.abs(p.amt)}</span>
                  <span className="text-slate-500">entrada {px(p.entry)}</span>
                  {p.mark != null && <span className="text-slate-500">actual {px(p.mark)}</span>}
                  {p.notional != null && <span className="text-slate-600">${p.notional.toFixed(0)}</span>}
                  <span className="text-slate-600">{p.leverage}×</span>
                  <span className={`ml-auto font-bold ${p.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {usd(p.pnl)}{p.pnlPct != null && <span className="ml-1 opacity-70">({p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(2)}%)</span>}
                  </span>
                </div>
              ))}
            </div>
      )}

      {tab === "pending" && (
        account.pendingError
          ? <p className="text-[11px] text-amber-300">{account.pendingError}</p>
          : pending.length === 0
            ? <p className="text-[11px] text-slate-500">Sin órdenes pendientes. Esta estrategia entra y sale a mercado, así que normalmente no deja órdenes en espera.</p>
            : <div className="space-y-1.5">
                {pending.map((o) => (
                  <div key={o.id} className="flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
                    <span className="text-slate-200 font-bold w-20 shrink-0">{o.symbol}</span>
                    <span className={o.side === "BUY" ? "text-emerald-400" : "text-rose-400"}>{o.side}</span>
                    <span className="text-slate-400">{o.type}</span>
                    <span className="text-slate-500">{o.qty || "cierre total"}</span>
                    {o.stopPrice > 0 && <span className="text-slate-500">disparo {px(o.stopPrice)}</span>}
                    {o.price > 0 && <span className="text-slate-500">precio {px(o.price)}</span>}
                    {o.reduceOnly && <span className="text-[9px] px-1 rounded border border-slate-600 text-slate-400">solo reduce</span>}
                    <span className="ml-auto text-slate-600">{new Date(o.at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
      )}

      {tab === "closed" && (
        !h || !h.trades?.length
          ? <p className="text-[11px] text-slate-500">Sin operaciones cerradas todavía en los últimos {h?.days ?? 90} días.</p>
          : <div className="space-y-1 max-h-64 overflow-y-auto">
              {h.trades.map((t, i) => (
                <div key={i} className="flex items-center gap-x-3 font-mono text-[11px] border-b border-slate-800/60 pb-1">
                  <span className="text-slate-200 font-bold w-20 shrink-0">{t.symbol}</span>
                  <span className="text-slate-600">{new Date(t.at).toLocaleString()}</span>
                  <span className={`ml-auto font-bold ${t.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {usd(t.pnl)}
                  </span>
                </div>
              ))}
            </div>
      )}
    </div>
  );
}

function ConfigPanel({ config, onSave, busy, catalog }) {
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
      <div className="mt-3">
        <span className="text-[10px] text-slate-500 uppercase">Activos que opera</span>
        <div className="mt-1.5 space-y-1.5">
          {(catalog || []).map((s) => {
            const on = (c.symbols || []).includes(s.symbol);
            return (
              <label key={s.symbol} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={on}
                  onChange={(e) => setC({
                    ...c,
                    symbols: e.target.checked
                      ? [...(c.symbols || []), s.symbol]
                      : (c.symbols || []).filter((x) => x !== s.symbol),
                  })}
                  className="mt-0.5 accent-sky-500 shrink-0"
                />
                <span className="min-w-0">
                  <span className="font-mono text-[11px] text-slate-200">{s.label}</span>
                  <span className={`ml-2 text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                    s.validated
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
                    {s.validated ? "VALIDADO" : "NO VALIDADO"}
                  </span>
                  <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">{s.note}</span>
                </span>
              </label>
            );
          })}
        </div>
        {(c.symbols || []).length === 0 && (
          <p className="mt-1.5 text-[10px] text-amber-300">Sin activos seleccionados se restauran BTC y ETH al guardar.</p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
        {field("maPeriod", "Media (días)", "50 fue la que mejor superó la prueba de 7 años")}
        {field("allocationPct", "Capital asignado %", "% del capital repartido entre los símbolos")}
        {field("trailPct", "Trailing stop %", "0 lo desactiva · mide la caída desde el máximo de la posición")}
        {field("dailyLossLimitPct", "Límite pérdida diaria %")}
      </div>
      <p className="mt-3 text-[10px] text-slate-500 leading-relaxed">
        No hay ajustes de cortos ni de apalancamiento a propósito: en la prueba sobre 7 años las versiones
        largo/corto perdían dinero (MA200 largo/corto: −1%/año fuera de muestra) y el apalancamiento
        convierte una caída normal del 50% en liquidación. La estrategia solo está <b>dentro</b> o <b>en efectivo</b>.
      </p>
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

  // Latido en vivo: refresca capital, posiciones y P&L cada 8 s con la
  // consulta ligera, sin recargar el historial completo (que es lento y no
  // cambia entre latidos).
  useEffect(() => {
    let alive = true;
    const beat = async () => {
      try {
        const res = await fetch("/.netlify/functions/bot-control?live=1");
        const t = await res.text();
        const j = JSON.parse(t);
        if (!alive || !j?.connected) return;
        setState((prev) => prev?.config ? {
          ...prev,
          liveAt: j.at,
          account: { ...prev.account, equity: j.equity, available: j.available, positions: j.positions },
        } : prev);
      } catch { /* un latido perdido no rompe nada */ }
    };
    const t = setInterval(beat, 8000);
    return () => { alive = false; clearInterval(t); };
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
            {config.mode === "demo" ? "CUENTA DEMO" : "CUENTA REAL"}
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
              {account.host && (
                <div className="text-[9px] font-mono text-slate-600 pt-1">{account.host.replace("https://", "")}</div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[11px] text-rose-300">Sin conexión: {account.reason}</p>
              {/^Binance 401|Invalid API|API-key/i.test(account.reason || "") && (
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Las claves deben crearse en <b>testnet.binancefuture.com</b>. Las de
                  demo.binance.com no sirven aquí: ese host bloquea las IPs de Netlify (error 451).
                </p>
              )}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">Estrategia</h3>
          <div className="space-y-1">
            <Row label="Señal">MA {config.maPeriod} diaria</Row>
            <Row label="Posición">Largo / efectivo</Row>
            <Row label="Trailing">{config.trailPct > 0 ? `${config.trailPct}%` : "desactivado"}</Row>
            <Row label="Apalancamiento">1× (ninguno)</Row>
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
          <p className="mt-2 text-[10px] text-slate-600">Revisa solo cada hora. La señal usa cierres diarios, así que solo puede cambiar una vez al día.</p>
        </div>
      </div>

      {state.signals?.length > 0 && (
        <div className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3">
          <h3 className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-2">
            Señal actual · cierre diario vs MA {config.maPeriod}
          </h3>
          <div className="space-y-1.5">
            {state.signals.map((s) => (
              <div key={s.symbol} className="flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
                <span className="text-slate-200 font-bold w-20 shrink-0">{s.symbol}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 ${
                  s.target === 1 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                 : "border-slate-600 text-slate-400"}`}>
                  {s.target === 1 ? "DENTRO" : "EFECTIVO"}
                </span>
                {s.distPct != null && (
                  <span className={s.distPct >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {s.distPct >= 0 ? "+" : ""}{s.distPct.toFixed(1)}% vs media
                  </span>
                )}
                <span className="text-slate-500 flex-1 min-w-[180px] truncate">{s.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {account.connected && (
        <TradeHistory account={account} liveAt={state.liveAt} />
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
                {(d.action === "enter" || d.action === "exit") && d.qty != null && (
                  <span className="font-mono text-[10px] text-slate-500">
                    {Math.abs(d.qty)}{d.price ? ` @ ${px(d.price)}` : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfigPanel config={config} busy={busy} catalog={state.catalog} onSave={(c) => act({ action: "config", config: c })} />

      <p className="text-[10px] text-slate-600 leading-relaxed">
        Estrategia de asignación de tendencia: mientras el cierre diario supere su media de {config.maPeriod} días
        mantiene la posición; cuando la pierde, sale a efectivo. Sin cortos, sin apalancamiento y sin stops
        intradía — es lo único que superó la prueba sobre 7 años en BTC y ETH a la vez (peor tramo +26%/año).
        Aun así, esa misma prueba tuvo caídas del 59%: espera ver la cuenta a la mitad en algún momento.
        Rentabilidad pasada no garantiza la futura; esto es una herramienta tuya, no una recomendación de inversión.
      </p>
    </section>
  );
}
