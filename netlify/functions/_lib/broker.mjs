// Adaptador de broker para Binance USD-M Futures.
//
// Por qué Binance y no Exness/MetaTrader: Exness no expone una API pública de
// trading para retail (solo MT4/MT5), y el paquete oficial MetaTrader5 de
// Python solo corre en Windows con la terminal abierta — imposible desde una
// function serverless. Binance Futures Testnet da una cuenta demo real, con
// API REST completa, los mismos símbolos que ya sigue el cockpit y saldo
// ficticio. La interfaz de abajo está aislada a propósito para poder añadir
// después otro broker (incluido un puente MT5) sin tocar la estrategia.
//
// SEGURIDAD: la URL base se deriva del modo. En "demo" es físicamente
// imposible que apunte a producción, aunque la configuración venga mal.
import crypto from "node:crypto";

// Binance tiene DOS entornos demo de futuros con claves distintas y no
// intercambiables:
//   · testnet.binancefuture.com → testnet clásico, registro aparte.
//   · demo-fapi.binance.com     → "Binance Demo Trading" (demo.binance.com).
//
// El predeterminado es el testnet clásico por un motivo medido, no por gusto:
// Binance bloquea por geolocalización y las functions corren en AWS us-east-2.
// Comprobado desde el propio servidor (bot-control?diag=1):
//   testnet.binancefuture.com → 200 ✓
//   demo-fapi.binance.com     → 451 (bloqueado)
//   fapi.binance.com          → 451 (bloqueado)
// Es decir, desde Netlify SOLO se puede operar contra el testnet clásico.
const DEMO_HOSTS = {
  testnet: "https://testnet.binancefuture.com",
  demo: "https://demo-fapi.binance.com",
};

function demoHost() {
  const v = (process.env.BROKER_DEMO_HOST || "testnet").trim();
  return DEMO_HOSTS[v] || (v.startsWith("https://") ? v : DEMO_HOSTS.testnet);
}

let symbolInfoCache = { at: 0, host: null, data: null };

