// Qué mide cada variable en vivo y cómo leer el valor actual.
//
// La lectura es local (una función por métrica), no una llamada a IA: así el
// texto aparece al instante, cambia con el dato y no consume cuota. La IA se
// reserva para el resumen conjunto del final, que es donde aporta de verdad
// porque tiene que cruzar todas las variables entre sí.

const band = (v, bands) => bands.find(([lim]) => v <= lim)?.[1] ?? bands[bands.length - 1][1];

export const METRICS = {
  fearGreed: {
    label: "Fear & Greed",
    que: "Índice de sentimiento del mercado cripto, de 0 (pánico total) a 100 (euforia).",
    lee: (v) => v == null ? null : band(v, [
      [25, "Miedo extremo. Históricamente es zona de suelos, no de ventas: cuando todos venden por pánico suele quedar poco papel por vender."],
      [45, "Miedo. El mercado está cauto; suele coincidir con correcciones aún sin resolver."],
      [55, "Neutral. Ni pánico ni codicia: el sentimiento no da ventaja en ninguna dirección."],
      [75, "Codicia. El apetito por riesgo es alto; conviene subir la cautela y no perseguir precio."],
      [100, "Codicia extrema. Zona típica de techos locales: el retail ya está dentro y queda poco combustible."],
    ]),
  },
  btcDominance: {
    label: "BTC Dominance",
    que: "Qué porcentaje de todo el valor del mercado cripto es Bitcoin.",
    lee: (v) => v == null ? null : band(v, [
      [45, "Dominancia baja: el capital está rotando fuerte a altcoins."],
      [55, "Dominancia media. Reparto equilibrado entre BTC y el resto."],
      [65, "Dominancia alta: el dinero se refugia en BTC. Las alts suelen sufrir."],
      [100, "Dominancia muy alta: huida a la calidad; el mercado está en modo defensivo."],
    ]),
  },
  ethDominance: {
    label: "ETH Dominance",
    que: "Peso de Ethereum sobre el total del mercado cripto.",
    lee: (v) => v == null ? null : band(v, [
      [10, "ETH perdiendo peso relativo: el capital prefiere BTC o alts concretas."],
      [18, "Peso normal de ETH dentro del mercado."],
      [100, "ETH ganando peso: suele preceder o acompañar rotación hacia altcoins."],
    ]),
  },
  etf: {
    label: "Flujos ETF",
    que: "Dinero neto que entró o salió ayer de los ETF al contado (demanda institucional real).",
    lee: (v) => v == null ? null : v > 200 ? "Entrada institucional fuerte: compra estructural que absorbe oferta del mercado."
      : v > 0 ? "Entrada moderada. Demanda institucional presente pero sin euforia."
      : v > -200 ? "Salida moderada. Las instituciones reducen exposición; un día aislado no marca tendencia."
      : "Salida institucional fuerte: presión vendedora de fondo, no ruido de corto plazo.",
  },
  funding: {
    label: "Funding",
    que: "Comisión que los apalancados pagan cada 8 h. Positiva = los largos pagan a los cortos.",
    lee: (v) => v == null ? null : v < 0 ? "Negativo: los cortos pagan a los largos. Exceso de pesimismo apalancado, terreno fértil para un squeeze al alza."
      : v < 0.01 ? "Bajo y positivo: apalancamiento sano, sin exceso de euforia."
      : v < 0.03 ? "Elevado: los largos pagan caro por estar dentro. Empieza a haber apalancamiento excesivo."
      : "Muy elevado: euforia apalancada. Suele preceder liquidaciones en cascada a la baja.",
  },
  openInterest: {
    label: "Open Interest",
    que: "Valor total de contratos de futuros abiertos. Mide cuánto apalancamiento hay en el sistema.",
    lee: () => "Cuanto más alto, más combustible para movimientos violentos: si el precio va contra la mayoría, las liquidaciones amplifican el movimiento.",
  },
  puell: {
    label: "Puell Multiple",
    que: "Ingresos diarios de los mineros frente a su media anual. Mide presión de venta desde la oferta.",
    lee: (v) => v == null ? null : band(v, [
      [0.5, "Mineros bajo presión extrema. Históricamente ha coincidido con suelos de ciclo."],
      [1.2, "Zona baja/normal: los mineros no están forzados a vender masivamente."],
      [3, "Elevado: los mineros ganan muy por encima de su media y tienden a realizar."],
      [99, "Extremo: señal clásica de techo de ciclo por venta masiva de mineros."],
    ]),
  },
  mvrvz: {
    label: "MVRV Z-Score",
    que: "Cuánto se aleja el precio de mercado del coste medio al que se compraron las monedas.",
    lee: (v) => v == null ? null : band(v, [
      [0, "Precio por debajo del coste medio del mercado: la mayoría está en pérdidas. Zona histórica de suelo."],
      [2, "Zona de valor: el precio no está estirado respecto a lo que pagó el mercado."],
      [5, "Empieza a estar caro respecto al coste base agregado."],
      [99, "Sobrevaloración extrema: territorio de techo de ciclo."],
    ]),
  },
  mayer: {
    label: "Mayer Multiple",
    que: "Precio dividido por su media de 200 días. Mide cuán estirado está respecto a su tendencia larga.",
    lee: (v) => v == null ? null : band(v, [
      [0.8, "Muy por debajo de la media de 200D: descuento histórico."],
      [1, "Bajo la media de 200D: tendencia larga aún no recuperada."],
      [1.5, "Sobre la media, en rango saludable de tendencia alcista."],
      [2.4, "Estirado respecto a la tendencia: el riesgo de corrección aumenta."],
      [99, "Extremo: por encima de 2,4 históricamente marca techos."],
    ]),
  },
  rsi22: {
    label: "RSI 22D",
    que: "Fuerza del movimiento en las últimas 22 sesiones, de 0 a 100.",
    lee: (v) => v == null ? null : band(v, [
      [30, "Sobreventa: el movimiento bajista está agotado en el corto plazo."],
      [45, "Débil, sin agotamiento todavía."],
      [60, "Neutral: sin extremo en ninguna dirección."],
      [70, "Momento alcista sostenido, acercándose a zona de compresión."],
      [100, "Sobrecompra: es habitual que venga una pausa o corrección."],
    ]),
  },
  cycleTop: {
    label: "Cycle Top",
    que: "Cuántos indicadores de techo de ciclo se han activado, sobre un total de 30.",
    lee: (v) => v == null ? null : v === 0 ? "Ninguno activo: el riesgo de estar comprando un techo de ciclo es bajo. El riesgo real es de timing, no de ciclo."
      : v < 5 ? "Algunos activos: empieza a haber señales de madurez del ciclo."
      : v < 15 ? "Varios activos: el ciclo está avanzado, conviene reducir agresividad."
      : "Muchos activos: señales claras de techo de ciclo.",
  },
  altseason: {
    label: "Altcoin Season",
    que: "Cuántas de las 50 mayores altcoins baten a BTC en 90 días. Sobre 75 = altseason.",
    lee: (v) => v == null ? null : band(v, [
      [25, "Bitcoin season: BTC bate a casi todas las alts. El capital está concentrado."],
      [50, "Sin altseason: BTC sigue mandando."],
      [75, "Transición: las alts empiezan a despertar."],
      [100, "Altseason activa: el capital rota masivamente a altcoins. Suele ser fase tardía del ciclo."],
    ]),
  },
  social: {
    label: "Sentimiento social",
    que: "Porcentaje de la comunidad que vota al alza en CoinGecko. Mide optimismo, no precio.",
    lee: (v) => v == null ? null : band(v, [
      [45, "Pesimismo: poca gente espera subidas. Contrarian a favor."],
      [65, "Mixto: sin consenso claro en la comunidad."],
      [80, "Optimismo alto: la mayoría espera subidas, lo que reduce el combustible de compradores nuevos."],
      [100, "Euforia social: casi nadie espera caídas. Suele marcar techos locales."],
    ]),
  },
};

export function readMetric(key, value) {
  const m = METRICS[key];
  if (!m) return null;
  return { label: m.label, que: m.que, lee: m.lee(value) };
}
