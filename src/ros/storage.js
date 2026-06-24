import { DEFAULT_PORTFOLIO } from "./types.js";

const PORTFOLIO_KEY = "ros-portfolio-v1";
const JOURNAL_KEY = "ros-journal-v1";

export function loadPortfolio() {
  try {
    const raw = localStorage.getItem(PORTFOLIO_KEY);
    if (!raw) return { ...DEFAULT_PORTFOLIO, positions: [] };
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_PORTFOLIO,
      ...p,
      positions: Array.isArray(p.positions) ? p.positions : [],
    };
  } catch {
    return { ...DEFAULT_PORTFOLIO, positions: [] };
  }
}

export function savePortfolio(state) {
  localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state));
}

export function loadJournal() {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveJournal(entries) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries.slice(0, 60)));
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
