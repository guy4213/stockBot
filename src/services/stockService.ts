import axios from "axios";
import logger from "../utils/logger";
import dotenv from "dotenv";
import { HardPreFilter } from "../types/grok.types";
import { buildPreFilterSignals } from "./grokService";

dotenv.config({ quiet: true });

// ⚠️ FMP API is optional now - only needed for earnings/cash flow data
// Stock listing (us_stocks_cache.json) no longer requires FMP API
const apiKey = process.env.FMP_API_KEY;

if (!apiKey) {
  logger.warn("FMP_API_KEY not found. Some features will be unavailable.");
}// 🔹 שני Base URLs שונים
const stableBaseUrl = "https://financialmodelingprep.com/stable";
const apiBaseUrl = "https://financialmodelingprep.com/api/v3";
const apiV4BaseUrl = "https://financialmodelingprep.com/api/v4";

export type EarningRes = {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  lastUpdated: string;
};


export interface HistoricalPrice {
  date: string;
  price: number;
  volume: number;
}


// ============================================
// runHardPreFilter - פונקציה עצמאית
// קוראים אותה מתוך fullExtraction בשורה אחת
// ============================================

export async function runHardPreFilter(
  symbol: string,
  companyName: string,
  reportType: "BMO" | "AMC",
  epsBeatPercent: number | null
): Promise<HardPreFilter> {

  const [historicalResult, quoteResult] = await Promise.allSettled([
    getHistoricalPrices(symbol, 35),
    getQuote(symbol),
  ]);

  const prices = historicalResult.status === "fulfilled" ? historicalResult.value : null;
  const quote  = quoteResult.status === "fulfilled" ? quoteResult.value : null;

  // ─── Run-Up 30 יום ────────────────────────────────────────
  const runUp30d = calcRunUp(prices ?? []);

  // ─── Volume Ratio — מחושב מhistorical ────────────────────
  let volumeRatio: number | null = null;

  if (quote?.volume && prices && prices.length >= 20) {
    const avgVolume = prices
      .slice(0, 30)  // 30 ימים אחרונים
      .reduce((sum, day) => sum + (day.volume ?? 0), 0) / Math.min(prices.length, 30);

    if (avgVolume > 0) {
      volumeRatio = quote.volume / avgVolume;
      logger.info(`   📊 Volume: ${(quote.volume/1e6).toFixed(1)}M vs avg ${(avgVolume/1e6).toFixed(1)}M → ×${volumeRatio.toFixed(1)}`);
    }
  } else {
    logger.warn(`   ⚠️ volumeRatio N/A — prices: ${prices?.length ?? 0}, volume: ${quote?.volume ?? 'null'}`);
  }

  // ─── AH / Gap ─────────────────────────────────────────────
  let ahPrice: number | null = null;
  let ahChangePercent: number | null = null;

  if (quote?.open && quote?.previousClose && quote.previousClose > 0) {
    if (reportType === "BMO") {
      ahPrice = quote.open;
      ahChangePercent = Number(
        (((quote.open - quote.previousClose) / quote.previousClose) * 100).toFixed(2)
      );
      logger.info(`   📊 BMO Gap: $${quote.open} vs $${quote.previousClose} = ${ahChangePercent}%`);
    } else {
      ahPrice = quote.price;
      ahChangePercent = Number((quote.changesPercentage ?? 0).toFixed(2));
      logger.info(`   📊 AMC Change: ${ahChangePercent}%`);
    }
  }

  logger.info(`   📊 Run-Up 30d:   ${runUp30d !== null ? runUp30d.toFixed(1) + "%" : "N/A"}`);
  logger.info(`   📊 AH Change:    ${ahChangePercent !== null ? ahChangePercent.toFixed(1) + "%" : "N/A"}`);
  logger.info(`   📊 Volume Ratio: ${volumeRatio !== null ? "×" + volumeRatio.toFixed(1) : "N/A"}`);

  const signals = buildPreFilterSignals(runUp30d, ahChangePercent, volumeRatio, epsBeatPercent);

  return { runUp30d, volumeRatio, ahChangePercent, ahPrice, signals };
}
export const getHistoricalPrices = async (
  symbol: string,
  limit: number = 35
): Promise<HistoricalPrice[] | null> => {
  try {
    const url = `${stableBaseUrl}/historical-price-eod/light?symbol=${symbol}&limit=${limit}&apikey=${apiKey}`;
    const response = await axios.get(url);

    if (!response.data || response.data.length === 0) {
      logger.warn(`No historical prices for ${symbol}`);
      return null;
    }

    // מגיע sorted desc (חדש→ישן) - משאירים כך
    return response.data as HistoricalPrice[];
  } catch (e) {
    logger.error(`getHistoricalPrices error for ${symbol}:`, e);
    return null;
  }
};

