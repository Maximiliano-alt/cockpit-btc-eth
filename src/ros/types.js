/** @typedef {'ACCUMULATION'|'EXPANSION'|'DISTRIBUTION'|'MANIPULATION'} MarketPhase */
/** @typedef {'NO_TRADE'|'MANAGE'|'SWING'|'POSITION'} TradingMode */
/** @typedef {'ACT'|'MANAGE'|'WAIT'} TrafficLight */

/** @typedef {Object} RiskMetrics
 * @property {number} accountBalance
 * @property {number} maxRiskPerTradePct
 * @property {number} maxPortfolioRiskPct
 * @property {number} maxRiskPerTrade
 * @property {number} maxPortfolioRisk
 * @property {number} currentPortfolioRisk
 * @property {number} availableRisk
 * @property {number} riskUtilPct
 */

/** @typedef {Object} OpenPosition
 * @property {string} id
 * @property {'BTC'|'ETH'} asset
 * @property {'swing'|'position'} type
 * @property {number} riskUsd
 */

/** @typedef {Object} PortfolioState
 * @property {number} accountBalance
 * @property {number} maxRiskPerTradePct
 * @property {number} maxPortfolioRiskPct
 * @property {number} exposedCapital
 * @property {OpenPosition[]} positions
 */

/** @typedef {Object} DailyJournal
 * @property {string} date
 * @property {MarketPhase} marketPhase
 * @property {string} bias
 * @property {TradingMode} decision
 * @property {number} allowedTrades
 * @property {number} portfolioRisk
 * @property {string} notes
 */

export const MARKET_PHASE = {
  ACCUMULATION: "ACCUMULATION",
  EXPANSION: "EXPANSION",
  DISTRIBUTION: "DISTRIBUTION",
  MANIPULATION: "MANIPULATION",
};

export const TRADING_MODE = {
  NO_TRADE: "NO_TRADE",
  MANAGE: "MANAGE",
  SWING: "SWING",
  POSITION: "POSITION",
};

export const TRAFFIC_LIGHT = {
  ACT: "ACT",
  MANAGE: "MANAGE",
  WAIT: "WAIT",
};

export const DEFAULT_PORTFOLIO = {
  accountBalance: 0,
  maxRiskPerTradePct: 0,
  maxPortfolioRiskPct: 0,
  exposedCapital: 0,
  positions: [],
};

export const LIMITS = {
  maxPositionTrades: 2,
  maxSwingTrades: 2,
  maxSimultaneous: 2,
};
