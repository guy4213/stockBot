import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger from "../utils/logger";
// ✅ שימוש ב-FMP ו-Finnhub לקבלת נתונים מדויקים במקום AI
import { getEarnings, getQuote, getFinnhubMetrics } from "./stockService"; 
import {
  GrokResponse,
  GrokMessage,
  MorningIntelligenceResponse,
  MiniCheckResponse,
  MiniCheckResult,
  FullExtractionResponse,
  FinalAnalysis,
  MiraScore,
  StockProcessingState,
  ProcessingStatus,
  Stock,
} from "../types/grok.types";

dotenv.config({ quiet: true });

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const GROK_API_KEY = process.env.GROK_API_KEY;
const GROK_MODEL = "grok-3-mini"; 

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DELAY_BETWEEN_STOCKS_MS = 2 * 60 * 1000;
const MAX_API_RETRIES = 3;

interface ExtendedStock extends Stock {
    quarter?: number;
    fiscalYear?: number;
}

// ============================================
// HELPER: Call Grok API
// ============================================
async function callGrokAPI(
  messages: GrokMessage[],
  temperature: number = 0.2,
  maxTokens: number = 6000,
  enableWebSearch: boolean = false
): Promise<string> {
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY missing");

  const requestBody: any = {
    model: GROK_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  if (enableWebSearch) {
    requestBody.search_parameters = { mode: "auto", return_citations: true, max_search_results: 20 };
  }

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const response = await axios.post<GrokResponse>(GROK_API_URL, requestBody, {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROK_API_KEY}` },
          timeout: 600000, 
      });
      return response.data.choices[0].message.content;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429 && attempt < MAX_API_RETRIES) {
          await new Promise(r => setTimeout(r, 60000 * (attempt + 1)));
          continue;
      }
      if (attempt >= MAX_API_RETRIES) throw error;
    }
  }
  throw new Error("Max retries exceeded");
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

function extractJSON(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found");
  return text.substring(start, end + 1);
}

// ============================================
// 1. MORNING INTELLIGENCE
// ============================================
interface FinnhubEarningsEntry { 
    symbol: string; 
    hour: string; 
    quarter: number; 
    year: number;
    epsActual?: number | null;
    revenueActual?: number | null;
}

async function checkFinnhubUpdates(symbol: string, date: string): Promise<boolean> {
    const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
    if (!FINNHUB_API_KEY) return false;

    const yesterday = new Date(date);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    try {
        const response = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(
            `https://finnhub.io/api/v1/calendar/earnings`, 
            { params: { from: yesterdayStr, to: date, token: FINNHUB_API_KEY, symbol: symbol } }
        );

        const entries = response.data.earningsCalendar || [];
        const entry = entries.find(e => e.symbol.toUpperCase() === symbol.toUpperCase());

        if (entry) {
            if (entry.epsActual !== null && entry.epsActual !== undefined) {
                logger.info(`🔥 FINNHUB SIGNAL: ${symbol} released earnings! EPS Actual: ${entry.epsActual}`);
                return true;
            }
        }
        return false;
    } catch (error) {
        logger.error(`❌ Error checking Finnhub updates for ${symbol}`, error);
        return false;
    }
}

export async function morningIntelligence(date: string): Promise<MorningIntelligenceResponse> {
  logger.info(`🌅 Running Morning Intelligence (Hybrid) for ${date}...`);

  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY; 
  if (!FINNHUB_API_KEY) throw new Error("Missing FINNHUB_API_KEY");

  logger.info(`📡 Calling Finnhub API (Range: ${date} - ${date})...`);
  
  const response = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(
    `https://finnhub.io/api/v1/calendar/earnings`, 
    { params: { from: date, to: date, token: FINNHUB_API_KEY } }
  );

  const rawList = response.data.earningsCalendar || [];
  logger.info(`✅ Finnhub returned ${rawList.length} raw entries.`);

  const validatedStocks: ExtendedStock[] = [];
  const MIN_MARKET_CAP = 300_000_000; 
  const MIN_VOLUME = 5_000_000; 
  const processedSymbols = new Set<string>();

  for (const entry of rawList) {
    const symbol = entry.symbol.toUpperCase();
    if (processedSymbols.has(symbol)) continue;
    processedSymbols.add(symbol);

 

    try {
      // ✅ שלב 1: בדיקת שווי שוק ונפח (FMP Quote)
      const quote = await getQuote(symbol);
      
      if (!quote || !quote.marketCap || quote.marketCap < MIN_MARKET_CAP) {
          logger.info(`⚠️ ${symbol} - Market cap too low ($${quote?.marketCap ? (quote.marketCap / 1e6).toFixed(1) + 'M' : 'N/A'}). Skipping.`);
          continue;
      }
      
      if (!quote || !quote.volume || quote.volume < MIN_VOLUME) {
          logger.info(`⚠️ ${symbol} - Volume too low (${quote?.volume ? (quote.volume / 1e6).toFixed(1) + 'M' : 'N/A'}). Skipping.`);
          continue;
      }

      // ✅ שלב 2: אימות תאריך דיווח (רק אחרי שעבר שווי+נפח!)
      const isDateValid = await verifyEarningsDate(symbol, date);
      if (!isDateValid) {
          logger.warn(`⚠️ ${symbol} - Earnings date mismatch with FMP. Skipping.`);
          continue;
      }
      
      let reportType: "BMO" | "AMC" = entry.hour.toLowerCase() === 'bmo' ? "BMO" : "AMC";
      let windowStart = reportType === "BMO" ? "07:00" : "16:05";
      let windowEnd = reportType === "BMO" ? "09:30" : "20:00";
      
      logger.info(`💎 Found: ${symbol} (${quote.name}) | Q${entry.quarter} ${entry.year} | Cap: $${(quote.marketCap / 1e9).toFixed(2)}B | Volume: ${(quote.volume / 1e6).toFixed(1)}M`);

      validatedStocks.push({
          symbol: symbol,
          companyName: quote.name || symbol,
          reportType: reportType,
          windowStart: windowStart,
          windowEnd: windowEnd,
          marketCap: quote.marketCap,
          volume: quote.volume || 0,
          confidence: 100,
          sources: ["Finnhub", "FMP"],
          quarter: entry.quarter,
          fiscalYear: entry.year,
          // ✅ שמור את הנתונים מ-Finnhub!
          finnhubData: {
              epsActual: entry.epsActual,
              epsEstimate: entry.epsEstimate,
              revenueActual: entry.revenueActual,
              revenueEstimate: entry.revenueEstimate
          }
      });
      
      await delay(500);

    } catch (err: any) {
      logger.error(`⚠️ CRASH processing ${symbol}: ${err.message}`);
    }
  }

  validatedStocks.sort((a, b) => b.marketCap - a.marketCap);
  logger.info(`✅ Final List: ${validatedStocks.length} stocks.`);
  return { date, stocks: validatedStocks };
}

