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

export interface TrendFmpData {
  prevQuarterEpsChange: number | null;
  prevQuarterRevChange: number | null;
  commonStockRepurchased: number | null;
  commonDividendsPaid: number | null;
}

const SECTOR_ETF_MAP: Record<string, string> = {
  "Technology":             "XLK",
  "Healthcare":             "XLV",
  "Financials":             "XLF",
  "Consumer Discretionary": "XLY",
  "Consumer Staples":       "XLP",
  "Energy":                 "XLE",
  "Industrials":            "XLI",
  "Materials":              "XLB",
  "Real Estate":            "XLRE",
  "Utilities":              "XLU",
  "Communication Services": "XLC",
};

export interface SectorHeatRawData {
  sectorChange: number | null;
  peersAvgChange: number | null;
  sectorName: string | null;
  exchange: string | null;
}


export type EarningRes = {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  lastUpdated: string;
};


export interface SectorHeatRawData {
  sectorChange: number | null;
  peersAvgChange: number | null;
  sectorName: string | null;
  exchange: string | null;
  etfFlowSignal: "positive" | "negative" | "neutral";
  newsMomentumSignal: "positive" | "negative" | "neutral";
}

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
 

const [historicalResult, quoteResult, ratiosResult, estimatesResult, sectorHeatResult] =
  await Promise.allSettled([
    getHistoricalPrices(symbol, 65),
    getQuote(symbol),
    getHistoricalRatios(symbol, reportDate),
    getAnalystEstimates(symbol, reportDate),
    getSectorHeatData(symbol,companyName),   // ✅ חדש
  ]);


  const prices  = historicalResult.status === "fulfilled" ? historicalResult.value : null;
  const quote   = quoteResult.status === "fulfilled" ? quoteResult.value : null;
  const ratios  = ratiosResult.status === "fulfilled" ? ratiosResult.value : null;
  const estimates = estimatesResult.status === "fulfilled" ? estimatesResult.value : null;
  const sectorRaw = sectorHeatResult.status === "fulfilled" ? sectorHeatResult.value : null;
  // ג. חשב classification:
  const sectorHeat = sectorRaw ? calcSectorHeat(sectorRaw) : { sectorHeatClassification: null, sectorHeatScore: null, sectorLongBlocked: false };

  logger.info(`🔍 DEBUG Volume — quote.volume: ${quote?.volume}`);
  logger.info(`🔍 DEBUG Volume — prices length: ${prices?.length}`);
  logger.info(`🔍 DEBUG Volume — prices[0].volume: ${prices?.[0]?.volume}`);
  logger.info(`🔍 DEBUG Volume — prices[1].volume: ${prices?.[1]?.volume}`);
  logger.info(`🔍 DEBUG Ratios: ${JSON.stringify(ratios)}`);
  logger.info(`🔍 DEBUG Estimates: ${JSON.stringify(estimates)}`);

logger.info(
  `🌡️ Sector Heat [${symbol}]: ${sectorHeat.sectorHeatClassification ?? "N/A"} (score: ${sectorHeat.sectorHeatScore ?? "N/A"})`
);

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
const peToday =
  quote?.pe ??
  (quote?.price != null && quote?.eps != null && quote.eps !== 0
    ? quote.price / quote.eps
    : null);  const pe60dAgo = ratios?.pe60dAgo ?? null;

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
    sectorHeatClassification: sectorHeat.sectorHeatClassification ?? null,
    sectorHeatScore: sectorHeat.sectorHeatScore ?? null,
    sectorChange: sectorRaw?.sectorChange ?? null,
    peersAvgChange: sectorRaw?.peersAvgChange ?? null,
    sectorName: sectorRaw?.sectorName ?? null,
    sectorLongBlocked: sectorHeat.sectorLongBlocked,
    etfFlowSignal: sectorRaw?.etfFlowSignal ?? null,
    newsMomentumSignal: sectorRaw?.newsMomentumSignal ?? null,
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


