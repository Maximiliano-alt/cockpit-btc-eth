// Análisis de zonas dinámico por LLM. El cliente manda las últimas velas
// diarias de cada activo + contexto; el modelo devuelve zonas (imán de
// liquidez, POI) y línea de invalidación derivadas de la estructura real.
// Gemini (con fallback automático de modelo si el configurado no tiene cuota);
// cache 4 h por día + precios redondeados.
const { callGeminiWithFallback } = require("./_lib/gemini.js");

let cache = { at: 0, key: null, body: null };
const TTL = 4 * 60 * 60 * 1000;

const SYSTEM =
  "Eres un analista técnico institucional (SMC/Wyckoff) de criptomonedas. " +
  "Para cada activo recibes el precio actual y sus últimas ~120 velas diarias como [high,low,close] " +
  "(de la más antigua a la más reciente), más contexto de mercado (Fear&Greed, dominancia, flujos ETF, on-chain). " +
  'Devuelve SOLO JSON válido con exactamente esta forma: {"BTCUSDT":{"zones":[{"label":string,"from":number,"to":number,"kind":"target"|"poi"}],' +
  '"lines":[{"label":string,"price":number,"kind":"stop"}],"comment":string},"ETHUSDT":{...},"SOLUSDT":{...},' +
  '"playbook":[{"horizon":"Semanal","ideas":[{"asset":"BTC","side":string,"entry":string,"stop":string,"target":string,"rr":string,"cond":string}]},' +
  '{"horizon":"Mensual","ideas":[...]},{"horizon":"Anual","ideas":[...]}]}. ' +
  "Reglas de zonas: máximo 3 zones por activo — un imán de liquidez (kind target, donde está la liquidez obvia: equal highs/lows, " +
  "swing relevante) y 1-2 POI de acumulación/distribución (kind poi, order blocks o demanda/oferta cerca de mínimos/máximos estructurales). " +
  "Exactamente 1 line de invalidación HTF (kind stop) bajo la estructura que anula la tesis. " +
  "Los niveles DEBEN salir de la estructura visible en las velas (swing highs/lows, rangos, mechas), no de números redondos inventados. " +
  "from < to siempre. comment: una frase con la lectura de estructura del activo. Labels cortos en español. " +
  "Reglas de playbook: escenarios condicionados, NO señales. Solo BTC y ETH (SOL no es operable). 2 ideas por horizonte (1 BTC, 1 ETH). " +
  "side tipo 'Long swing'/'Acumulación'/'Esperar'; entry/stop/target con niveles numéricos coherentes con las zonas que devolviste; " +
  "rr estimado tipo '≈1.8' o '—'; cond = condición estructural concreta que debe cumplirse antes de ejecutar. " +
  "Si la estructura no da para un long razonable en algún horizonte, di 'Esperar' y explica qué tendría que pasar.";

function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

function cacheKey(body) {
  try {
    const j = JSON.parse(body || "{}");
    const day = new Date().toISOString().slice(0, 10);
    const prices = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
      .map((s) => Math.round((j.assets?.[s]?.price || 0) / 100) * 100)
      .join("|");
    return `${day}|${prices}`;
  } catch {
    return String(Date.now());
  }
}

function sanitize(raw) {
  const out = {};
  for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const a = raw?.[sym];
    if (!a) continue;
    const zones = (Array.isArray(a.zones) ? a.zones : [])
      .map((z) => ({
        label: String(z.label || "").slice(0, 40),
        from: num(z.from), to: num(z.to),
        kind: z.kind === "target" ? "target" : "poi",
      }))
      .filter((z) => z.label && z.from != null && z.to != null && z.from < z.to)
      .slice(0, 3);
    const lines = (Array.isArray(a.lines) ? a.lines : [])
      .map((l) => ({ label: String(l.label || "").slice(0, 40), price: num(l.price), kind: "stop" }))
      .filter((l) => l.label && l.price != null)
      .slice(0, 2);
    if (zones.length || lines.length) {
      out[sym] = { zones, lines, comment: String(a.comment || "").slice(0, 200) };
    }
  }
  return out;
}

function sanitizePlaybook(raw) {
  if (!Array.isArray(raw)) return null;
  const str = (v, n) => String(v ?? "").slice(0, n);
  const out = raw
    .map((h) => ({
      horizon: str(h.horizon, 20),
      ideas: (Array.isArray(h.ideas) ? h.ideas : [])
        .map((p) => ({
          asset: p.asset === "ETH" ? "ETH" : "BTC",
          side: str(p.side, 30),
          entry: str(p.entry, 60),
          stop: str(p.stop, 60),
          target: str(p.target, 60),
          rr: str(p.rr, 15),
          cond: str(p.cond, 180),
        }))
        .filter((p) => p.side && p.entry)
        .slice(0, 3),
    }))
    .filter((h) => h.horizon && h.ideas.length)
    .slice(0, 3);
  return out.length ? out : null;
}

async function callAnthropic(key, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Anthropic HTTP " + res.status + " " + JSON.stringify(data).slice(0, 200));
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const ck = cacheKey(event.body);
  if (cache.body && cache.key === ck && Date.now() - cache.at < TTL) {
    return { statusCode: 200, body: cache.body };
  }
  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (!gemini && !anthropic) {
    return { statusCode: 500, body: JSON.stringify({ error: "Sin GEMINI_API_KEY ni ANTHROPIC_API_KEY" }) };
  }
  try {
    const ctx = JSON.parse(event.body || "{}");
    const user = "Datos por activo y contexto:\n" + JSON.stringify(ctx);
    let text, model;
    if (gemini) {
      try {
        const r = await callGeminiWithFallback(gemini, SYSTEM, user, {
          maxOutputTokens: 8192, temperature: 0.25, responseMimeType: "application/json",
        });
        text = r.text; model = r.model;
      } catch (e) {
        if (!anthropic) throw e;
        text = await callAnthropic(anthropic, user);
        model = "claude-sonnet-4-6";
      }
    } else {
      text = await callAnthropic(anthropic, user);
      model = "claude-sonnet-4-6";
    }
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text);
    const zones = sanitize(parsed);
    const playbook = sanitizePlaybook(parsed.playbook);
    if (!Object.keys(zones).length) throw new Error("respuesta sin zonas válidas");
    const body = JSON.stringify({ zones, playbook, model, at: Date.now() });
    cache = { at: Date.now(), key: ck, body };
    return { statusCode: 200, body };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