// ============================================
// Helper: Verify Earnings Date with FMP
// ============================================
async function verifyEarningsDate(symbol: string, expectedDate: string): Promise<boolean> {
    try {
        logger.info(`🔍 Verifying earnings date for ${symbol} (expected: ${expectedDate})`);
        
        const earnings = await getEarnings(symbol);
        
        if (!earnings || earnings.length === 0) {
            logger.warn(`⚠️ No earnings data from FMP for ${symbol}`);
            return false; // אין נתונים - לא מאומת
        }

        // ✅ מיון לפי lastUpdated (הכי חדש ראשון)
        const sortedEarnings = earnings.sort((a, b) => 
            new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
        );

        // ✅ קח את 3 הרשומות העדכניות ביותר
        const recentEarnings = sortedEarnings.slice(0, 3);
        
        logger.info(`📊 Latest 3 earnings for ${symbol}:`);
        recentEarnings.forEach((e, i) => {
            logger.info(`  ${i + 1}. Date: ${e.date} | Last Updated: ${e.lastUpdated}`);
        });

        // ✅ בדוק אם אחד מהם תואם לתאריך הצפוי
        const matchingEarning = recentEarnings.find(e => e.date === expectedDate);

        if (matchingEarning) {
            logger.info(`✅ MATCH FOUND: ${symbol} has earnings on ${expectedDate} (updated: ${matchingEarning.lastUpdated})`);
            return true;
        }

        // ✅ אם לא מצאנו התאמה - הדפס את התאריך הקרוב ביותר
        const closestDate = recentEarnings[0].date;
        logger.warn(`❌ NO MATCH: ${symbol} next earnings is ${closestDate}, not ${expectedDate}`);
        return false;

    } catch (error: any) {
        logger.error(`❌ Error verifying earnings date for ${symbol}:`, error.message);
        return false; // במקרה של שגיאה - לא מאומת
    }
}

// ============================================
// 2. MINI-CHECK
// ============================================
export async function miniCheck(symbol: string, companyName: string, quarter?: number, fiscalYear?: number): Promise<MiniCheckResponse> {
  logger.info(`🔍 AI Fallback Check for ${symbol}...`);
  const now = new Date().toISOString();
  const today = now.split("T")[0];
  const specificTerm = (quarter && fiscalYear) ? `Q${quarter} ${fiscalYear}` : "Quarterly";
  
  const prompt = `
  TARGET: ${symbol} (${companyName})
  SPECIFIC REPORT: ${specificTerm} Earnings
  DATE: ${today}
  MISSION: Check if Earnings Press Release published TODAY.
  Look for HEADLINES like "${symbol} Reports ${specificTerm} Results".
  Reply ONE WORD: YES or NO.
  `;

  try {
    const res = await callGrokAPI([{ role: "user", content: prompt }], 0.3, 50, true);
    const cleanRes = res.trim().toUpperCase();
    let finalResult: MiniCheckResult = "UNSURE";
    if (cleanRes.includes("YES")) finalResult = "YES";
    else if (cleanRes.includes("NO")) finalResult = "NO";
    else if (cleanRes.includes("REPORTS") || cleanRes.includes("RELEASED")) finalResult = "YES";

    return { symbol, checkTime: now, result: finalResult };
  } catch (e: any) { 
      return { symbol, checkTime: now, result: "UNSURE" }; 
  }
}

// ============================================
// 3. FULL EXTRACTION & SCORING
// ============================================

function calculateDetailedScore(data: FullExtractionResponse): MiraScore {
    let totalScore = 0;
    const scoreBreakdown: string[] = [];
    const exceptions: string[] = [];
    let negativeCount = 0;

    const epsChange = data.eps.beatPercent || 0;
    if (epsChange > 10) { totalScore += 2; }
    else if (epsChange >= 5) { totalScore += 1.5; }
    else if (epsChange >= 3) { totalScore += 1; }
    else if (epsChange >= -3) { totalScore += 0; }
    else if (epsChange >= -5) { totalScore += -0.5; }
    else if (epsChange >= -10) { totalScore += -1; }
    else { totalScore += -1.5; }
    if (epsChange < -3) negativeCount++;

    const revChange = data.revenue.beatPercent || 0;
    if (revChange > 7) { totalScore += 1.5; }
    else if (revChange >= 3) { totalScore += 1; }
    else if (revChange >= -3) { totalScore += 0; }
    else { totalScore += -1; }
    if (revChange < -3) negativeCount++;

    const guidance = data.guidance.status.toLowerCase();
    if (guidance.includes('raised')) { totalScore += 1; }
    else if (guidance.includes('maintained')) { totalScore += 0.5; }
    else if (guidance.includes('lowered')) { totalScore += -1.5; negativeCount++; }

    const yoyEps = data.yoyGrowth.epsChange || 0;
    if (yoyEps > 30) { totalScore += 1; }
    else if (yoyEps >= 10) { totalScore += 0.5; }
    else if (yoyEps < -10) { totalScore += -0.5; negativeCount++; }

    const yoyRev = data.yoyGrowth.revenueChange || 0;
    if (yoyRev > 20) { totalScore += 1; }
    else if (yoyRev >= 10) { totalScore += 0.5; }
    else if (yoyRev < 0) { totalScore += -0.5; negativeCount++; }

    const fcfChange = data.cashFlow.yoyChange || 0;
    if (fcfChange > 0) { totalScore += 0.5; }
    else if (fcfChange < 0) { totalScore += -0.5; negativeCount++; }

    if (data.margins.trend === 'improving') { totalScore += 0.5; }
    else if (data.margins.trend === 'declining') { totalScore -= 0.5; negativeCount++; }

    if (data.sentiment.overall === 'positive') { totalScore += 0.5; }
    else if (data.sentiment.overall === 'negative') { totalScore -= 0.5; negativeCount++; }

    let classification = "NEUTRAL";
    if (totalScore >= 4) classification = "POSITIVE";
    else if (totalScore >= 2) classification = "POSITIVE";
    else if (totalScore <= -2) classification = "NEGATIVE";

    if (negativeCount >= 6) {
        classification = "NEGATIVE";
        exceptions.push(`⚠️ Override: ${negativeCount} negative indicators → NEGATIVE`);
    }

    return {
        totalScore,
        classification,
        breakdown: { epsScore: epsChange, revenueScore: revChange, guidanceScore: 0, yoyEpsScore: yoyEps, yoyRevenueScore: yoyRev, fcfScore: fcfChange, marginScore: 0, sentimentScore: 0 },
        exceptions
    };
}

