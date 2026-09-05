// Ingesta automática de canales PÚBLICOS de Telegram (lógica compartida).
//
// Vive en _lib porque las functions programadas de Netlify no se pueden
// invocar por HTTP (devuelven 403), así que no habría manera de probarlas ni
// de forzar un sondeo desde la interfaz. Con la lógica aquí, la llaman tanto
// el cron como el endpoint de señales con ?poll=1.
//
// Telegram publica los canales públicos como página web en t.me/s/<handle>.
// Leerla no requiere bot, ni cuenta, ni userbot, y no infringe nada: es una
// página pública que sirve el propio Telegram. Así, para canales públicos, los
// mensajes llegan solos al cockpit sin que tengas que reenviar nada.
//
// Los canales PRIVADOS (comunidades de pago, por ejemplo) no tienen esa vista,
// y ahí el reenvío manual al bot sigue siendo la única vía limpia.
//
// Configuración: TELEGRAM_PUBLIC_CHANNELS="handle1,handle2" en Netlify.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "signals", consistency: "strong" });
const KEY = "telegram";
const MAX = 60;

function parseChannel(html, handle) {
  // El título real permite avisar si el handle no es el canal que se espera.
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] || handle;

  const out = [];
  // Cada mensaje trae su id en data-post="canal/123", que sirve de clave
  // estable para no duplicar entre sondeos.
  const re = /data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, post, raw] = m;
    const text = raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .trim();
    if (!text || text.length < 15) continue;

    // Fecha del propio mensaje si viene en el HTML.
    const around = html.slice(Math.max(0, m.index - 2500), m.index + 2500);
    const dt = around.match(/datetime="([^"]+)"/)?.[1];

    out.push({
      id: `pub-${post}`,
      text: text.slice(0, 4000),
      origen: title.slice(0, 80),
      at: dt ? new Date(dt).getTime() : Date.now(),
      receivedAt: Date.now(),
      publico: true,
      url: `https://t.me/${post}`,
    });
  }
  return out;
}

async function fetchChannel(handle) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://t.me/s/${encodeURIComponent(handle)}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CryptoCockpit/1.0)" },
    });
    // 302 = el canal no es público o no existe.
    if (!res.ok) throw new Error(`${handle}: HTTP ${res.status}${res.status === 302 ? " (no es público)" : ""}`);
    return parseChannel(await res.text(), handle);
  } finally { clearTimeout(timer); }
}

export async function pollPublicChannels() {
  const handles = String(process.env.TELEGRAM_PUBLIC_CHANNELS || "")
    .split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);

  if (!handles.length) {
    return { ok: true, nota: "Sin TELEGRAM_PUBLIC_CHANNELS configurado." };
  }

  let list = [];
  try { list = (await store().get(KEY, { type: "json" })) || []; } catch { /* primera vez */ }
  const known = new Set(list.map((x) => x.id));

  const report = [];
  let nuevos = 0;
  for (const h of handles) {
    try {
      const msgs = await fetchChannel(h);
      const add = msgs.filter((m) => !known.has(m.id));
      add.forEach((m) => known.add(m.id));
      list = [...add, ...list];
      nuevos += add.length;
      report.push({ canal: h, encontrados: msgs.length, nuevos: add.length });
    } catch (e) {
      report.push({ canal: h, error: String(e.message || e).slice(0, 120) });
    }
  }

  if (nuevos) {
    list.sort((a, b) => b.at - a.at);
    await store().setJSON(KEY, list.slice(0, MAX));
  }
  return { ok: true, nuevos, canales: report };
}
