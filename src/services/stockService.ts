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


  
export async function runHardPreFilter(
  symbol: string,
  companyName: string,
  reportType: "BMO" | "AMC",
  epsBeatPercent: number | null,
  reportDate: string
): Promise<HardPreFilter> {

  // ─── שליפות מקבילות ───────────────────────────────────────
 
const [historicalResult, quoteResult, ratiosResult, estimatesResult] = await Promise.allSettled([
  getHistoricalPrices(symbol, 65),
  getQuote(symbol),
getHistoricalRatios(symbol, reportDate),
getAnalystEstimates(symbol, reportDate),
]);


  const prices  = historicalResult.status === "fulfilled" ? historicalResult.value : null;
  const quote   = quoteResult.status === "fulfilled" ? quoteResult.value : null;
  const ratios  = ratiosResult.status === "fulfilled" ? ratiosResult.value : null;
  const estimates = estimatesResult.status === "fulfilled" ? estimatesResult.value : null;


  logger.info(`🔍 DEBUG Volume — quote.volume: ${quote?.volume}`);
  logger.info(`🔍 DEBUG Volume — prices length: ${prices?.length}`);
  logger.info(`🔍 DEBUG Volume — prices[0].volume: ${prices?.[0]?.volume}`);
  logger.info(`🔍 DEBUG Volume — prices[1].volume: ${prices?.[1]?.volume}`);
  logger.info(`🔍 DEBUG Ratios: ${JSON.stringify(ratios)}`);
  logger.info(`🔍 DEBUG Estimates: ${JSON.stringify(estimates)}`);
  // ─── שלב 0: Run-Up 30 יום (קיים) ─────────────────────────
  const runUp30d = calcRunUp(prices ?? [], 30);

  // ─── שלב 0: Volume Ratio (קיים) ──────────────────────────
  let volumeRatio: number | null = null;
  if (quote?.volume && prices && prices.length >= 20) {
    const avgVolume = prices
      .slice(0, 30)
      .reduce((sum, day) => sum + (day.volume ?? 0), 0) / Math.min(prices.length, 30);
    if (avgVolume > 0) {
      volumeRatio = quote.volume / avgVolume;
      logger.info(`   📊 Volume: ${(quote.volume/1e6).toFixed(1)}M vs avg ${(avgVolume/1e6).toFixed(1)}M → ×${volumeRatio.toFixed(1)}`);
    }
  } else {
    logger.warn(`   ⚠️ volumeRatio N/A — prices: ${prices?.length ?? 0}, volume: ${quote?.volume ?? 'null'}`);
  }

  // ─── שלב 0: AH / Gap (קיים) ──────────────────────────────
  let ahPrice: number | null = null;
  let ahChangePercent: number | null = null;
  if (quote?.open && quote?.previousClose && quote.previousClose > 0) {
    if (reportType === "BMO") {
      ahPrice = quote.open;
      ahChangePercent = Number((((quote.open - quote.previousClose) / quote.previousClose) * 100).toFixed(2));
      logger.info(`   📊 BMO Gap: $${quote.open} vs $${quote.previousClose} = ${ahChangePercent}%`);
    } else {
      ahPrice = quote.price;
      ahChangePercent = Number((quote.changesPercentage ?? 0).toFixed(2));
      logger.info(`   📊 AMC Change: ${ahChangePercent}%`);
    }
  }

  // ─── שלב 3: Run-Up 60 יום (חדש) ─────────────────────────
  const runUp60d = calcRunUp(prices ?? [], 60);
  logger.info(`   📊 Run-Up 60d: ${runUp60d !== null ? runUp60d.toFixed(1) + "%" : "N/A"}`);

  // ─── שלב 3: Multiple Expansion — P/E היום vs לפני 60 יום ─
  let peExpansion: number | null = null;
  const peToday = quote?.pe ?? null;
  const pe60dAgo = ratios?.pe60dAgo ?? null;

  if (peToday !== null && pe60dAgo !== null && pe60dAgo > 0 && peToday > 0) {
    peExpansion = ((peToday - pe60dAgo) / pe60dAgo) * 100;
    logger.info(`   📊 P/E Expansion: ${pe60dAgo.toFixed(1)} → ${peToday.toFixed(1)} = ${peExpansion.toFixed(1)}%`);
  } else {
    logger.warn(`   ⚠️ P/E Expansion N/A — peToday: ${peToday}, pe60dAgo: ${pe60dAgo}`);
  }

  // ─── שלב 3: EPS Revision — תחזית היום vs לפני 60 יום ─────
  let epsRevision: number | null = null;
  const epsEstimateNow   = estimates?.epsEstimateNow ?? null;
  const epsEstimate60dAgo = estimates?.epsEstimate60dAgo ?? null;

  if (epsEstimateNow !== null && epsEstimate60dAgo !== null && epsEstimate60dAgo !== 0) {
    epsRevision = ((epsEstimateNow - epsEstimate60dAgo) / Math.abs(epsEstimate60dAgo)) * 100;
    logger.info(`   📊 EPS Revision: ${epsEstimate60dAgo.toFixed(2)} → ${epsEstimateNow.toFixed(2)} = ${epsRevision.toFixed(1)}%`);
  } else {
    logger.warn(`   ⚠️ EPS Revision N/A — now: ${epsEstimateNow}, 60d: ${epsEstimate60dAgo}`);
  }



  // ─── שלב 3: סיווג כל מדד ─────────────────────────────────
  const runUpLevel    = classifyRunUp(runUp60d);
  const peLevel       = classifyPeExpansion(peExpansion);
  const revisionLevel = classifyEpsRevision(epsRevision);

  logger.info(`   📊 Priced-In Levels → RunUp: ${runUpLevel} | PE: ${peLevel} | Revision: ${revisionLevel}`);

  // ─── שלב 3: ניקוד סופי ───────────────────────────────────
  const { pricedInScore, pricedInClassification } = calcPricedInScore(runUpLevel, peLevel, revisionLevel, runUp60d);

  logger.info(`   📊 Priced-In: ${pricedInClassification} → score: ${pricedInScore}`);

  // ─── Signals (קיים + חדש) ────────────────────────────────
  logger.info(`   📊 Run-Up 30d:   ${runUp30d !== null ? runUp30d.toFixed(1) + "%" : "N/A"}`);
  logger.info(`   📊 AH Change:    ${ahChangePercent !== null ? ahChangePercent.toFixed(1) + "%" : "N/A"}`);
  logger.info(`   📊 Volume Ratio: ${volumeRatio !== null ? "×" + volumeRatio.toFixed(1) : "N/A"}`);

  const signals = buildPreFilterSignals(runUp30d, ahChangePercent, volumeRatio, epsBeatPercent, pricedInClassification, runUp60d);

  return {
    runUp30d,
    volumeRatio,
    ahChangePercent,
    ahPrice,
    signals,
    runUp60d,
    peExpansion,
    epsRevision,
    pricedInScore,
    pricedInClassification,
  };
}

