// Sondeo programado de los canales públicos configurados.
// La lógica vive en _lib/tgpoll.mjs para poder invocarla también a mano desde
// el endpoint de señales (las functions programadas no aceptan HTTP).
import { pollPublicChannels } from "./_lib/tgpoll.mjs";

export default async () => {
  try {
    const r = await pollPublicChannels();
    console.log(`[telegram-poll] ${r.nuevos ?? 0} mensajes nuevos`);
  } catch (e) {
    console.error("[telegram-poll] falló:", e);
  }
};

// Cada 30 min: suficiente para un canal de análisis, y no castiga a t.me.
export const config = { schedule: "*/30 * * * *" };