////new function for level 4
export async function getSectorHeatData(symbol: string,companyName:string): Promise<SectorHeatRawData> {
  // ── שלב א: Profile (חובה — נותן sector + exchange) ──────────
  let sectorName: string | null = null;
  let exchange: string | null = null;

  try {
    const profileRes = await axios.get(
      `${stableBaseUrl}/profile?symbol=${symbol}&apikey=${apiKey}`
    );
    const profile = Array.isArray(profileRes.data)
      ? profileRes.data[0]
      : profileRes.data;
    sectorName = profile?.sector ?? null;
    exchange = profile?.exchange ?? null;
    logger.info(`🏭 getSectorHeatData [${symbol}] — sector: ${sectorName}, exchange: ${exchange}`);
  } catch (e) {
    logger.warn(`⚠️ getSectorHeatData [${symbol}]: profile fetch failed`);
    return { sectorChange: null, peersAvgChange: null, sectorName: null, exchange: null , etfFlowSignal: "neutral", newsMomentumSignal: "neutral" };
  }

  // ── שלב ב: Sector Performance + Peers — במקביל ─────────────
  const today = new Date().toISOString().split("T")[0];

  const [sectorPerfResult, peersResult] = await Promise.allSettled([
    exchange
      ? axios.get(
          `${stableBaseUrl}/sector-performance-snapshot?date=${today}&exchange=${exchange}&apikey=${apiKey}`
        )
      : Promise.reject("no exchange"),
    axios.get(`${stableBaseUrl}/stock-peers?symbol=${symbol}&apikey=${apiKey}`),
  ]);

  // ── Sector Change ────────────────────────────────────────────
  let sectorChange: number | null = null;
  if (sectorPerfResult.status === "fulfilled" && sectorName) {
    const sectors = sectorPerfResult.value.data;
    const match = Array.isArray(sectors)
      ? sectors.find((s: any) => s.sector === sectorName)
      : null;
    sectorChange = match?.averageChange ?? null;
    logger.info(
      `📊 Sector [${sectorName}]: averageChange = ${sectorChange !== null ? sectorChange.toFixed(2) + "%" : "N/A"}`
    );
  } else {
    logger.warn(`⚠️ getSectorHeatData [${symbol}]: sector-performance fetch failed or no match`);
  }

  // ── Peers Avg Change ─────────────────────────────────────────
  let peersAvgChange: number | null = null;
  if (peersResult.status === "fulfilled") {
    const peerData = peersResult.value.data;
 const rawPeers: string[] = Array.isArray(peerData)
  ? peerData[0]?.peersList                          // פורמט ישן
    ?? peerData.map((p: any) => p.symbol).filter(Boolean) // פורמט חדש
  : [];

    const peers = rawPeers.filter((p) => p !== symbol).slice(0, 10);

    if (peers.length > 0) {
      try {
        const quoteResults = await Promise.allSettled(
          peers.map((p) =>
            axios.get(`${stableBaseUrl}/quote?symbol=${p}&apikey=${apiKey}`)
          )
        )
        const quotes: any[] = quoteResults
          .filter((r) => r.status === "fulfilled")
          .map((r: any) => Array.isArray(r.value.data) ? r.value.data[0] : r.value.data)
          .filter(Boolean);
         const changes = quotes
        .map((q: any) => q.changePercentage ?? q.changesPercentage)  // ← תומך בשני
        .filter((c: any) => c != null && !isNaN(c));
        logger.info(`🔍 DEBUG Peer quote sample: ${JSON.stringify(quotes[0])}`); // ← זמני

        if (changes.length > 0) {
          peersAvgChange =
            changes.reduce((a: number, b: number) => a + b, 0) / changes.length;
          logger.info(
            `👥 Peers avg change (${changes.length} peers): ${peersAvgChange.toFixed(2)}%`
          );
        } else {
          logger.warn(`⚠️ getSectorHeatData [${symbol}]: no valid peer changesPercentage`);
        }
      } catch (e) {
        logger.warn(`⚠️ getSectorHeatData [${symbol}]: peer quote fetch failed`);
      }
    } else {
      logger.warn(`⚠️ getSectorHeatData [${symbol}]: no peers found`);
    }
  } else {
    logger.warn(`⚠️ getSectorHeatData [${symbol}]: stock-peers fetch failed`);
  }

  
const [etfFlowSignal, newsMomentumSignal] = await Promise.all([
  getEtfFlowSignal(sectorName),
  getNewsMomentumSignal(symbol, companyName), // ← הוסף companyName לפרמטרים של getSectorHeatData
]);
return {
  sectorChange,
  peersAvgChange,
  sectorName,
  exchange,
  etfFlowSignal,
  newsMomentumSignal,
};

}

////new function for level 4