// ============================================
// פונקציות עזר — שלב 3
// ============================================

// calcRunUp מורחב לתמוך ב-30 או 60 יום
export function calcRunUp(prices: HistoricalPrice[], days: 30 | 60 = 30): number | null {
  if (!prices || prices.length < days) return null;
  const priceToday  = prices[0].price;
  const priceXdAgo  = prices[days - 1].price;
  if (!priceXdAgo || priceXdAgo === 0) return null;
  return ((priceToday - priceXdAgo) / priceXdAgo) * 100;
}

// שליפת P/E היסטורי מ-FMP
export async function getHistoricalRatios(
  symbol: string,
  reportDate: string  // ← הוסף
): Promise<{ pe60dAgo: number | null }> {
  try {
    const url = `${stableBaseUrl}/key-metrics?symbol=${symbol}&period=quarter&limit=5&apikey=${apiKey}`;
    const res = await axios.get(url);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      logger.warn(`   ⚠️ getHistoricalRatios: no data for ${symbol}`);
      return { pe60dAgo: null };
    }

    const reportTs = new Date(reportDate).getTime();
    const msIn60d  = 60 * 24 * 60 * 60 * 1000;

    // מחפש רבעון שתאריכו לפחות 60 יום לפני תאריך הדוח
    const old = res.data.find((item: any) => {
      const d = new Date(item.date).getTime();
      return !isNaN(d) && reportTs - d >= msIn60d;
    });

    if (!old) {
      logger.warn(`   ⚠️ No historical ratio found 60d before ${reportDate} for ${symbol}`);
      return { pe60dAgo: null };
    }

    const ey = old.earningsYield;
    if (typeof ey === "number" && ey !== 0) {
      const pe60dAgo = 1 / ey;
      if (pe60dAgo > 0 && pe60dAgo < 500) {
        logger.info(`   📊 P/E 60d ago (${old.date}, earningsYield ${ey.toFixed(4)}): ${pe60dAgo.toFixed(1)}`);
        return { pe60dAgo };
      }
    }

    logger.warn(`   ⚠️ earningsYield invalid for ${symbol} on ${old.date}: ${ey}`);
    return { pe60dAgo: null };
  } catch (e: any) {
    logger.warn(`   ⚠️ getHistoricalRatios failed for ${symbol}: ${e.message}`);
    return { pe60dAgo: null };
  }
}