function calculateTradeParams(price: number, classification: string) {
    const safePrice = price || 0;
    
    // ✅ בדיקה ראשונית - אם אין מחיר בכלל
    if (safePrice === 0 || !safePrice) {
        logger.warn(`⚠️ Cannot calculate trade params - price is invalid: ${price}`);
        return { 
            direction: classification === "POSITIVE" ? "LONG 🟢" : 
                      classification === "NEGATIVE" ? "SHORT 🔴" : "NEUTRAL ⚪", 
            entryPrice: 0, 
            targetPrice: 0, 
            stopPrice: 0,
            hasPriceData: false  // ✅ דגל שמציין שאין מחיר
        };
    }
    
    // ✅ יש מחיר תקין
    if (classification === "POSITIVE") {
        return {
            direction: "LONG 🟢",
            entryPrice: Number((safePrice * 0.98).toFixed(2)),
            targetPrice: Number((safePrice * 1.05).toFixed(2)),
            stopPrice: Number((safePrice * 0.95).toFixed(2)),
            hasPriceData: true
        };
    } else if (classification === "NEGATIVE") {
        return {
            direction: "SHORT 🔴",
            entryPrice: Number((safePrice * 1.02).toFixed(2)),
            targetPrice: Number((safePrice * 0.95).toFixed(2)),
            stopPrice: Number((safePrice * 1.05).toFixed(2)),
            hasPriceData: true
        };
    }
    
    // ✅ NEUTRAL - אבל עם מחיר תקין
    return { 
        direction: "NEUTRAL ⚪", 
        entryPrice: Number(safePrice.toFixed(2)),   // ✅ שים את המחיר הנוכחי
        targetPrice: Number((safePrice * 1.03).toFixed(2)),  // ✅ יעד קטן של 3%
        stopPrice: Number((safePrice * 0.97).toFixed(2)),    // ✅ סטופ של 3%
        hasPriceData: true  // ✅ יש מחיר!
    };
}

// ============================================
// 4. FULL EXTRACTION (FORCE SYMBOL) 🛑
// ============================================
// In grokService.ts