export function calcRunUp(prices: HistoricalPrice[]): number | null {
  if (!prices || prices.length < 30) return null;

  // prices[0] = היום (הכי חדש), prices[29] = לפני 30 יום
  const priceToday = prices[0].price;
  const price30dAgo = prices[29].price;

  if (!price30dAgo || price30dAgo === 0) return null;

  return ((priceToday - price30dAgo) / price30dAgo) * 100;
}

export const getEarningsCalendar = async (
  startDate: string,
  endDate: string
) => {
  try {
    const url = `${stableBaseUrl}/earnings-calendar?from=${startDate}&to=${endDate}&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getEarningsCalendar error:" + e);
  }
};

export const getEarnings = async (symbol: string) => {
  try {
    const url = `${stableBaseUrl}/earnings?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data as EarningRes[];
  } catch (e) {
    logger.error("getEarnings error:" + e);
  }
};

export const getCashFlow = async (symbol: string) => {
  try {
    const url = `${stableBaseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getCashFlow error:" + e);
  }
};

export const getQuote = async (symbol: string) => {
  try {
    const url = `${stableBaseUrl}/quote?symbol=${symbol}&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No quote data for ${symbol}`);
      return null;
    }
    
    const quote = response.data[0];
    
    return {
      symbol: quote.symbol,
      name: quote.name,
      price: quote.price,
      marketCap: quote.marketCap,
      avgVolume: quote.avgVolume,
      volume: quote.volume,
      change: quote.change,
      changesPercentage: quote.changesPercentage,
      eps: quote.eps,
      pe: quote.pe,
      open: quote.open ?? null,                      
      previousClose: quote.previousClose ?? null,   
    };
  } catch (e) {
    logger.error(`getQuote error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Income Statement למאר Margins
export const getIncomeStatement = async (symbol: string) => {
  try {
    const url = `${apiBaseUrl}/income-statement/${symbol}?period=quarter&limit=5&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No income statement data for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getIncomeStatement error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Analyst Estimates (כקירוב ל-Guidance)
export const getAnalystEstimates = async (symbol: string) => {
  try {
    const url = `${apiBaseUrl}/analyst-estimates/${symbol}?period=quarter&limit=2&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No analyst estimates for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getAnalystEstimates error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Social Sentiment
export const getSocialSentiment = async (symbol: string) => {
  try {
    const url = `${apiV4BaseUrl}/social-sentiment?symbol=${symbol}&limit=5&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No social sentiment data for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getSocialSentiment error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Earnings Call Transcript (אופציונלי - כבד!)
export const getEarningsTranscript = async (
  symbol: string,
  quarter: number,
  year: number
) => {
  try {
    const url = `${apiBaseUrl}/earning_call_transcript/${symbol}?quarter=${quarter}&year=${year}&apikey=${apiKey}`;
    const response = await axios.get(url);

    if (!response.data || response.data.length === 0) {
      logger.warn(`No earnings transcript for ${symbol} Q${quarter} ${year}`);
      return null;
    }

    return response.data[0];
  } catch (e) {
    logger.error(`getEarningsTranscript error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: Finnhub Metrics API - חילוץ YoY Growth, FCF, Margins (הכי אמין!)
export const getFinnhubMetrics = async (symbol: string) => {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    logger.warn("FINNHUB_API_KEY not found");
    return null;
  }

  try {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`;
    const response = await axios.get(url);

    if (!response.data || !response.data.metric) {
      logger.warn(`No Finnhub metrics for ${symbol}`);
      return null;
    }

    const metric = response.data.metric;

    // חילוץ הנתונים שאנחנו צריכים
    return {
      // YoY Growth
      epsGrowthTTM: metric.epsGrowthTTMYoy,  // % change (e.g., -2.77)
      revenueGrowthTTM: metric.revenueGrowthTTMYoy,  // % change
      epsGrowthQuarterly: metric.epsGrowthQuarterlyYoy,
      revenueGrowthQuarterly: metric.revenueGrowthQuarterlyYoy,

      // Margins
      netMarginTTM: metric.netProfitMarginTTM,  // % (e.g., -117.61)
      operatingMarginTTM: metric.operatingMarginTTM,  // % (e.g., -113.09)
      grossMarginTTM: metric.grossMarginTTM,

      // Free Cash Flow (מחושב מ-EV/FCF)
      evFcfRatio: metric["currentEv/freeCashFlowTTM"],
      marketCap: metric.marketCapitalization,  // in millions
      enterpriseValue: metric.enterpriseValue,  // in millions

      // נתונים נוספים שימושיים
      peRatio: metric.peTTM,
      pbRatio: metric.pbQuarterly,
      beta: metric.beta,
      week52High: metric["52WeekHigh"],
      week52Low: metric["52WeekLow"],
    };
  } catch (e) {
    logger.error(`getFinnhubMetrics error for ${symbol}:`, e);
    return null;
  }
};