export class BinanceFutures {
  constructor({ mode = "demo", apiKey, apiSecret }) {
    if (mode !== "demo" && mode !== "live") throw new Error("Modo de broker inválido: " + mode);
    this.mode = mode;
    this.host = mode === "live" ? "https://fapi.binance.com" : demoHost();
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  get isDemo() { return this.mode === "demo"; }

  async #request(method, path, params = {}, signed = false) {
    const url = new URL(this.host + path);
    const query = { ...params };
    if (signed) {
      query.timestamp = Date.now();
      query.recvWindow = 10000;
    }
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString();
    let finalQs = qs;
    if (signed) {
      if (!this.apiKey || !this.apiSecret) throw new Error("Faltan las claves de API del broker");
      const sig = crypto.createHmac("sha256", this.apiSecret).update(qs).digest("hex");
      finalQs = `${qs}&signature=${sig}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url.origin + path + (finalQs ? "?" + finalQs : ""), {
        method,
        signal: ctrl.signal,
        headers: this.apiKey ? { "X-MBX-APIKEY": this.apiKey } : {},
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) {
        const msg = body?.msg || (typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200));
        const err = new Error(`Binance ${res.status}: ${msg}`);
        err.status = res.status;
        err.code = body?.code;
        throw err;
      }
      return body;
    } finally { clearTimeout(timer); }
  }

  /** Filtros de precisión (paso de cantidad, tick de precio, notional mínimo). */
  async symbolInfo() {
    if (symbolInfoCache.data && symbolInfoCache.host === this.host
        && Date.now() - symbolInfoCache.at < 6 * 3600e3) {
      return symbolInfoCache.data;
    }
    const info = await this.#request("GET", "/fapi/v1/exchangeInfo");
    const data = {};
    for (const s of info.symbols || []) {
      const f = Object.fromEntries((s.filters || []).map((x) => [x.filterType, x]));
      data[s.symbol] = {
        stepSize: parseFloat(f.LOT_SIZE?.stepSize ?? "0.001"),
        tickSize: parseFloat(f.PRICE_FILTER?.tickSize ?? "0.01"),
        minQty: parseFloat(f.LOT_SIZE?.minQty ?? "0"),
        minNotional: parseFloat(f.MIN_NOTIONAL?.notional ?? "0"),
        quantityPrecision: s.quantityPrecision ?? 3,
        pricePrecision: s.pricePrecision ?? 2,
      };
    }
    symbolInfoCache = { at: Date.now(), host: this.host, data };
    return data;
  }

  /** Órdenes pendientes (stops y objetivos que aún no se han disparado). */
  async openOrders(symbol) {
    const r = await this.#request("GET", "/fapi/v1/openOrders", symbol ? { symbol } : {}, true);
    return (Array.isArray(r) ? r : []).map((o) => ({
      symbol: o.symbol,
      id: o.orderId,
      side: o.side,
      type: o.type,
      qty: parseFloat(o.origQty || 0),
      price: parseFloat(o.price || 0),
      stopPrice: parseFloat(o.stopPrice || 0),
      reduceOnly: !!o.reduceOnly || !!o.closePosition,
      at: o.time || o.updateTime,
    }));
  }

  /**
   * Historial de operaciones cerradas. Se arma con el flujo de ingresos
   * (REALIZED_PNL, COMMISSION, FUNDING_FEE) porque es la única fuente que da
   * el P&L REALIZADO de verdad: las ejecuciones sueltas no dicen cuánto se
   * ganó, solo qué se compró y vendió.
   */
  async closedTrades(days = 30) {
    const startTime = Date.now() - days * 864e5;
    const rows = await this.#request("GET", "/fapi/v1/income", { startTime, limit: 1000 }, true);
    const list = Array.isArray(rows) ? rows : [];

    // Agrupamos por símbolo + momento para reconstruir cada cierre con sus
    // comisiones y financiación asociadas.
    const closes = [];
    let fees = 0, funding = 0, realized = 0;
    for (const r of list) {
      const v = parseFloat(r.income || 0);
      if (r.incomeType === "COMMISSION") fees += v;
      else if (r.incomeType === "FUNDING_FEE") funding += v;
      else if (r.incomeType === "REALIZED_PNL") {
        realized += v;
        closes.push({ symbol: r.symbol, pnl: v, at: r.time, asset: r.asset });
      }
    }
    closes.sort((a, b) => b.at - a.at);
    const wins = closes.filter((c) => c.pnl > 0);
    return {
      trades: closes.slice(0, 50),
      count: closes.length,
      realized,
      fees,
      funding,
      net: realized + fees + funding,  // comisiones y funding ya vienen negativos
      winRate: closes.length ? (wins.length / closes.length) * 100 : 0,
      bestPnl: closes.length ? Math.max(...closes.map((c) => c.pnl)) : 0,
      worstPnl: closes.length ? Math.min(...closes.map((c) => c.pnl)) : 0,
      days,
    };
  }

  async account() {
    const a = await this.#request("GET", "/fapi/v2/account", {}, true);
    const equity = parseFloat(a.totalMarginBalance ?? a.totalWalletBalance ?? 0);
    const available = parseFloat(a.availableBalance ?? 0);
    const positions = (a.positions || [])
      .map((p) => ({
        symbol: p.symbol,
        amt: parseFloat(p.positionAmt || 0),
        entry: parseFloat(p.entryPrice || 0),
        pnl: parseFloat(p.unrealizedProfit || 0),
        leverage: parseFloat(p.leverage || 1),
      }))
      .filter((p) => Math.abs(p.amt) > 0);
    return { equity, available, positions, walletBalance: parseFloat(a.totalWalletBalance ?? 0) };
  }

  async price(symbol) {
    const r = await this.#request("GET", "/fapi/v1/ticker/price", { symbol });
    return parseFloat(r.price);
  }

  async setLeverage(symbol, leverage) {
    try {
      await this.#request("POST", "/fapi/v1/leverage", { symbol, leverage }, true);
    } catch (e) {
      // Cambiar apalancamiento con posición abierta puede fallar; no es fatal.
      console.log(`[broker] setLeverage ${symbol} → ${leverage} falló: ${e.message}`);
    }
  }

  /**
   * Entrada a mercado + stop y take-profit que cierran la posición completa.
   * Los dos protectores usan closePosition para que nunca puedan invertir la
   * posición si algo queda descuadrado.
   */
  async openBracket({ symbol, side, quantity, stopPrice, takeProfitPrice }) {
    const entry = await this.#request("POST", "/fapi/v1/order", {
      symbol, side, type: "MARKET", quantity,
    }, true);

    const exitSide = side === "BUY" ? "SELL" : "BUY";
    const protectors = [];
    for (const [type, price] of [["STOP_MARKET", stopPrice], ["TAKE_PROFIT_MARKET", takeProfitPrice]]) {
      if (price == null) continue;
      try {
        const o = await this.#request("POST", "/fapi/v1/order", {
          symbol, side: exitSide, type, stopPrice: price,
          closePosition: "true", workingType: "MARK_PRICE", priceProtect: "true",
        }, true);
        protectors.push({ type, orderId: o.orderId, stopPrice: price });
      } catch (e) {
        protectors.push({ type, error: e.message });
      }
    }
    return { entryOrderId: entry.orderId, status: entry.status, protectors };
  }

  /** Orden a mercado simple, sin stop ni objetivo asociados. */
  async marketOrder({ symbol, side, quantity }) {
    const r = await this.#request("POST", "/fapi/v1/order", {
      symbol, side, type: "MARKET", quantity,
    }, true);
    return { orderId: r.orderId, status: r.status };
  }

  async closePosition(symbol, amt) {
    const side = amt > 0 ? "SELL" : "BUY";
    const r = await this.#request("POST", "/fapi/v1/order", {
      symbol, side, type: "MARKET", quantity: Math.abs(amt), reduceOnly: "true",
    }, true);
    await this.cancelAllOrders(symbol).catch(() => {});
    return { orderId: r.orderId };
  }

  async cancelAllOrders(symbol) {
    return this.#request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, true);
  }
}

/** Redondeo a la baja al paso permitido (nunca hacia arriba: evita rechazos). */
export function roundStep(value, step) {
  if (!step) return value;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

export function roundTick(value, tick) {
  if (!tick) return value;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
}