// שליפת תחזיות EPS היסטוריות מ-Finnhub
export async function getFinnhubEpsEstimates(symbol: string): Promise<{
  epsEstimateNow: number | null;
  epsEstimate60dAgo: number | null;
}> {
  try {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) return { epsEstimateNow: null, epsEstimate60dAgo: null };

    const url = `https://finnhub.io/api/v1/stock/eps-estimate?symbol=${symbol}&freq=quarterly&token=${finnhubKey}`;
    const res = await axios.get(url);

    if (!res.data?.data || res.data.data.length === 0) {
      return { epsEstimateNow: null, epsEstimate60dAgo: null };
    }

    // Finnhub מחזיר מערך של תחזיות לרבעונים עתידיים
    // הרבעון הקרוב ביותר = [0]
    const nextQuarter = res.data.data[0];
    const epsEstimateNow = nextQuarter?.epsAvg ?? null;

    // תחזית לפני 60 יום — Finnhub מחזיר epsAvg, epsLow, epsHigh
    // אין endpoint היסטורי ישיר — משתמשים ב-numberAnalyst לזיהוי שינוי
    // אם יש רק תחזית אחת, מחזירים null עבור epsEstimate60dAgo
    // fallback: אם numberAnalysts ירד/עלה, זה אינדיקטור לרוויזיה
    const epsEstimate60dAgo = nextQuarter?.epsAvgLast ?? null; // שדה לא סטנדרטי — ראה הערה

    return { epsEstimateNow, epsEstimate60dAgo };
  } catch (e: any) {
    logger.warn(`   ⚠️ getFinnhubEpsEstimates failed for ${symbol}: ${e.message}`);
    return { epsEstimateNow: null, epsEstimate60dAgo: null };
  }
}

// סיווג Run-Up
function classifyRunUp(runUp60d: number | null): "LOW" | "MEDIUM" | "HIGH" | "EXTREME" | null {
  if (runUp60d === null) return null;
  if (runUp60d > 35)  return "EXTREME";
  if (runUp60d > 20)  return "HIGH";
  if (runUp60d >= 10) return "MEDIUM";
  return "LOW";
}

// סיווג P/E Expansion
function classifyPeExpansion(peExpansion: number | null): "LOW" | "MEDIUM" | "HIGH" | null {
  if (peExpansion === null) return null;
  if (peExpansion > 25)  return "HIGH";
  if (peExpansion >= 10) return "MEDIUM";
  return "LOW";
}