export function calcSectorHeat(raw: SectorHeatRawData): {
  sectorHeatClassification: "Hot" | "Neutral" | "Cold";
  sectorHeatScore: number;
  sectorLongBlocked: boolean;
} {
  const { sectorChange, peersAvgChange, etfFlowSignal, newsMomentumSignal } = raw;

  // ── סיגנל 1: Sector Performance ─────────────────────────
  const sectorSignal =
    sectorChange == null   ? "neutral"
    : sectorChange > 0.5  ? "positive"
    : sectorChange < -0.5 ? "negative"
    : "neutral";

  // ── סיגנל 2: Peer Reactions ──────────────────────────────
  const peersSignal =
    peersAvgChange == null  ? "neutral"
    : peersAvgChange > 1    ? "positive"
    : peersAvgChange < -1   ? "negative"
    : "neutral";


  const signals = [sectorSignal, peersSignal, etfFlowSignal, newsMomentumSignal];

  const positiveCount = signals.filter((s) => s === "positive").length;
  const negativeCount = signals.filter((s) => s === "negative").length;

  logger.info(
    `🌡️ calcSectorHeat signals → sector:${sectorSignal} peers:${peersSignal} etf:${etfFlowSignal} news:${newsMomentumSignal}`
  );
  logger.info(
    `🌡️ calcSectorHeat counts → pos:${positiveCount} neg:${negativeCount}`
  );

  let classification: "Hot" | "Neutral" | "Cold";

if (positiveCount >= 2 && negativeCount === 0) classification = "Hot";
else if (negativeCount >= 2 && positiveCount === 0) classification = "Cold";
else classification = "Neutral";

  const sectorHeatScore =
    classification === "Hot"  ? 1
    : classification === "Cold" ? -1.5
    : 0;

  return {
    sectorHeatClassification: classification,
    sectorHeatScore,
    sectorLongBlocked: classification === "Cold",
  };
}




export async function getEtfFlowSignal(
  sectorName: string | null
): Promise<"positive" | "negative" | "neutral"> {
  const SERPER_API_KEY = process.env.SERPER_API_KEY;
  if (!SERPER_API_KEY || !sectorName) return "neutral";

  const etfTicker = SECTOR_ETF_MAP[sectorName];
  if (!etfTicker) {
    logger.warn(`⚠️ getEtfFlowSignal: no ETF mapped for sector "${sectorName}"`);
    return "neutral";
  }

  try {
    const query = `${etfTicker} ETF flow today`;
    const response = await axios.post(
      "https://google.serper.dev/search",
      { q: query, num: 10, tbs: "qdr:w", gl: "us", hl: "en" }
,
      {
        headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
        timeout: 8000,
      }
    );

    const results = [
      ...(response.data.news || []),
      ...(response.data.organic || []),
    ];

    const POSITIVE_KEYWORDS = [
      "inflow", "inflows", "buying", "bullish", "surge", "rally",
      "gains", "up", "rises", "higher", "outperform",
    ];
    const NEGATIVE_KEYWORDS = [
      "outflow", "outflows", "selling", "bearish", "drop", "fell",
      "decline", "lower", "underperform", "losses", "down",
    ];

    let positiveCount = 0;
    let negativeCount = 0;

    for (const r of results) {
      const text = `${r.title ?? ""} ${r.snippet ?? ""}`.toLowerCase();
      if (POSITIVE_KEYWORDS.some((kw) => text.includes(kw))) positiveCount++;
      if (NEGATIVE_KEYWORDS.some((kw) => text.includes(kw))) negativeCount++;
    }

    logger.info(
      `📡 ETF Flow [${etfTicker}]: pos=${positiveCount} neg=${negativeCount} (${results.length} results)`
    );

    if (positiveCount > negativeCount + 1) return "positive";
    if (negativeCount > positiveCount + 1) return "negative";
    return "neutral";

  } catch (e: any) {
    logger.warn(`⚠️ getEtfFlowSignal [${sectorName}]: ${e.message}`);
    return "neutral";
  }
}


export async function getNewsMomentumSignal(
  symbol: string,
  companyName: string
): Promise<"positive" | "negative" | "neutral"> {
  const SERPER_API_KEY = process.env.SERPER_API_KEY;
  if (!SERPER_API_KEY) return "neutral";

  try {
    const query = `${symbol} ${companyName} earnings`;
    const response = await axios.post(
      "https://google.serper.dev/search",
{ q: query, num: 10, tbs: "qdr:w", gl: "us", hl: "en" }
      ,{
        headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
        timeout: 8000,
      }
    );

    const results = [
      ...(response.data.news || []),
      ...(response.data.organic || []),
    ];

    const POSITIVE_KEYWORDS = [
      "beat", "beats", "strong", "record", "raised guidance", "raises guidance",
      "surpass", "exceed", "top", "upside", "bullish", "rally", "jumps", "soars",
    ];
    const NEGATIVE_KEYWORDS = [
      "miss", "misses", "weak", "lowered guidance", "lowers guidance", "cuts",
      "disappoints", "below", "downside", "bearish", "drops", "falls", "slumps",
    ];

    let positiveCount = 0;
    let negativeCount = 0;

    for (const r of results) {
      const text = `${r.title ?? ""} ${r.snippet ?? ""}`.toLowerCase();
      if (POSITIVE_KEYWORDS.some((kw) => text.includes(kw))) positiveCount++;
      if (NEGATIVE_KEYWORDS.some((kw) => text.includes(kw))) negativeCount++;
    }

    logger.info(
      `📰 News Momentum [${symbol}]: pos=${positiveCount} neg=${negativeCount} (${results.length} results)`
    );

    if (positiveCount > negativeCount + 1) return "positive";
    if (negativeCount > positiveCount + 1) return "negative";
    return "neutral";

  } catch (e: any) {
    logger.warn(`⚠️ getNewsMomentumSignal [${symbol}]: ${e.message}`);
    return "neutral";
  }
}





