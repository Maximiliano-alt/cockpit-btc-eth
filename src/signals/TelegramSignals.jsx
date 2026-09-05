import React, { useState, useEffect } from "react";
import { Send, ExternalLink } from "lucide-react";

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
            Sin mensajes todavía. Reenvía cualquier publicación de Gem Hunters (o de otro canal) al chat
            privado con tu bot y aparecerá aquí interpretada: activos, sesgo, niveles y tesis.
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
            usa para operar.
          </p>
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
