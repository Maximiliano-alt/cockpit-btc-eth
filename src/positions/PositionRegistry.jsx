import React, { useState, useEffect, useCallback } from "react";
import { ClipboardList, Plus, Trash2, CheckCircle2 } from "lucide-react";

// Estados que devuelve el servidor, con su lectura visual.
const ESTADO = {
  pendiente:  { label: "PENDIENTE",  cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  activa:     { label: "ACTIVA",     cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  invalidada: { label: "INVALIDADA", cls: "border-rose-500/40 bg-rose-500/10 text-rose-300" },
  caducada:   { label: "CADUCADA",   cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  objetivo:   { label: "OBJETIVO",   cls: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  cerrada:    { label: "CERRADA",    cls: "border-slate-600 text-slate-400" },
};

const EMPTY = { symbol: "BTC", side: "long", entry: "", stop: "", target: "", riskUsd: "", validDays: 14, note: "" };

async function api(body) {
  const res = await fetch("/.netlify/functions/positions", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j;
  try { j = JSON.parse(t); } catch { throw new Error("Registro no disponible aquí (functions no activas)."); }
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export default function PositionRegistry({ playbook }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api()); setErr(null); }
    catch (e) { setErr(String(e.message || e)); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const act = async (body) => {
    setBusy(true);
    try { await api(body); await load(); setErr(null); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!form.entry) { setErr("Falta el precio de entrada."); return; }
    await act({ action: "add", position: form });
    setForm(EMPTY); setAdding(false);
  };

  // Precarga desde una idea del playbook: convierte el escenario de la IA en
  // una entrada del registro sin retipear los niveles.
  const fromPlaybook = (idea) => {
    const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.]/g, "")); return isFinite(n) ? n : ""; };
    setForm({
      ...EMPTY, symbol: idea.asset, entry: num(idea.entry),
      stop: num(idea.stop), target: num(idea.target),
      note: idea.cond?.slice(0, 200) || "", source: "playbook",
    });
    setAdding(true);
  };

  const r = data?.resumen;
  const positions = data?.positions || [];
  const porCancelar = positions.filter((p) => ["invalidada", "caducada"].includes(p.estado));

  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-slate-300" />
          <h2 className="text-sm font-mono tracking-wide text-slate-200">REGISTRO DE POSICIONES — Exness</h2>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setAdding((a) => !a)} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] font-mono text-slate-200 hover:bg-slate-800 disabled:opacity-40">
            <Plus size={12} /> Añadir
          </button>
          {porCancelar.length > 0 && (
            <button type="button" onClick={() => act({ action: "purge" })} disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 px-2.5 py-1 text-[11px] font-mono text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">
              Limpiar {porCancelar.length}
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Exness no tiene API pública, así que el cockpit no puede cancelar tus órdenes — pero sí decirte cuáles
        ya no valen. Apunta aquí cada idea con su invalidación y su plazo, y el registro las contrasta con el
        precio en vivo.
      </p>

      {err && <p className="text-[11px] text-rose-300">{err}</p>}

      {r && (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-slate-700 bg-slate-950/40 px-2.5 py-2">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Vigentes</div>
            <div className="font-mono text-base font-bold text-emerald-300">{r.vivas}</div>
          </div>
          <div className={`rounded-md border px-2.5 py-2 ${r.porCancelar ? "border-amber-500/40 bg-amber-500/10" : "border-slate-700 bg-slate-950/40"}`}>
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Por cancelar</div>
            <div className={`font-mono text-base font-bold ${r.porCancelar ? "text-amber-300" : "text-slate-400"}`}>{r.porCancelar}</div>
          </div>
          <div className="rounded-md border border-slate-700 bg-slate-950/40 px-2.5 py-2">
            <div className="text-[9px] uppercase tracking-wider text-slate-500">Riesgo comprometido</div>
            <div className="font-mono text-base font-bold text-slate-200">${(r.capitalComprometido || 0).toFixed(0)}</div>
          </div>
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className="block">
              <span className="text-[10px] text-slate-500 uppercase">Activo</span>
              <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                className="mt-0.5 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 font-mono text-xs text-slate-100">
                <option>BTC</option><option>ETH</option><option>SOL</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] text-slate-500 uppercase">Dirección</span>
              <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}
                className="mt-0.5 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 font-mono text-xs text-slate-100">
                <option value="long">Largo</option><option value="short">Corto</option>
              </select>
            </label>
            {[["entry", "Entrada"], ["stop", "Invalidación"], ["target", "Objetivo"], ["riskUsd", "Riesgo $"], ["validDays", "Vigencia (días)"]].map(([k, label]) => (
              <label key={k} className="block">
                <span className="text-[10px] text-slate-500 uppercase">{label}</span>
                <input type="number" step="any" value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value === "" ? "" : +e.target.value })}
                  className="mt-0.5 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 font-mono text-xs text-slate-100" />
              </label>
            ))}
          </div>
          <input placeholder="Nota: condición que debe cumplirse" value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            className="w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-100" />
          <button type="button" onClick={submit} disabled={busy}
            className="rounded-md border border-emerald-500/50 px-3 py-1 text-[11px] font-mono text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
            Guardar idea
          </button>
        </div>
      )}

      {playbook?.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-slate-500">Desde el playbook:</span>
          {playbook.flatMap((h) => h.ideas.map((i, n) => (
            <button key={`${h.horizon}-${n}`} type="button" onClick={() => fromPlaybook(i)}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 hover:text-slate-200 hover:border-slate-500">
              {h.horizon.slice(0, 3)} · {i.asset} {i.entry}
            </button>
          )))}
        </div>
      )}

      {positions.length === 0 ? (
        <p className="text-[11px] text-slate-500">Sin ideas registradas. Añade las órdenes límite que dejes en Exness para no perderles el rastro.</p>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {positions.map((p) => {
            const e = ESTADO[p.estado] || ESTADO.pendiente;
            return (
              <div key={p.id} className={`rounded-md border px-2.5 py-2 ${
                ["invalidada", "caducada"].includes(p.estado) ? "border-amber-500/30 bg-amber-500/5" : "border-slate-700 bg-slate-950/40"}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
                  <span className="text-slate-200 font-bold w-10">{p.symbol}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border ${e.cls}`}>{e.label}</span>
                  <span className="text-slate-500">{p.side === "long" ? "largo" : "corto"}</span>
                  <span className="text-slate-400">entrada {p.entry}</span>
                  {p.stop != null && <span className="text-rose-400/70">inval. {p.stop}</span>}
                  {p.target != null && <span className="text-emerald-400/70">obj. {p.target}</span>}
                  {p.price != null && <span className="text-slate-500">ahora {p.price.toFixed(2)}</span>}
                  <span className="ml-auto flex gap-1.5">
                    {!p.closedAt && (
                      <button type="button" onClick={() => act({ action: "close", id: p.id })} disabled={busy}
                        title="Marcar como cerrada" className="text-slate-500 hover:text-emerald-300">
                        <CheckCircle2 size={13} />
                      </button>
                    )}
                    <button type="button" onClick={() => act({ action: "delete", id: p.id })} disabled={busy}
                      title="Eliminar" className="text-slate-600 hover:text-rose-300">
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                <p className={`mt-1 text-[10px] leading-snug ${
                  ["invalidada", "caducada"].includes(p.estado) ? "text-amber-200/90" : "text-slate-500"}`}>
                  {p.motivo}
                </p>
                {p.note && <p className="mt-0.5 text-[10px] text-slate-600">{p.note}</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