// ============================================
// 4. FULL EXTRACTION (FORCE SYMBOL) 🛑
// ============================================
export async function fullExtraction(
  symbol: string, 
  companyName: string, 
  reportDate: string,
  currentPrice?: number,
  finnhubData?: {
    epsActual: number | null;
    epsEstimate: number | null;
    revenueActual: number | null;
    revenueEstimate: number | null;
  }
): Promise<FullExtractionResponse> {
  logger.info(`📊 Extracting ${symbol}...`);
  
  // ✅ אם יש נתוני Finnhub - השתמש בהם ישירות!
  if (finnhubData && 
      finnhubData.epsActual !== null && 
      finnhubData.revenueActual !== null) {
    
    logger.info(`🎯 Using Finnhub data directly for ${symbol}!`);
    
    const epsActual = finnhubData.epsActual;
    const epsEstimate = finnhubData.epsEstimate || epsActual;
    const revenueActual = finnhubData.revenueActual;
    const revenueEstimate = finnhubData.revenueEstimate || revenueActual;
    
    const epsBeatPercent = epsEstimate !== 0 
      ? ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100 
      : 0;
    
    const revBeatPercent = revenueEstimate !== 0
      ? ((revenueActual - revenueEstimate) / revenueEstimate) * 100
      : 0;

    logger.info(`📊 ${symbol} - EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)`);
    logger.info(`📊 ${symbol} - Revenue: $${(revenueActual / 1e9).toFixed(2)}B vs $${(revenueEstimate / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)`);

    // ✅ בנה את האובייקט עם נתונים אמיתיים
    const data: FullExtractionResponse = {
      symbol,
      companyName,
      reportDate,
      eps: {
        actual: epsActual,
        estimate: epsEstimate,
        beatPercent: epsBeatPercent
      },
      revenue: {
        actual: revenueActual,
        estimate: revenueEstimate,
        beatPercent: revBeatPercent
      },
      guidance: {
        status: "unavailable",
        details: null
      },
      yoyGrowth: {
        epsChange: null,
        revenueChange: null
      },
      cashFlow: {
        freeCashFlow: null,
        yoyChange: null
      },
      margins: {
        netMargin: null,
        operatingMargin: null,
        trend: "unavailable"
      },
      sentiment: {
        overall: "neutral",
        reasoning: null
      },
      marketData: {
        price: currentPrice || null
      },
      highlights: [],
      concerns: []
    };

    // ✅ תחילה - נסה לחלץ YoY/FCF/Margins מ-Finnhub Metrics (הכי אמין!)
    logger.info(`📊 Fetching Finnhub Metrics for ${symbol}...`);
    try {
      const finnhubMetrics = await getFinnhubMetrics(symbol);
      if (finnhubMetrics) {
        // YoY Growth - EPS
        if (finnhubMetrics.epsGrowthTTM !== null && finnhubMetrics.epsGrowthTTM !== undefined) {
          data.yoyGrowth.epsChange = finnhubMetrics.epsGrowthTTM;
          logger.info(`   ✅ YoY EPS Growth: ${finnhubMetrics.epsGrowthTTM}%`);
        } else {
          // ⚠️ Finnhub מחזיר null כשהמניה בהפסד - נחשב בעצמנו!
          logger.info(`   ⚠️ YoY EPS Growth is null from Finnhub, calculating manually from quarterly data...`);
          try {
            const earningsData = await getEarnings(symbol);
            if (earningsData && earningsData.length >= 4) {
              // הרבעון הנוכחי (אינדקס 0) vs אותו רבעון אשתקד (בדרך כלל אינדקס 4)
              const currentQ = earningsData[0];
              const priorYearQ = earningsData[4]; // 4 רבעונים אחורה = שנה

              if (currentQ?.epsActual !== null && priorYearQ?.epsActual !== null) {
                const current = currentQ.epsActual;
                const prior = priorYearQ.epsActual;

                // חישוב YoY - עובד גם על הפסדים!
                let yoyGrowth: number;
                if (prior === 0) {
                  yoyGrowth = current > 0 ? 100 : current < 0 ? -100 : 0;
                } else {
                  yoyGrowth = ((current - prior) / Math.abs(prior)) * 100;
                }

                data.yoyGrowth.epsChange = yoyGrowth;
                logger.info(`   ✅ YoY EPS Growth (calculated): ${yoyGrowth.toFixed(2)}% (${prior} → ${current})`);
              } else {
                logger.warn(`   ⚠️ Missing EPS data for YoY calculation`);
              }
            } else {
              logger.warn(`   ⚠️ Not enough historical earnings data (got ${earningsData?.length || 0} quarters)`);
            }
          } catch (err: any) {
            logger.warn(`   ⚠️ Could not calculate YoY EPS manually: ${err.message}`);
          }
        }

        // YoY Growth - Revenue
        if (finnhubMetrics.revenueGrowthTTM !== null && finnhubMetrics.revenueGrowthTTM !== undefined) {
          data.yoyGrowth.revenueChange = finnhubMetrics.revenueGrowthTTM;
          logger.info(`   ✅ YoY Revenue Growth: ${finnhubMetrics.revenueGrowthTTM}%`);
        }

        // Margins
        if (finnhubMetrics.netMarginTTM !== null && finnhubMetrics.netMarginTTM !== undefined) {
          data.margins.netMargin = finnhubMetrics.netMarginTTM;
          logger.info(`   ✅ Net Margin: ${finnhubMetrics.netMarginTTM}%`);
        }
        if (finnhubMetrics.operatingMarginTTM !== null && finnhubMetrics.operatingMarginTTM !== undefined) {
          data.margins.operatingMargin = finnhubMetrics.operatingMarginTTM;
          logger.info(`   ✅ Operating Margin: ${finnhubMetrics.operatingMarginTTM}%`);
        }

        // FCF (חישוב מ-EV/FCF)
        if (finnhubMetrics.evFcfRatio && finnhubMetrics.enterpriseValue) {
          // EV / FCF = ratio → FCF = EV / ratio
          const fcf = (finnhubMetrics.enterpriseValue * 1000000) / finnhubMetrics.evFcfRatio;
          data.cashFlow.freeCashFlow = fcf;
          logger.info(`   ✅ Free Cash Flow: $${(fcf / 1e6).toFixed(2)}M (calculated from EV/FCF)`);
        }

        // Margin Trend
        if (data.margins.netMargin !== null) {
          data.margins.trend = data.margins.netMargin > 0 ? "improving" : "declining";
        }

        logger.info(`✅ Finnhub Metrics loaded successfully for ${symbol}`);
      } else {
        logger.warn(`⚠️ No Finnhub Metrics available for ${symbol}`);
      }
    } catch (err: any) {
      logger.error(`❌ Failed to fetch Finnhub Metrics for ${symbol}:`, err.message);
    }

    // ✅ עכשיו תשתמש ב-AI רק לנתונים חסרים (guidance, sentiment, highlights)
    try {
      const quarter = Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
      const year = new Date(reportDate).getFullYear();
      
      const supplementPrompt = `
You are a financial data analyst extracting information from official earnings reports.

TARGET COMPANY: ${symbol} (${companyName})
REPORT DATE: ${reportDate}
QUARTER: Q${quarter} ${year}

KNOWN DATA (Already extracted from Finnhub - DO NOT EXTRACT AGAIN):
- EPS: ${epsActual} vs estimate ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
- Revenue: $${(revenueActual / 1e9).toFixed(2)}B vs estimate $${(revenueEstimate / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)

CRITICAL INSTRUCTIONS:
1. Search ONLY in these sources (in order of priority):
   a) ${companyName} Investor Relations website:
      - ir.${symbol.toLowerCase()}.com
      - investors.${companyName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')}.com
      - ${companyName.toLowerCase().replace(/\s+/g, '')}.com/investors
   
   b) Official earnings press release for Q${quarter} ${year}
   
   c) Conference call transcript from the earnings call

2. DO NOT use news articles, analyst reports, or third-party summaries
3. DO NOT use sites like SeekingAlpha, Yahoo Finance, Bloomberg (only for last resort)
4. Look for the OFFICIAL press release with title like:
   - "${symbol} Reports Q${quarter} ${year} Results"
   - "${companyName} Announces ${quarter}Q Earnings"
   - "${companyName} Reports Quarterly Financial Results"

EXTRACT THE FOLLOWING DATA:

1. **Guidance** (2 fields):
   a) **Status**: Did management raise/lower/maintain guidance for next quarter or full year?
      - Look for phrases: "raising full-year guidance", "updating outlook", "reaffirming guidance", "increasing forecast"
      - Return: "raised" | "lowered" | "maintained" | "unavailable"

   b) **Details** (1 sentence in HEBREW explaining WHAT changed):
      - If raised: מה הועלה? (revenue target, EPS target, margins, etc.)
      - If lowered: מה הופחת ולמה?
      - If maintained: מה נשמר על אף מה?
      - If unavailable: return null
      - Example: "הנהלה העלתה תחזית הכנסות שנתית ל-$950M-$980M, מעל הקונצנזוס של $920M"

2. **Sentiment** (2 fields):
   a) **Overall**: Overall tone from CEO/CFO in prepared remarks
      - Positive: Optimistic language, strong growth emphasis, exceeding expectations
      - Neutral: Stable outlook, meeting expectations, balanced tone
      - Negative: Challenges emphasized, cautious outlook, disappointing results
      - Return: "positive" | "neutral" | "negative"

   b) **Reasoning** (1 sentence in HEBREW explaining WHY):
      - What specific achievements/challenges led to this sentiment?
      - Quote key phrases from management (translated to Hebrew)
      - Example: "מנכ\"ל הדגיש צמיחה של 15% בשוק אירופה והשקת פלטפורמת AI חדשה"

3. **Key Highlights** (exactly 2 bullet points):
   - Major achievements from the quarter
   - Record metrics, product launches, market expansions
   - Cost savings, margin improvements

4. **Key Concerns** (exactly 2 bullet points):
   - Risks mentioned by management
   - Challenges, headwinds, competitive pressures
   - Areas that missed expectations

⚠️ NOTE: YoY Growth, Free Cash Flow, and Margins are already extracted from Finnhub Metrics API.
DO NOT extract these - focus only on Guidance, Sentiment, Highlights, and Concerns.

SEARCH QUERY EXAMPLES TO USE:
- "site:ir.${symbol.toLowerCase()}.com Q${quarter} ${year} earnings"
- "${symbol} investor relations quarterly results ${reportDate}"
- "${companyName} Q${quarter} ${year} earnings press release"
- "${symbol} earnings call transcript ${reportDate}"

OUTPUT FORMAT - Return ONLY this JSON structure:
{
  "guidance": {
    "status": "raised" | "lowered" | "maintained" | "unavailable",
    "details": "משפט אחד בעברית מה שונה בתחזית" | null
  },
  "sentiment": {
    "overall": "positive" | "neutral" | "negative",
    "reasoning": "משפט אחד בעברית למה הסנטימנט כזה" | null
  },
  "highlights": [
    "First specific achievement or positive metric",
    "Second specific achievement or positive metric"
  ],
  "concerns": [
    "First specific risk or challenge mentioned",
    "Second specific risk or challenge mentioned"
  ]
}

VALIDATION RULES:
- If you cannot find the official IR page or press release → status: "unavailable"
- If you find only news articles → try harder to find IR sources first
- Highlights and concerns must be specific (not generic statements)
- Return ONLY the JSON - NO markdown, NO explanations, NO extra text
`;

      logger.info(`🤖 Calling AI to supplement with guidance & sentiment...`);
      logger.info(`🔍 AI will search: ir.${symbol.toLowerCase()}.com and ${companyName} Investor Relations`);

      const aiRes = await callGrokAPI(
        [
          {
            role: "system",
            content: "You are a financial data extraction API specialized in parsing official company investor relations documents. You MUST prioritize IR websites over news articles. Return ONLY valid JSON with no markdown formatting or explanations."
          },
          {
            role: "user",
            content: supplementPrompt
          }
        ],
        0.1,  // ✅ טמפרטורה נמוכה מאוד - פחות "יצירתיות"
        2500,
        true  // ✅ Enable web search
      );

      // 🛑 DEBUG: Print full AI response
      logger.info(`📥 ===== FULL AI RESPONSE (RAW) =====`);
      logger.info(`Length: ${aiRes.length} characters`);
      logger.info(aiRes);
      logger.info(`📥 ===== END OF RAW RESPONSE =====`);

      let cleanedRes = aiRes.trim();
      // ✅ נקה markdown בכל הצורות האפשריות
      if (cleanedRes.startsWith('```json')) {
        cleanedRes = cleanedRes.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
      }
      if (cleanedRes.startsWith('```')) {
        cleanedRes = cleanedRes.replace(/^```\n?/g, '').replace(/```\n?$/g, '');
      }
      cleanedRes = cleanedRes.trim();

      // 🛑 DEBUG: Print cleaned response
      logger.info(`📥 ===== CLEANED RESPONSE =====`);
      logger.info(cleanedRes);
      logger.info(`📥 ===== END OF CLEANED RESPONSE =====`);

      const aiData = JSON.parse(cleanedRes);

      // 🛑 DEBUG: Print parsed JSON
      logger.info(`📥 ===== PARSED JSON OBJECT =====`);
      logger.info(JSON.stringify(aiData, null, 2));
      logger.info(`📥 ===== END OF PARSED JSON =====`);

      // ✅ מיזוג עם הנתונים מ-Finnhub + אימות
      if (aiData.guidance && aiData.guidance.status) {
        data.guidance = {
          status: aiData.guidance.status,
          details: aiData.guidance.details || null
        };
        logger.info(`📈 Guidance: ${data.guidance.status}`);
        if (data.guidance.details) {
          logger.info(`   📝 Details: ${data.guidance.details}`);
        }
      } else {
        logger.warn(`⚠️ No valid guidance found`);
      }

      if (aiData.sentiment && aiData.sentiment.overall) {
        data.sentiment = {
          overall: aiData.sentiment.overall,
          reasoning: aiData.sentiment.reasoning || null
        };
        logger.info(`💭 Sentiment: ${data.sentiment.overall}`);
        if (data.sentiment.reasoning) {
          logger.info(`   📝 Reasoning: ${data.sentiment.reasoning}`);
        }
      } else {
        logger.warn(`⚠️ No valid sentiment found`);
      }

      // ℹ️ YoY Growth, FCF, Margins already loaded from Finnhub Metrics (see above)

      if (aiData.highlights && Array.isArray(aiData.highlights) && aiData.highlights.length >= 2) {
        data.highlights = aiData.highlights.slice(0, 2); // לקחת רק 2 ראשונים
        logger.info(`✨ Highlights: ${data.highlights.join(' | ')}`);
      } else {
        logger.warn(`⚠️ No valid highlights found (got ${aiData.highlights?.length || 0})`);
        data.highlights = ["Data not available from IR sources", "Data not available from IR sources"];
      }

      if (aiData.concerns && Array.isArray(aiData.concerns) && aiData.concerns.length >= 2) {
        data.concerns = aiData.concerns.slice(0, 2); // לקחת רק 2 ראשונים
        logger.info(`⚠️ Concerns: ${data.concerns.join(' | ')}`);
      } else {
        logger.warn(`⚠️ No valid concerns found (got ${aiData.concerns?.length || 0})`);
        data.concerns = ["Data not available from IR sources", "Data not available from IR sources"];
      }

      logger.info(`✅ AI supplement complete: Guidance=${data.guidance.status}, Sentiment=${data.sentiment.overall}`);

    } catch (e: any) {
      logger.error(`❌ AI supplement failed for ${symbol}:`, e.message);
      logger.warn(`⚠️ Using default values for guidance/sentiment/highlights/concerns`);
      // ברירות מחדל כבר מוגדרות למעלה
    }

    // ✅ Override price with FMP data if available
    if (currentPrice && currentPrice > 0) {
      logger.info(`💰 Using FMP price: $${currentPrice}`);
      data.marketData.price = currentPrice;
    } else {
      logger.warn(`⚠️ No valid price available for ${symbol}`);
    }

    return data;
  }
  
  // ============================================
  // ✅ FALLBACK: אם אין נתוני Finnhub - נסה AI מלא
  // ============================================
  logger.warn(`⚠️ No Finnhub data for ${symbol}, falling back to full AI extraction`);
  
  const quarter = Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
  const year = new Date(reportDate).getFullYear();
  
  const extractionPrompt = `
You are a financial data extraction bot. Your ONLY job is to return valid JSON.

SYMBOL: ${symbol}
COMPANY: ${companyName}
DATE: ${reportDate}
QUARTER: Q${quarter} ${year}

CRITICAL INSTRUCTIONS:
1. Search for the official earnings press release from ${companyName} Investor Relations
2. Prioritize IR websites: ir.${symbol.toLowerCase()}.com or investors.${companyName.toLowerCase().replace(/\s+/g, '')}.com
3. Extract ONLY the following data from official sources
4. If a field is unavailable, use null (NOT 0, NOT empty string)
5. Return ONLY valid JSON - NO explanations, NO markdown, NO extra text

REQUIRED JSON STRUCTURE:
{
  "symbol": "${symbol}",
  "companyName": "${companyName}",
  "reportDate": "${reportDate}",
  "eps": {
    "actual": <number or null>,
    "estimate": <number or null>,
    "beatPercent": <number or null>
  },
  "revenue": {
    "actual": <number in dollars or null>,
    "estimate": <number in dollars or null>,
    "beatPercent": <number or null>
  },
  "guidance": {
    "status": "raised" | "lowered" | "maintained" | "unavailable"
  },
  "yoyGrowth": {
    "epsChange": <number or null>,
    "revenueChange": <number or null>
  },
  "cashFlow": {
    "freeCashFlow": <number or null>,
    "yoyChange": <number or null>
  },
  "margins": {
    "netMargin": <number or null>,
    "operatingMargin": <number or null>,
    "trend": "improving" | "stable" | "declining" | "unavailable"
  },
  "sentiment": {
    "overall": "positive" | "neutral" | "negative"
  },
  "marketData": {
    "price": <number or null>
  },
  "highlights": [<string>, <string>],
  "concerns": [<string>, <string>]
}

CRITICAL RULES:
- Do NOT invent data
- Do NOT use 0 for missing data - use null
- Do NOT add explanations or markdown
- Return ONLY the JSON object
- Search official IR sources first before using news articles
`;

  try {
    const res = await callGrokAPI(
      [
        {
          role: "system",
          content: "You are a data extraction API specialized in official investor relations documents. Return ONLY valid JSON. No markdown. No explanations. Prioritize IR websites."
        },
        {
          role: "user",
          content: extractionPrompt
        }
      ],
      0.1,
      4000,
      true
    );

    // 🛑 DEBUG: Print full AI response (FALLBACK MODE)
    logger.info(`📥 ===== FALLBACK MODE: FULL AI RESPONSE (RAW) =====`);
    logger.info(`Length: ${res.length} characters`);
    logger.info(res);
    logger.info(`📥 ===== END OF RAW RESPONSE =====`);

    // ✅ נקה markdown אם יש
    let cleanedRes = res.trim();
    if (cleanedRes.startsWith('```json')) {
      cleanedRes = cleanedRes.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
    }
    if (cleanedRes.startsWith('```')) {
      cleanedRes = cleanedRes.replace(/^```\n?/g, '').replace(/```\n?$/g, '');
    }
    cleanedRes = cleanedRes.trim();

    // 🛑 DEBUG: Print cleaned response
    logger.info(`📥 ===== FALLBACK MODE: CLEANED RESPONSE =====`);
    logger.info(cleanedRes);
    logger.info(`📥 ===== END OF CLEANED RESPONSE =====`);

    const data = JSON.parse(cleanedRes);

    // 🛑 DEBUG: Print parsed JSON
    logger.info(`📥 ===== FALLBACK MODE: PARSED JSON OBJECT =====`);
    logger.info(JSON.stringify(data, null, 2));
    logger.info(`📥 ===== END OF PARSED JSON =====`);
    
    // 🛑 FORCE SYMBOL INJECTION (למקרה שה-AI שכח)
    data.symbol = symbol;
    data.companyName = companyName;
    data.reportDate = reportDate;
    
    // ✅ Override price with FMP data if available
    if (currentPrice && currentPrice > 0) {
      logger.info(`💰 Using FMP price: $${currentPrice} (overriding AI extraction)`);
      data.marketData = data.marketData || {};
      data.marketData.price = currentPrice;
    }
    
    // ✅ VALIDATION: Check for fake zeros
    if (data.revenue?.actual === 0 || data.revenue?.estimate === 0) {
      logger.warn(`⚠️ ${symbol}: Revenue data looks suspicious (0 values) - AI may have failed`);
    }
    if (data.eps?.actual === 0 && data.eps?.estimate === 0) {
      logger.warn(`⚠️ ${symbol}: EPS data looks suspicious (0 values) - AI may have failed`);
    }
    
    // ✅ אימות שיש לפחות כמה נתונים בסיסיים
    if (!data.eps?.actual && !data.revenue?.actual) {
      logger.error(`❌ ${symbol}: AI returned no meaningful data - both EPS and Revenue are null/0`);
    }
    
    return data;
  } catch (e: any) { 
    logger.error(`❌ Full AI extraction failed for ${symbol}:`, e.message); 
    throw e; 
  }
}
// ============================================
// 5. FINAL ANALYSIS (TELEGRAM FORMAT)
// ============================================
export async function finalAnalysis(fullData: FullExtractionResponse, miraScore: MiraScore): Promise<FinalAnalysis> {
  logger.info(`📝 Generating Final Telegram Report for ${fullData.symbol}...`);


    const currentPrice = fullData.marketData?.price || 0;
  
  if (!currentPrice || currentPrice === 0) {
    logger.warn(`⚠️ No valid price for ${fullData.symbol} - cannot calculate trade parameters`);
  } else {
    logger.info(`💰 Using price $${currentPrice} for ${fullData.symbol} trade calculations`);
  }
  const tradeParams = calculateTradeParams(currentPrice, miraScore.classification);

  // ✅ FIX: Handle undefined/null values with fallback
  const epsDeviation = fullData.eps.estimate
    ? (((fullData.eps.actual - fullData.eps.estimate) / Math.abs(fullData.eps.estimate)) * 100).toFixed(2)
    : "N/A";
  const revenueDeviation = fullData.revenue.estimate
    ? (((fullData.revenue.actual - fullData.revenue.estimate) / fullData.revenue.estimate) * 100).toFixed(2)
    : "N/A";

  // ✅ FIX: Safe access with defaults
  const yoyEpsGrowth = fullData.yoyGrowth?.epsChange?.toFixed(2) || fullData.yoyGrowth?.epsGrowth || "לא זמין";
  const yoyRevGrowth = fullData.yoyGrowth?.revenueChange?.toFixed(2) || fullData.yoyGrowth?.revenueGrowth || "לא זמין";
  const netMargin = fullData.margins?.netMargin?.toFixed(2) || "לא זמין";
  const opMargin = fullData.margins?.operatingMargin?.toFixed(2) || "לא זמין";
  const fcfStatus = fullData.cashFlow?.freeCashFlow 
    ? (fullData.cashFlow.freeCashFlow > 0 ? 'חיובי' : 'שלילי')
    : 'לא זמין';
  const fcfTrend = fullData.cashFlow?.trendDescription ? ` (${fullData.cashFlow.trendDescription})` : '';

const prompt = `
אתה Mira, אנליסט פיננסי AI מומחה.
צור דוח טלגרם מפורט ומעוצב בעברית בלבד.

📊 נתונים:
סימול: ${fullData.symbol}
שם: ${fullData.companyName}
תאריך: ${fullData.reportDate}
מחיר נוכחי: $${currentPrice}

EPS: ${fullData.eps.actual} (צפי: ${fullData.eps.estimate}) | סטייה: ${epsDeviation}%
הכנסות: $${(fullData.revenue.actual / 1e9).toFixed(2)}B (צפי: $${(fullData.revenue.estimate / 1e9).toFixed(2)}B) | סטייה: ${revenueDeviation}%
תחזית: ${fullData.guidance.status}${fullData.guidance.details ? ` - ${fullData.guidance.details}` : ''}
Free Cash Flow: ${fcfStatus}${fcfTrend}
YoY Growth: EPS ${yoyEpsGrowth}% | Revenue ${yoyRevGrowth}%
שולי רווח: Net ${netMargin}% | Operating ${opMargin}%
סנטימנט: ${fullData.sentiment.overall}${fullData.sentiment.reasoning ? ` - ${fullData.sentiment.reasoning}` : ''}

ניקוד: ${miraScore.totalScore}
סיווג: ${miraScore.classification}

⚠️ חשוב: ההמלצה חייבת להיות תואמת לסיווג!
- אם הסיווג "POSITIVE" → כיוון חייב להיות "LONG 🟢"
- אם הסיווג "NEGATIVE" → כיוון חייב להיות "SHORT 🔴"
- אם הסיווג "NEUTRAL" → כיוון "NEUTRAL ⚪" (צפה בזהירות)

המלצה: ${tradeParams.direction}
מחיר נוכחי: $${currentPrice}
${tradeParams.hasPriceData ? `
${tradeParams.direction === "NEUTRAL ⚪" ? `
נקודות ניטור:
- כניסה אפשרית: $${tradeParams.entryPrice}
- יעד זהיר: $${tradeParams.targetPrice} (+3%)
- סטופ: $${tradeParams.stopPrice} (-3%)
` : `
כניסה: $${tradeParams.entryPrice}
יעד: $${tradeParams.targetPrice}
סטופ: $${tradeParams.stopPrice}
`}
` : `⚠️ לא ניתן לחשב נקודות מסחר - מחיר מניה לא זמין`}

הדגשים: ${fullData.highlights.join(', ')}
דאגות: ${fullData.concerns.join(', ')}

פורמט הדוח (בעברית בלבד!):

📌 סימול: ${fullData.symbol}
📅 תאריך דוח: ${fullData.reportDate}
💰 מחיר נוכחי: $${currentPrice}

📊 פרטי דוח:
- EPS: $${fullData.eps.actual} מול תחזית $${fullData.eps.estimate} (סטייה ${epsDeviation}%)
- Revenues: $${(fullData.revenue.actual / 1e6).toFixed(0)}M מול תחזית $${(fullData.revenue.estimate / 1e6).toFixed(0)}M (סטייה ${revenueDeviation}%)
- Guidance: ${fullData.guidance.status === 'raised' ? 'הועלה' : fullData.guidance.status === 'lowered' ? 'הופחת' : fullData.guidance.status === 'maintained' ? 'נשמר' : 'לא זמין'}${fullData.guidance.details ? `
  📝 ${fullData.guidance.details}` : ''}
- Free Cash Flow: ${fcfStatus}${fcfTrend}
- YoY Growth: EPS ${yoyEpsGrowth}% | Revenue ${yoyRevGrowth}%
- שולי רווח: Net ${netMargin}% | Operating ${opMargin}%
- סנטימנט הנהלה: ${fullData.sentiment.overall === 'positive' ? 'חיובי' : fullData.sentiment.overall === 'negative' ? 'שלילי' : 'ניטרלי'}${fullData.sentiment.reasoning ? `
  📝 ${fullData.sentiment.reasoning}` : ''}

⚖ ניקוד כולל: ${miraScore.totalScore}
⚖ סיווג סופי: ${miraScore.classification === 'POSITIVE' ? 'חיובי' : miraScore.classification === 'NEGATIVE' ? 'שלילי' : 'ניטרלי'}

📈 המלצת מסחר:

כיוון: ${tradeParams.direction}
מחיר נוכחי: $${currentPrice}
${tradeParams.hasPriceData ? `
${tradeParams.direction === "NEUTRAL ⚪" ? `
נקודות ניטור (עבור NEUTRAL):
- מחיר בסיס: $${tradeParams.entryPrice}
- יעד זהיר: $${tradeParams.targetPrice} (+3%)
- סטופ הגנה: $${tradeParams.stopPrice} (-3%)
(המתן לאות ברורה יותר לפני כניסה)
` : `
כניסה מומלצת: $${tradeParams.entryPrice}
יעד רווח: $${tradeParams.targetPrice}
סטופ לוס: $${tradeParams.stopPrice}
`}
` : `⚠️ לא ניתן לחשב נקודות מסחר - מחיר מניה לא זמין`}

🧩 שיקול דעת AI:
[כתוב ניתוח מפורט של 3-4 שורות בעברית המסביר למה הדוח קיבל את הסיווג הזה, מה הנקודות החזקות והחלשות, ומה המשמעות למשקיעים. התייחס לסטיות מהתחזיות, צמיחה, FCF, ותחזית. אם יש נתונים חסרים - ציין זאת. השתמש במחיר הנוכחי $${currentPrice} בהקשר של ההמלצה.]

📝 מסקנה:
[כתוב משפט אחד בעברית המסכם את ההמלצה הסופית. 
${tradeParams.direction === "NEUTRAL ⚪" ? 'עבור NEUTRAL: המלץ להמתין ולצפות בפיתוחים נוספים לפני קבלת החלטה.' : ''}
וודא שההמלצה תואמת את הכיוון למעלה!]

חשוב: 
1. כל הטקסט חייב להיות בעברית בלבד! אסור אנגלית!
2. ההמלצה במסקנה חייבת להתאים לכיוון המסחר (${tradeParams.direction})
3. אם יש "undefined" או "N/A" - אמור במפורש שהנתון לא זמין
4. החזר רק את הטקסט בפורמט למעלה, ללא markdown.
5. המחיר הנוכחי הוא $${currentPrice} - השתמש בו בניתוח!
${tradeParams.direction === "NEUTRAL ⚪" ? '6. עבור NEUTRAL: הדגש שצריך להמתין לאות ברורה יותר לפני כניסה לפוזיציה.' : ''}
`;
  try {
     const telegramMessage = await callGrokAPI(
         [{ 
             role: "system", 
             content: "אתה אנליסט פיננסי. החזר רק טקסט בעברית, ללא markdown. וודא שההמלצות עקביות עם הסיווג." 
         }, { 
             role: "user", 
             content: prompt 
         }],
         0.4,
         2000,
         false
     );

     logger.info(`📝 Generated Message Preview: ${telegramMessage.substring(0, 50)}...`);
     logger.info(`📏 Message Length: ${telegramMessage.length} characters`);

     if (!telegramMessage || telegramMessage.trim().length === 0) {
         throw new Error("Grok returned empty summary");
     }

     const trimmedMessage = telegramMessage.trim();

     // ✅ VALIDATION: Check for consistency
     if (miraScore.classification === 'POSITIVE' && !trimmedMessage.includes('LONG')) {
         logger.warn(`⚠️ Inconsistency detected: POSITIVE classification but no LONG recommendation`);
     }
     if (miraScore.classification === 'NEGATIVE' && !trimmedMessage.includes('SHORT')) {
         logger.warn(`⚠️ Inconsistency detected: NEGATIVE classification but no SHORT recommendation`);
     }

     logger.info(`✅ Returning summary (${trimmedMessage.length} chars)`);

     return {
         symbol: fullData.symbol,
         date: fullData.reportDate,
         summary: trimmedMessage,
         miraScore,
         tradingRecommendation: tradeParams,
         aiReasoning: "Generated by Grok",
         conclusion: "Report Generated",
         dataSources: ["Finnhub", "FMP", "Grok"],
         confidence: 100
     };
  } catch (e) {
      logger.error(`❌ Error generating Final Analysis:`, e);
      throw e;
  }
}
// ============================================
// 6. STOCK PROCESSOR (ENGINE)
// ============================================
export class StockProcessor {
  private stocks: (StockProcessingState & { quarter?: number, fiscalYear?: number })[] = [];
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(private onComplete?: (stock: StockProcessingState) => void) {}