export async function getTrendFmpData(
  symbol: string,
  currentEpsActual: number | null,
  currentRevActual: number | null
): Promise<TrendFmpData> {
  const result: TrendFmpData = {
    prevQuarterEpsChange: null,
    prevQuarterRevChange: null,
    commonStockRepurchased: null,
    commonDividendsPaid: null,
  };

  try {
    const [incomeRes, cashFlowRes] = await Promise.allSettled([
      axios.get(`${stableBaseUrl}/income-statement?symbol=${symbol}&period=quarter&limit=6&apikey=${apiKey}`),
      axios.get(`${stableBaseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&limit=2&apikey=${apiKey}`),
    ]);

    // ── Income Statement → YoY Acceleration ──────────────────
    if (incomeRes.status === "fulfilled") {
      const rows: any[] = Array.isArray(incomeRes.value.data) ? incomeRes.value.data : [];

      // rows[0] = Q-1 (הרבעון הקודם — ה-current שלנו הוא ה-AI)
      // rows[3] = Q-4 (שנה שעברה של הרבעון הנוכחי — כבר יש לנו ב-AI YoY)
      // rows[4] = Q-5 (שנה שעברה של הרבעון הקודם)

      const q1Eps = rows[0]?.epsDiluted ?? null;
      const q5Eps = rows[4]?.epsDiluted ?? null;
      const q1Rev = rows[0]?.revenue ?? null;
      const q5Rev = rows[4]?.revenue ?? null;

      // YoY של הרבעון הקודם: Q-1 vs Q-5
      if (q1Eps !== null && q5Eps !== null && q5Eps !== 0) {
        result.prevQuarterEpsChange = ((q1Eps - q5Eps) / Math.abs(q5Eps)) * 100;
        logger.info(`   📊 prevQuarterEpsChange: ${q1Eps} vs ${q5Eps} = ${result.prevQuarterEpsChange.toFixed(1)}%`);
      }

      if (q1Rev !== null && q5Rev !== null && q5Rev !== 0) {
        result.prevQuarterRevChange = ((q1Rev - q5Rev) / q5Rev) * 100;
        logger.info(`   📊 prevQuarterRevChange: ${(q1Rev/1e9).toFixed(2)}B vs ${(q5Rev/1e9).toFixed(2)}B = ${result.prevQuarterRevChange.toFixed(1)}%`);
      }
    } else {
      logger.warn(`   ⚠️ getTrendFmpData: income-statement failed for ${symbol}`);
    }

    // ── Cash Flow → Buybacks / Dividends ─────────────────────
    if (cashFlowRes.status === "fulfilled") {
      const cfRows: any[] = Array.isArray(cashFlowRes.value.data) ? cashFlowRes.value.data : [];
      const latest = cfRows[0] ?? null;

      if (latest) {
        result.commonStockRepurchased = latest.commonStockRepurchased ?? null;
        result.commonDividendsPaid = latest.commonDividendsPaid ?? null;
        logger.info(`   📊 Buybacks: ${result.commonStockRepurchased} | Dividends: ${result.commonDividendsPaid}`);
      }
    } else {
      logger.warn(`   ⚠️ getTrendFmpData: cash-flow-statement failed for ${symbol}`);
    }

  } catch (e: any) {
    logger.warn(`   ⚠️ getTrendFmpData error for ${symbol}: ${e.message}`);
  }

  return result;
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

export const getCashFlow = async (symbol: string,limit:number=1) => {
  try {
    const url = `${stableBaseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&limit=$${limit}&apikey=${apiKey}`;
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
  changesPercentage: quote.changePercentage ?? quote.changesPercentage ?? null,
  eps: quote.eps ?? null,
  pe: quote.pe ?? null,
  open: quote.open ?? null,
  previousClose: quote.previousClose ?? null,
};
  } catch (e) {
    logger.error(`getQuote error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Income Statement למאר Margins
export const getIncomeStatement = async (symbol: string,limit:number=5) => {
  try {
const url = `${stableBaseUrl}/income-statement?symbol=${symbol}&period=quarter&limit=${limit}&apikey=${apiKey}`;
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