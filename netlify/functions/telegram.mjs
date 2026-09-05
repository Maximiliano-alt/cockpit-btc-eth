// Receptor de mensajes reenviados desde Telegram.
//
// Flujo: reenvías un mensaje de Gem Hunters (o de donde sea) al chat privado
// con tu bot; Telegram lo entrega aquí por webhook; se guarda en bruto. La
// interpretación con IA ocurre en signals.mjs, no aquí, para que la recepción
// sea siempre rápida y nunca dependa de que la IA tenga cuota.
//
// SEGURIDAD. Este endpoint es público, así que:
//  1. Telegram firma cada webhook con un secreto (X-Telegram-Bot-Api-Secret-Token)
//     que fijamos al registrarlo; sin él, se rechaza.
//  2. Solo se aceptan mensajes del chat autorizado (TELEGRAM_CHAT_ID), para
//     que nadie que descubra la URL del bot pueda inyectar contenido.
//  3. El texto recibido es de TERCEROS: se guarda como dato y nunca se
//     interpreta como instrucción, ni alimenta la ejecución del bot.
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "signals", consistency: "strong" });
const KEY = "telegram";
const MAX = 60;

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    // 200 a propósito: si devolviéramos error, Telegram reintentaría en bucle.
    return new Response("ok", { status: 200 });
  }

  let update = {};
  try { update = await req.json(); } catch { return new Response("ok", { status: 200 }); }

  const msg = update.message || update.channel_post || update.edited_message;
  if (!msg) return new Response("ok", { status: 200 });

  const allowed = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (allowed && String(msg.chat?.id) !== allowed) {
    return new Response("ok", { status: 200 });
  }

  const text = (msg.text || msg.caption || "").trim();
  if (!text) return new Response("ok", { status: 200 });

  // Origen: si es un reenvío, Telegram indica de dónde viene.
  const origen = msg.forward_from_chat?.title
    || msg.forward_origin?.chat?.title
    || msg.forward_origin?.sender_user_name
    || msg.forward_sender_name
    || "reenvío directo";

  let list = [];
  try { list = (await store().get(KEY, { type: "json" })) || []; } catch { /* primera vez */ }

  const entry = {
    id: `${msg.message_id}-${msg.chat?.id}`,
    text: text.slice(0, 4000),
    origen: String(origen).slice(0, 80),
    at: (msg.forward_date || msg.date || Math.floor(Date.now() / 1000)) * 1000,
    receivedAt: Date.now(),
  };
  // Evita duplicados si Telegram reintenta la entrega.
  if (!list.some((x) => x.id === entry.id)) {
    await store().setJSON(KEY, [entry, ...list].slice(0, MAX));
  }

  return new Response("ok", { status: 200 });
};