  private isMarketWindowOpen(windowStart: string): boolean {
    const nyTime = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
    return nyTime >= windowStart;
  }

  getStatus() {
      return { total: this.stocks.length, pending: this.stocks.filter(s => s.status === 'pending').length };
  }

 // In StockProcessor.processNextStock()

private async processNextStock(): Promise<void> {
    if (!this.isRunning) return;

    const stock = this.stocks.find((s) => {
        if (s.status !== "pending" && s.status !== "checking") return false;
        if (!this.isMarketWindowOpen(s.windowStart)) return false;
        return true;
    });

    if (!stock) {
        const remaining = this.stocks.filter(s => s.status === "pending" || s.status === "checking").length;
        if (remaining > 0) {
            logger.info(`⏳ No stocks ready for CURRENT window (NY Time). Waiting... (${remaining} left)`);
            return;
        } else {
            logger.info("✅ All done for today.");
            this.stop();
            return;
        }
    }

    try {
        logger.info(`📦 Processing ${stock.symbol} (Window: ${stock.windowStart})...`);
        stock.status = "checking";
        stock.checkCount++;
        
        const finnhubHasData = await checkFinnhubUpdates(stock.symbol, new Date().toISOString().split("T")[0]);
        let reportConfirmed = false;

        if (finnhubHasData) {
            logger.info(`🚀 FINNHUB CONFIRMED: ${stock.symbol} reported! Skipping AI check.`);
            reportConfirmed = true;
        } else {
            const miniCheckResult = await miniCheck(stock.symbol, stock.companyName, stock.quarter, stock.fiscalYear);
            if (miniCheckResult.result === "YES") {
                logger.info(`🤖 AI FOUND REPORT: ${stock.symbol} reported!`);
                reportConfirmed = true;
            }
        }

        if (reportConfirmed) {
            logger.info(`✅ Report Found! Running Full Analysis...`);
            stock.status = "extracting";
            await delay(2000);
            
            // ✅ GET PRICE FROM FMP
            let currentPrice: number | undefined;
            try {
                const quote = await getQuote(stock.symbol);
                currentPrice = quote?.price || undefined;
                
                if (currentPrice && currentPrice > 0) {
                    logger.info(`💰 Fetched current price for ${stock.symbol}: $${currentPrice}`);
                } else {
                    logger.error(`❌ FMP returned invalid price for ${stock.symbol}: ${currentPrice}`);
                    currentPrice = undefined;
                }
            } catch (e: any) {
                logger.error(`❌ Could not fetch current price for ${stock.symbol}: ${e.message}`);
                currentPrice = undefined;
            }
            
            // ✅ העבר את המחיר ונתוני Finnhub ל-fullExtraction
            const fullData = await fullExtraction(
                stock.symbol, 
                stock.companyName, 
                new Date().toISOString().split("T")[0],
                currentPrice,  // ✅ המחיר מועבר כאן
                // @ts-ignore - העבר את הנתונים מ-Finnhub אם קיימים
                stock.finnhubData
            );
            stock.fullData = fullData;
            
            // ✅ בדוק שהמחיר אכן נשמר ב-fullData
            if (fullData.marketData?.price && fullData.marketData.price > 0) {
                logger.info(`✅ Price confirmed in fullData: $${fullData.marketData.price}`);
            } else {
                logger.warn(`⚠️ No valid price in fullData for ${stock.symbol}`);
            }
            
            const miraScore = calculateDetailedScore(fullData);
            logger.info(`🧮 Score for ${stock.symbol}: ${miraScore.totalScore} (${miraScore.classification})`);

            // ✅ finalAnalysis יקבל את fullData עם המחיר
            const analysis = await finalAnalysis(fullData, miraScore);
            
            stock.analysis = analysis;
            stock.status = "completed";
            
            logger.info(`✅ ${stock.symbol} analysis complete!`);
            
            if (this.onComplete) this.onComplete(stock);
            
        } else {
            logger.info(`⏳ Not published yet (Finnhub & AI both negative). Waiting.`);
            stock.status = "checking";
        }
    } catch (e: any) {
        logger.error(`❌ Error processing ${stock.symbol}: ${e.message}`, e);
        stock.status = "error";
        stock.error = e.message;
    }
    
    if (this.isRunning) {
        await delay(DELAY_BETWEEN_STOCKS_MS);
    }
}

  initialize(data: MorningIntelligenceResponse) { 
      this.stocks = data.stocks.map(s => ({
          ...s, 
          status: 'pending', 
          checkCount: 0, 
          lastCheck: null, 
          error: null, 
          fullData: null, 
          analysis: null,
          // @ts-ignore
          quarter: s.quarter, 
          // @ts-ignore
          fiscalYear: s.fiscalYear
      } as any)); 
  }
  start() { this.isRunning = true; this.processNextStock(); this.checkInterval = setInterval(() => this.processNextStock(), CHECK_INTERVAL_MS); }
  stop() { this.isRunning = false; if (this.checkInterval) clearInterval(this.checkInterval); }
}

export default { morningIntelligence, miniCheck, fullExtraction, finalAnalysis, StockProcessor };