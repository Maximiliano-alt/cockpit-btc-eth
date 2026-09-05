import React, { useState, useEffect } from "react";
import { Send, ExternalLink, GitCompare, Plus } from "lucide-react";

const SESGO = {
  alcista: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  bajista: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  neutral: "border-slate-600 text-slate-400",
};

const hace = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.floor(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
};

export default function TelegramSignals() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [saving, setSaving] = useState(null);
  const [added, setAdded] = useState(null);

  // Convierte la lectura del canal en una idea del registro, con su
  // invalidación y caducidad. Se usa el soporte más alto como entrada y el
  // siguiente (o la invalidación que da el propio canal) como stop.
  const addToRegistry = async (sym, v) => {
    setSaving(sym);
    try {
      const sop = [...(v.canal.soportes || [])].sort((a, b) => b - a);
      const res = [...(v.canal.resistencias || [])].sort((a, b) => a - b);
      const entry = sop[0];
      const stop = v.canal.invalidacion && v.canal.invalidacion < entry
        ? v.canal.invalidacion : (sop[1] ?? null);
      const r = await fetch("/.netlify/functions/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          position: {
            symbol: sym, side: "long", entry, stop, target: res[0] ?? null,
            validDays: 14, source: "telegram",
            note: `Canal: ${v.canal.tesis?.slice(0, 140) || "sin tesis"}`,
          },
        }),
      });
      const j = await r.json();
      setAdded(j.ok ? `${sym} añadido al registro con entrada ${entry?.toLocaleString()} e invalidación ${stop?.toLocaleString() ?? "—"}.` : (j.error || "no se pudo añadir"));
    } catch (e) { setAdded(String(e.message || e)); }
    finally { setSaving(null); }
  };

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/.netlify/functions/signals");
        const j = await res.json();
        if (live) setData(j);
      } catch { /* sin señales */ }
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const msgs = data?.messages || [];

  return (
    <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Send size={15} className="text-sky-400" />
        <h2 className="text-sm font-mono tracking-wide text-slate-200">SEÑALES REENVIADAS — Telegram</h2>
        {data?.model && (
          <span className="ml-auto text-[9px] font-mono text-slate-500">{data.model}</span>
        )}
      </div>

      {msgs.length === 0 ? (
        <div className="text-[11px] text-slate-500 space-y-1.5">
          <p>
            Sin mensajes todavía. Hay dos formas de que lleguen:
          </p>
          <p>
            <b className="text-slate-400">Automática</b> — solo para canales <b>públicos</b>: se configuran en
            <span className="font-mono"> TELEGRAM_PUBLIC_CHANNELS</span> y el cockpit los lee solo cada 30 min.
          </p>
          <p>
            <b className="text-slate-400">Manual</b> — para canales <b>privados</b> (como las comunidades de pago,
            que no tienen vista web): reenvías la publicación al chat con tu bot y aparece aquí.
          </p>
          {data && !data.configured && (
            <p className="text-amber-300">
              Falta configurar <b>TELEGRAM_WEBHOOK_SECRET</b> y <b>TELEGRAM_CHAT_ID</b> en Netlify, y registrar
              el webhook del bot.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="text-[10px] text-slate-600">
            Contenido de terceros, resumido por IA. Es contexto para tu criterio — el bot de ejecución no lo
            usa para operar. Los canales públicos entran solos; los privados, reenviándolos al bot.
          </p>
          {data.cruce?.activos && Object.keys(data.cruce.activos).length > 0 && (
            <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <GitCompare size={13} className="text-violet-400" />
                <h3 className="text-[10px] font-mono uppercase tracking-wider text-violet-300">
                  Cruce con el análisis del cockpit
                </h3>
              </div>
              {Object.entries(data.cruce.activos).map(([sym, v]) => (
                <div key={sym} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-bold text-slate-200 w-9">{sym}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                      v.veredicto.nivel === "confirma" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : v.veredicto.nivel === "parcial" ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
                      {v.veredicto.nivel.toUpperCase()}
                    </span>
                    <span className="text-[10px] text-slate-400 flex-1 min-w-[180px]">{v.veredicto.texto}</span>
                    <button
                      type="button"
                      onClick={() => addToRegistry(sym, v)}
                      disabled={saving === sym || !v.canal.soportes?.length}
                      className="inline-flex items-center gap-1 rounded border border-slate-600 px-1.5 py-0.5 text-[10px] font-mono text-slate-300 hover:bg-slate-800 disabled:opacity-40 shrink-0"
                    >
                      <Plus size={10} /> {saving === sym ? "…" : "al registro"}
                    </button>
                  </div>
                  {v.coincidencias.map((m, i) => (
                    <div key={i} className="font-mono text-[10px] text-slate-500 pl-11">
                      {m.tipo} <span className="text-slate-300">{m.nivelCanal.toLocaleString()}</span> ≈ {m.zonaCockpit}
                    </div>
                  ))}
                  {v.invalidacion && (
                    <div className={`text-[10px] pl-11 ${Math.abs(v.invalidacion.difPct) >= 2 ? "text-amber-300" : "text-slate-500"}`}>
                      {v.invalidacion.nota}
                    </div>
                  )}
                </div>
              ))}
              <p className="text-[9px] text-slate-600 leading-snug">{data.cruce.nota}</p>
              {added && <p className="text-[10px] text-emerald-300">{added}</p>}
            </div>
          )}

          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {msgs.map((m) => {
              const r = data.readings?.[m.id];
              const abierto = open === m.id;
              return (
                <div key={m.id} className="rounded-md border border-slate-700 bg-slate-950/40 px-2.5 py-2">
                  <div
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 cursor-pointer"
                    onClick={() => setOpen(abierto ? null : m.id)}
                  >
                    <span className="text-slate-600 text-[10px]">{abierto ? "▾" : "▸"}</span>
                    {r?.activos?.length > 0 && (
                      <span className="font-mono text-[11px] font-bold text-slate-200">{r.activos.join(" · ")}</span>
                    )}
                    {r?.sesgo && (
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${SESGO[r.sesgo]}`}>
                        {r.sesgo.toUpperCase()}
                      </span>
                    )}
                    {r?.accionable && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300">
                        CON NIVELES
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 truncate flex-1 min-w-[140px]">
                      {r?.tesis || m.text.slice(0, 90)}
                    </span>
                    <span className="text-[9px] font-mono text-slate-600 shrink-0">{hace(m.at)}</span>
                  </div>

                  {abierto && (
                    <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-1.5">
                      {r?.niveles && (
                        <p className="font-mono text-[11px] text-slate-300">
                          <span className="text-slate-500">Niveles · </span>{r.niveles}
                        </p>
                      )}
                      {r?.tesis && <p className="text-[11px] text-slate-300">{r.tesis}</p>}
                      <details>
                        <summary className="text-[10px] text-slate-500 cursor-pointer">Mensaje original · {m.origen}</summary>
                        <p className="mt-1 text-[10px] text-slate-500 whitespace-pre-wrap leading-snug">{m.text}</p>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <a href="https://gemhunters.co" target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300">
        Gem Hunters <ExternalLink size={10} />
      </a>
    </section>
  );
}