// סיווג EPS Revision
function classifyEpsRevision(epsRevision: number | null): "LOW" | "MEDIUM" | "HIGH" | null {
  if (epsRevision === null) return null;
  if (epsRevision > 10) return "HIGH";
  if (epsRevision >= 3) return "MEDIUM";
  return "LOW";
}

// ניקוד סופי Priced-In
function calcPricedInScore(
  runUpLevel:    "LOW" | "MEDIUM" | "HIGH" | "EXTREME" | null,
  peLevel:       "LOW" | "MEDIUM" | "HIGH" | null,
  revisionLevel: "LOW" | "MEDIUM" | "HIGH" | null,
  runUp60d:      number | null
): { pricedInScore: number | null; pricedInClassification: "Fully" | "Partially" | "Not" | null } {

  // חסם מוחלט — Run-Up קיצוני
  if (runUp60d !== null && runUp60d > 35) {
    return { pricedInScore: -2, pricedInClassification: "Fully" };
  }

  // ספירת HIGH
  const highCount = [runUpLevel, peLevel, revisionLevel].filter(l => l === "HIGH").length;

  if (highCount >= 2) return { pricedInScore: -2, pricedInClassification: "Fully" };
  if (highCount === 1) return { pricedInScore: -1, pricedInClassification: "Partially" };

  // ספירת MEDIUM
  const mediumCount = [runUpLevel, peLevel, revisionLevel].filter(l => l === "MEDIUM").length;
  if (mediumCount >= 2) return { pricedInScore: -1, pricedInClassification: "Partially" };

  return { pricedInScore: 1, pricedInClassification: "Not" };
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

export async function getAnalystEstimates(
  symbol: string,
  reportDate: string // פורמט: "YYYY-MM-DD"
): Promise<{ epsEstimateNow: number | null; epsEstimate60dAgo: number | null }> {
  try {
    const url = `${stableBaseUrl}/analyst-estimates?symbol=${symbol}&period=quarterly&limit=20&apikey=${apiKey}`;
    const res = await axios.get(url);

    if (!Array.isArray(res.data) || res.data.length === 0) {
      logger.warn(`   ⚠️ getAnalystEstimates: no data for ${symbol}`);
      return { epsEstimateNow: null, epsEstimate60dAgo: null };
    }

    const reportTs = new Date(reportDate).getTime();
    const msIn60d  = 60 * 24 * 60 * 60 * 1000;

    // מסנן רק רבעונות שתאריכם לפני תאריך הדוח
    const pastItems = res.data.filter((item: any) => {
      const d = new Date(item.date).getTime();
      return !isNaN(d) && d < reportTs;
    });

    if (pastItems.length === 0) {
      logger.warn(`   ⚠️ No past estimates found for ${symbol} before ${reportDate}`);
      return { epsEstimateNow: null, epsEstimate60dAgo: null };
    }

    // הכי קרוב לתאריך הדוח = "עכשיו"
    const nowItem = pastItems[0];
    const epsEstimateNow = typeof nowItem.epsAvg === "number" ? nowItem.epsAvg : null;

    // מחפש פריט שנמצא לפחות 60 יום לפני תאריך הדוח
    const old = pastItems.find((item: any) => {
      const d = new Date(item.date).getTime();
      return reportTs - d >= msIn60d;
    });

    const epsEstimate60dAgo = old && typeof old.epsAvg === "number" ? old.epsAvg : null;

    logger.info(`   📊 EPS Estimate now (${nowItem.date}): ${epsEstimateNow} | 60d ago (${old?.date ?? "N/A"}): ${epsEstimate60dAgo}`);

    return { epsEstimateNow, epsEstimate60dAgo };
  } catch (e: any) {
    logger.warn(`   ⚠️ getAnalystEstimates failed for ${symbol}: ${e.message}`);
    return { epsEstimateNow: null, epsEstimate60dAgo: null };
  }
}


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