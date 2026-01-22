import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger from "../utils/logger";
// ✅ שימוש ב-FMP ו-Finnhub לקבלת נתונים מדויקים במקום AI
import {
  getEarnings,
  getQuote,
  getFinnhubMetrics,
  getIncomeStatement,
  getCashFlow
} from "./stockService"; 
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
const MAX_API_RETRIES = 3;
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes between iterations
const DELAY_BETWEEN_STOCKS_MS = 5000; // 5 seconds between individual stock checks
const MAX_CHECK_ATTEMPTS = 10; // Stop checking after 10 failed attempts
const WINDOW_BUFFER_HOURS = 3; // Check stocks ±2 hours from their window
interface ExtendedStock extends Stock {
    quarter?: number;
    fiscalYear?: number;
}

// ✅ הוסף את זה:
interface StockProcessingStateExtended extends StockProcessingState {
  extractionAttempts?: number;
  lastExtractionFailure?: string;
  nextRetryTime?: string;
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
    revenueEstimate: null;
    epsEstimate: number | null | undefined; 
    symbol: string; 
    hour: string; 
    quarter: number; 
    year: number;
    epsActual?: number | null|undefined;
    revenueActual?: number | null;
}
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const dateString = threeDaysAgo.toISOString().split("T")[0];
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
  const MIN_VOLUME = 1_000_000; 
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
      logger.warn(`⚠️ ${symbol} - FMP date mismatch (not blocking - Finnhub is more current)`);
      // ⚠️ DON'T skip - Finnhub is the source of truth for TODAY
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
              epsActual: entry.epsActual ?? null,
              epsEstimate: entry.epsEstimate ?? null,
              revenueActual: entry.revenueActual ?? null,
              revenueEstimate: entry.revenueEstimate ?? null
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
            logger.warn(`⚠️ No FMP data for ${symbol} - trusting Finnhub date`);
            return true;  // ✅ אם אין נתוני FMP - סמוך על Finnhub!
        }

        const sortedEarnings = earnings.sort((a, b) => 
            new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
        );

        const recentEarnings = sortedEarnings.slice(0, 3);
        
        logger.info(`📊 Latest 3 earnings for ${symbol}:`);
        recentEarnings.forEach((e, i) => {
            logger.info(`  ${i + 1}. Date: ${e.date} | Last Updated: ${e.lastUpdated}`);
        });

        const matchingEarning = recentEarnings.find(e => e.date === expectedDate);

        if (matchingEarning) {
            logger.info(`✅ MATCH FOUND: ${symbol} has earnings on ${expectedDate}`);
            return true;
        }

        // ✅ חדש: בדוק אם ה-FMP data ישן מדי (>7 ימים)
        const mostRecent = recentEarnings[0];
        const daysSinceUpdate = Math.floor(
            (new Date().getTime() - new Date(mostRecent.lastUpdated).getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysSinceUpdate > 7) {
            logger.warn(`⚠️ FMP data is stale (${daysSinceUpdate} days old) - trusting Finnhub`);
            return true;  // ✅ FMP לא מעודכן - סמוך על Finnhub
        }

        const closestDate = recentEarnings[0].date;
        logger.warn(`❌ NO MATCH: ${symbol} FMP says ${closestDate}, Finnhub says ${expectedDate}`);
        return false;  // ⚠️ רק אם FMP עדכני ולא תואם

    } catch (error: any) {
        logger.error(`❌ Error verifying earnings date for ${symbol}:`, error.message);
        return true;  // ✅ במקרה של שגיאה - סמוך על Finnhub
    }
}

// ============================================
// 2. MINI-CHECK
// ============================================
export async function miniCheck(symbol: string, companyName: string, quarter?: number, fiscalYear?: number): Promise<MiniCheckResponse> {
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

    // ============================================
    // STEP 1: DYNAMIC SCORING (Updated Weights)
    // ============================================

    // 1. EPS Beat/Miss (±2 points)
    const epsChange = data.eps.beatPercent || 0;
    if (epsChange > 5) { totalScore += 2; scoreBreakdown.push(`EPS Beat ${epsChange.toFixed(1)}% → +2`); }
    else if (epsChange >= 0) { totalScore += 1; scoreBreakdown.push(`EPS Beat ${epsChange.toFixed(1)}% → +1`); }
    else if (epsChange >= -5) { totalScore -= 1; scoreBreakdown.push(`EPS Miss ${epsChange.toFixed(1)}% → -1`); negativeCount++; }
    else { totalScore -= 2; scoreBreakdown.push(`EPS Miss ${epsChange.toFixed(1)}% → -2`); negativeCount++; }

    // 2. Revenue Beat/Miss (±1.5 points)
    const revChange = data.revenue.beatPercent || 0;
    if (revChange > 2) { totalScore += 1.5; scoreBreakdown.push(`Revenue Beat ${revChange.toFixed(1)}% → +1.5`); }
    else if (revChange >= 0) { totalScore += 0.5; scoreBreakdown.push(`Revenue Beat ${revChange.toFixed(1)}% → +0.5`); }
    else if (revChange >= -2) { totalScore -= 0.5; scoreBreakdown.push(`Revenue Miss ${revChange.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1.5; scoreBreakdown.push(`Revenue Miss ${revChange.toFixed(1)}% → -1.5`); negativeCount++; }

    // 3. YoY EPS Growth (±1.5 points)
    const yoyEps = data.yoyGrowth.epsChange || 0;
    if (yoyEps > 10) { totalScore += 1.5; scoreBreakdown.push(`YoY EPS +${yoyEps.toFixed(1)}% → +1.5`); }
    else if (yoyEps > 0) { totalScore += 0.5; scoreBreakdown.push(`YoY EPS +${yoyEps.toFixed(1)}% → +0.5`); }
    else if (yoyEps >= -10) { totalScore -= 0.5; scoreBreakdown.push(`YoY EPS ${yoyEps.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1.5; scoreBreakdown.push(`YoY EPS ${yoyEps.toFixed(1)}% → -1.5`); negativeCount++; }

    // 4. YoY Revenue Growth (±1 point)
    const yoyRev = data.yoyGrowth.revenueChange || 0;
    if (yoyRev > 5) { totalScore += 1; scoreBreakdown.push(`YoY Revenue +${yoyRev.toFixed(1)}% → +1`); }
    else if (yoyRev > 0) { totalScore += 0.5; scoreBreakdown.push(`YoY Revenue +${yoyRev.toFixed(1)}% → +0.5`); }
    else if (yoyRev >= -5) { totalScore -= 0.5; scoreBreakdown.push(`YoY Revenue ${yoyRev.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1; scoreBreakdown.push(`YoY Revenue ${yoyRev.toFixed(1)}% → -1`); negativeCount++; }

    // 5. Free Cash Flow (±1 point)
    const fcf = data.cashFlow.freeCashFlow || 0;
    const fcfChange = data.cashFlow.yoyChange || 0;
    const fcfPositive = fcf > 0;
    const fcfImproving = fcfChange > 0;

    if (fcfPositive && fcfImproving) { totalScore += 1; scoreBreakdown.push(`FCF positive & improving → +1`); }
    else if (fcfPositive) { totalScore += 0.5; scoreBreakdown.push(`FCF positive → +0.5`); }
    else if (!fcfPositive && fcfChange < 0) { totalScore -= 1; scoreBreakdown.push(`FCF negative & declining → -1`); negativeCount++; }
    else if (fcfChange < 0) { totalScore -= 0.5; scoreBreakdown.push(`FCF declining → -0.5`); negativeCount++; }

    // 6. Margins (±1 point) - Check for >0.5% improvement/decline
    const netMargin = data.margins.netMargin || 0;
    const marginTrend = data.margins.trend || 'stable';

    if (marginTrend === 'improving' && Math.abs(netMargin) > 0.5) {
      totalScore += 1;
      scoreBreakdown.push(`Margins improving (${netMargin.toFixed(1)}%) → +1`);
    } else if (marginTrend === 'declining' && Math.abs(netMargin) > 0.5) {
      totalScore -= 1;
      scoreBreakdown.push(`Margins declining (${netMargin.toFixed(1)}%) → -1`);
      negativeCount++;
    }

    // 7. Guidance (±1.5 points)
    const guidance = data.guidance.status.toLowerCase();
    if (guidance.includes('raised')) { totalScore += 1.5; scoreBreakdown.push(`Guidance raised → +1.5`); }
    else if (guidance.includes('maintained')) { totalScore += 0.5; scoreBreakdown.push(`Guidance maintained → +0.5`); }
    else if (guidance.includes('lowered')) { totalScore -= 1.5; scoreBreakdown.push(`Guidance lowered → -1.5`); negativeCount++; }

    // 8. Sentiment (±0.5 points)
    if (data.sentiment.overall === 'positive') { totalScore += 0.5; scoreBreakdown.push(`Sentiment positive → +0.5`); }
    else if (data.sentiment.overall === 'negative') { totalScore -= 0.5; scoreBreakdown.push(`Sentiment negative → -0.5`); negativeCount++; }

    // ============================================
    // STEP 2: SMART EXCEPTION LAYER
    // ============================================

    // Exception 1: Mixed Signal Override
    if (epsChange > 20 && revChange < -10) {
      totalScore -= 1;
      exceptions.push(`🔄 Mixed Signal: Strong EPS beat (+${epsChange.toFixed(1)}%) but revenue miss (${revChange.toFixed(1)}%) → -1`);
    }

    // Exception 2: Cash Flow Priority
    if (fcfChange > 100) {
      totalScore += 0.5;
      exceptions.push(`💰 Exceptional FCF growth (+${fcfChange.toFixed(1)}%) → +0.5`);
    }

    // Exception 3: Margin Collapse
    if (netMargin < -3) {
      totalScore -= 1;
      exceptions.push(`📉 Margin collapse (${netMargin.toFixed(1)}%) → -1`);
    }

    // Exception 4: Guidance Domination
    if (guidance.includes('raised')) {
      totalScore += 0.5;
      exceptions.push(`📈 Guidance raised (dominant signal) → +0.5`);
    }

    // Exception 5: Automatic Negative Override (6+ negative signals)
    if (negativeCount >= 6) {
      exceptions.push(`⚠️ AUTO-NEGATIVE: ${negativeCount} negative signals detected`);
    }

    // Exception 6: Strong EPS+Revenue Beat
    if (epsChange > 10 && revChange > 10) {
      exceptions.push(`🚀 Strong dual beat: EPS +${epsChange.toFixed(1)}%, Rev +${revChange.toFixed(1)}%`);
      // Force minimum POSITIVE classification (applied below)
    }

    // Exception 7: FCF Margin Protection
    if (fcfChange < 0 && marginTrend === 'improving') {
      // Limit FCF penalty to -0.5 max
      const fcfPenalty = scoreBreakdown.find(s => s.includes('FCF') && s.includes('-1'));
      if (fcfPenalty) {
        totalScore += 0.5; // Reduce penalty from -1 to -0.5
        exceptions.push(`🛡️ FCF declining but margins improving → penalty limited to -0.5`);
      }
    }

    // ============================================
    // STEP 3: FINAL CLASSIFICATION
    // ============================================

    let classification = "NEUTRAL";

    // Base classification
    if (totalScore >= 5) classification = "VERY_POSITIVE";
    else if (totalScore >= 2) classification = "POSITIVE";
    else if (totalScore <= -5) classification = "VERY_NEGATIVE";
    else if (totalScore <= -2) classification = "NEGATIVE";

    // Exception overrides
    if (negativeCount >= 6) {
      classification = "NEGATIVE";
    }

    if (epsChange > 10 && revChange > 10) {
      if (classification === "NEUTRAL" || classification === "NEGATIVE") {
        classification = "POSITIVE"; // Force positive for strong dual beat
      }
    }

    return {
        totalScore: Math.round(totalScore * 100) / 100, // Round to 2 decimals
        classification,
        breakdown: {
          epsScore: epsChange,
          revenueScore: revChange,
          guidanceScore: guidance.includes('raised') ? 1.5 : guidance.includes('lowered') ? -1.5 : 0,
          yoyEpsScore: yoyEps,
          yoyRevenueScore: yoyRev,
          fcfScore: fcfChange,
          marginScore: netMargin,
          sentimentScore: data.sentiment.overall === 'positive' ? 0.5 : data.sentiment.overall === 'negative' ? -0.5 : 0
        },
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



async function findEarningsPDF(symbol: string, companyName: string, q: number, yr: number): Promise<string | null> {
  const searches = [
    `${companyName} Q${q} ${yr} earnings presentation PDF`,
    `${companyName} investor relations Q${q} ${yr}`,
    `${symbol} quarterly results Q${q} ${yr} PDF`,
    `site:investors.${companyName.toLowerCase().replace(/\s+/g, '')}.com Q${q} ${yr}`
  ];

  for (const search of searches) {
    // חפש ואמת שה-PDF קיים
    const result = await callGrokAPI([{
      role: "user",
      content: `Search for: "${search}". Return ONLY the direct PDF URL if found, or "NOT_FOUND" if no PDF exists.`
    }], 0.1, 200, true);

    if (result && !result.includes("NOT_FOUND") && result.includes("pdf")) {
      return result.trim();
    }
  }

  return null;
}
function validateAIResponse(aiData: any, symbol: string): { isValid: boolean; reason: string } {
  // Check if pdfMetrics has at least some data
  const hasMetrics = aiData.pdfMetrics &&
    (aiData.pdfMetrics.revenueYoY !== null ||
     aiData.pdfMetrics.netMargin !== null ||
     aiData.pdfMetrics.efficiencyRatioOrOperatingMargin !== null ||
     aiData.pdfMetrics.cashFromOperations !== null);

  // Check if we have PDF URL
  const hasPdfUrl = aiData.dataSources?.pdfUrl !== null && aiData.dataSources?.pdfUrl !== undefined;

  // Check if highlights/concerns are meaningful (not generic "No data" messages)
  const hasRealHighlights = aiData.highlights && aiData.highlights.length > 0 &&
    !aiData.highlights[0].toLowerCase().includes("no specific") &&
    !aiData.highlights[0].toLowerCase().includes("not available") &&
    !aiData.highlights[0].toLowerCase().includes("data not available");

  if (!hasMetrics && !hasPdfUrl) {
    return {
      isValid: false,
      reason: `No PDF found and no quarterly metrics extracted`
    };
  }

  if (!hasPdfUrl) {
    return {
      isValid: false,
      reason: `PDF URL missing - cannot verify data source`
    };
  }

  if (!hasMetrics) {
    return {
      isValid: false,
      reason: `PDF found but failed to extract quarterly metrics`
    };
  }

  if (!hasRealHighlights) {
    return {
      isValid: false,
      reason: `PDF found but AI returned generic 'no data' responses`
    };
  }

  // Success - we have PDF, metrics, and real content
  return { isValid: true, reason: "Valid response with PDF and metrics" };
}

//fullExtraction function
// export async function fullExtraction(
//   symbol: string,
//   companyName: string,
//   reportDate: string,
//   currentPrice?: number,
//   finnhubData?: {
//     epsActual: number | null;
//     epsEstimate: number | null | undefined;
//     revenueActual: number | null;
//     revenueEstimate: number | null;
//   },
//   quarter?: number,
//   fiscalYear?: number
// ): Promise<FullExtractionResponse> {
//   logger.info(`\n${"=".repeat(70)}`);
//   logger.info(`📊 FULL EXTRACTION: ${symbol} (${companyName})`);
//   logger.info(`📅 Report Date: ${reportDate} | Quarter: Q${quarter || 'TBD'} ${fiscalYear || 'TBD'}`);
//   logger.info(`💰 Current Price: $${currentPrice || 'N/A'}`);
//   logger.info(`${"=".repeat(70)}`);

//   const q = quarter || Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
//   const yr = fiscalYear || new Date(reportDate).getFullYear();

//   // ============================================
//   // 🔥 CRITICAL: VERIFY PDF EXISTS FIRST!
//   // ============================================
//   logger.info(`\n🔍 Step 1: Verifying earnings report exists...`);
  
//   const pdfUrl = await findEarningsPDF(symbol, companyName, q, yr);
  
//   if (!pdfUrl) {
//     logger.error(`❌ CRITICAL: No earnings report found for ${symbol} Q${q} ${yr}`);
//     logger.error(`   This likely means the report hasn't been published yet`);
//     logger.error(`   🚫 ABORTING EXTRACTION - Cannot proceed without official report`);
    
//     throw new Error(`Earnings report not published yet - no PDF found for ${symbol} Q${q} ${yr}`);
//   }

//   logger.info(`✅ Report found: ${pdfUrl}`);
//   logger.info(`   Proceeding with extraction...\n`);

//   // ============================================
//   // STEP 2: CHECK FINNHUB DATA
//   // ============================================
//   const hasEPS = finnhubData?.epsActual !== null && finnhubData?.epsActual !== undefined;
//   const hasRevenue = finnhubData?.revenueActual !== null && finnhubData?.revenueActual !== undefined;
//   const hasFinnhubData = hasEPS && hasRevenue;

//   logger.info(`🔍 Data Source Check:`);
//   logger.info(`   Finnhub EPS: ${hasEPS ? '✅' : '❌'}`);
//   logger.info(`   Finnhub Revenue: ${hasRevenue ? '✅' : '❌'}`);
//   logger.info(`   Mode: ${hasFinnhubData ? 'Fast Path (Finnhub + PDF)' : 'Full PDF Extraction'}`);

//   let epsActual: number | null = null;
//   let epsEstimate: number | null = null;
//   let revenueActual: number | null = null;
//   let revenueEstimate: number | null = null;
//   let epsBeatPercent: number = 0;
//   let revBeatPercent: number = 0;

//   if (hasFinnhubData) {
//     epsActual = finnhubData.epsActual !== null ? Math.round(finnhubData.epsActual * 100) / 100 : null;
//     epsEstimate = finnhubData.epsEstimate ? Math.round(finnhubData.epsEstimate * 100) / 100 : epsActual;
//     revenueActual = finnhubData.revenueActual !== null ? Math.round(finnhubData.revenueActual) : null;
//     revenueEstimate = finnhubData.revenueEstimate ? Math.round(finnhubData.revenueEstimate) : revenueActual;

//     epsBeatPercent = epsEstimate && epsEstimate !== 0 && epsActual !== null
//       ? ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100
//       : 0;
//     revBeatPercent = revenueEstimate && revenueEstimate !== 0 && revenueActual !== null
//       ? ((revenueActual - revenueEstimate) / revenueEstimate) * 100
//       : 0;

//     logger.info(`\n✅ Using Finnhub Data:`);
//     logger.info(`   EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent >= 0 ? '+' : ''}${epsBeatPercent.toFixed(2)}%)`);
//     logger.info(`   Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent >= 0 ? '+' : ''}${revBeatPercent.toFixed(2)}%)`);
//   }

//   // ============================================
//   // STEP 3: FETCH API DATA (YoY, FCF, Margins)
//   // ============================================
//   logger.info(`\n📊 Fetching API Data...`);

//   const apiData = {
//     yoyEpsChange: null as number | null,
//     yoyRevenueChange: null as number | null,
//     netMargin: null as number | null,
//     operatingMargin: null as number | null,
//     fcf: null as number | null
//   };

//   // [Keep the existing API data fetching code - Finnhub Metrics + FMP]
//   // ... (same as before)

//   // ============================================
//   // STEP 4: AI EXTRACTION WITH VERIFIED PDF
//   // ============================================
//   logger.info(`\n🤖 Extracting from verified PDF...`);

//   const supplementPrompt = `
// You are extracting data from an official earnings report PDF.

// TARGET: ${symbol} (${companyName})
// QUARTER: Q${q} ${yr}
// VERIFIED PDF URL: ${pdfUrl}

// 🎯 CRITICAL INSTRUCTION:
// You MUST extract data ONLY from this specific PDF: ${pdfUrl}
// DO NOT use web search, news articles, or estimates!
// If you cannot find a metric in the PDF → return null

// ${hasFinnhubData ? `
// KNOWN DATA (from Finnhub - verified):
// - EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
// - Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)

// DO NOT extract EPS/Revenue - already have them!
// ` : `
// 🔴 MANDATORY: Extract EPS and Revenue from the PDF!

// 1. **EPS** (from PDF only!):
//    - Actual: Q${q} ${yr} diluted EPS
//    - Estimate: Consensus (if not in PDF → search "${symbol} Q${q} ${yr} EPS estimate" ONCE)
//    - Calculate beatPercent

// 2. **Revenue** (from PDF only!):
//    - Actual: Q${q} ${yr} total revenue (in dollars!)
//    - Estimate: Consensus (if not in PDF → search ONCE)
//    - Calculate beatPercent
// `}

// **EXTRACT FROM PDF:**

// 3. **Revenue YoY Growth** (QUARTERLY!):
//    - Find table: Q${q} ${yr} vs Q${q} ${yr - 1}
//    - Calculate: ((current - prior) / prior) * 100
//    - ⚠️ Must be quarterly, NOT annual!

// 4. **Net Margin Q${q}**:
//    - (Net Income / Revenue) * 100
//    - From quarterly table only!

// 5. **Operating Margin OR Efficiency Ratio**:
//    - Banks: Find "Efficiency Ratio"
//    - Others: (Operating Income / Revenue) * 100

// 6. **Cash from Operations Q${q}**:
//    - From Cash Flow Statement
//    - Operating Cash Flow (NOT Net Income!)
//    - Return in MILLIONS

// 7. **Guidance**: raised/lowered/maintained/unavailable

// 8. **Sentiment**: positive/neutral/negative (with reasoning in Hebrew)

// 9. **Highlights**: 2 specific achievements

// 10. **Concerns**: 2 specific risks

// OUTPUT FORMAT:
// {
//   "pdfUrl": "${pdfUrl}",
//   ${!hasFinnhubData ? `
//   "eps": {
//     "actual": <number>,
//     "estimate": <number>,
//     "beatPercent": <number>
//   },
//   "revenue": {
//     "actual": <number>,
//     "estimate": <number>,
//     "beatPercent": <number>
//   },
//   ` : ''}
//   "guidance": {...},
//   "sentiment": {...},
//   "highlights": [...],
//   "concerns": [...],
//   "pdfMetrics": {
//     "revenueYoY": <number> | null,
//     "netMargin": <number> | null,
//     "marginMetric": {...} | null,
//     "cashFromOperations": <number> | null
//   }
// }

// 🚨 RULES:
// 1. Extract ONLY from PDF ${pdfUrl}
// 2. If metric not in PDF → return null
// 3. Quarterly data ONLY (no TTM, no annual)
// 4. Real numbers only - NO estimates or calculations!

// Return ONLY valid JSON.
// `;

//   const MAX_RETRIES = 2; // Reduced - if PDF exists, should work quickly
//   let aiData: any = null;

//   for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
//     try {
//       logger.info(`   🔄 Attempt ${attempt}/${MAX_RETRIES}...`);

//       const aiRes = await callGrokAPI(
//         [
//           {
//             role: "system",
//             content: `You extract data from PDFs. You have verified that ${pdfUrl} exists. Extract ONLY from this PDF. Return ONLY valid JSON.`
//           },
//           {
//             role: "user",
//             content: supplementPrompt
//           }
//         ],
//         0.05, // Very low temperature - factual extraction only!
//         3000,
//         true
//       );

//       let cleanedRes = aiRes.trim()
//         .replace(/```json\n?/g, '')
//         .replace(/```\n?$/g, '')
//         .replace(/^```\n?/g, '')
//         .trim();

//       const tempAiData = JSON.parse(cleanedRes);

//       logger.info(`\n📎 ===== EXTRACTION RESULTS =====`);
//       logger.info(`   📄 PDF: ${tempAiData.pdfUrl || pdfUrl}`);
//       logger.info(`   ✅ Status: SUCCESS`);
//       logger.info(`📎 ===== END =====\n`);

//       aiData = tempAiData;
//       break;

//     } catch (err: any) {
//       logger.error(`   ❌ Attempt ${attempt} error: ${err.message}`);
//       if (attempt >= MAX_RETRIES) {
//         logger.error(`\n🚫 CRITICAL: Failed to extract from PDF after ${MAX_RETRIES} attempts`);
//         throw new Error(`PDF extraction failed: ${err.message}`);
//       }
//       await new Promise(resolve => setTimeout(resolve, 3000));
//     }
//   }

//   if (!aiData) throw new Error('PDF extraction failed');

//   // ============================================
//   // STEP 5: BUILD FINAL DATA
//   // ============================================
//   logger.info(`\n🔗 Building Final Data Object...`);

//   if (!hasFinnhubData && aiData.eps && aiData.revenue) {
//     epsActual = aiData.eps.actual;
//     epsEstimate = aiData.eps.estimate;
//     revenueActual = aiData.revenue.actual;
//     revenueEstimate = aiData.revenue.estimate;
//     epsBeatPercent = aiData.eps.beatPercent || 0;
//     revBeatPercent = aiData.revenue.beatPercent || 0;
    
//     logger.info(`   ✅ EPS: ${epsActual} vs ${epsEstimate} (PDF)`);
//     logger.info(`   ✅ Revenue: $${(revenueActual! / 1e9).toFixed(2)}B (PDF)`);
//   }

//   // Validate critical fields
//   if (epsActual === null || revenueActual === null) {
//     logger.error(`❌ CRITICAL: Missing EPS or Revenue after extraction!`);
//     throw new Error('Missing critical data (EPS/Revenue) - cannot proceed');
//   }

//   const data: FullExtractionResponse = {
//     symbol,
//     companyName,
//     reportDate,
//     eps: {
//       actual: epsActual!,
//       estimate: epsEstimate!,
//       beatPercent: epsBeatPercent,
//       beat: null,
//       source: hasFinnhubData ? "Finnhub" : "PDF"
//     },
//     revenue: {
//       actual: revenueActual!,
//       estimate: revenueEstimate!,
//       beatPercent: revBeatPercent,
//       beat: null,
//       source: hasFinnhubData ? "Finnhub" : "PDF"
//     },
//     guidance: aiData.guidance || { status: "unavailable", details: null },
//     sentiment: aiData.sentiment || { overall: "neutral", reasoning: null },
//     yoyGrowth: {
//       epsChange: apiData.yoyEpsChange,
//       revenueChange: aiData.pdfMetrics?.revenueYoY || apiData.yoyRevenueChange
//     },
//     cashFlow: {
//       freeCashFlow: aiData.pdfMetrics?.cashFromOperations ? aiData.pdfMetrics.cashFromOperations * 1e6 : apiData.fcf,
//       yoyChange: null
//     },
//     margins: {
//       netMargin: aiData.pdfMetrics?.netMargin || apiData.netMargin,
//       operatingMargin: aiData.pdfMetrics?.marginMetric?.value || apiData.operatingMargin,
//       trend: "stable",
//       isEfficiencyRatio: aiData.pdfMetrics?.marginMetric?.type === "efficiency_ratio"
//     },
//     highlights: aiData.highlights || ["Data extracted from earnings report", "See PDF for details"],
//     concerns: aiData.concerns || ["Data extracted from earnings report", "See PDF for details"],
//     marketData: {
//       price: currentPrice || null,
//       marketCap: null,
//       volume: null,
//       source: "FMP"
//     },
//     reportTime: "",
//     managementCommentary: null,
//     dataQuality: "high" as any,
//     aiRecommendation: "hold" as any
//   };

//   logger.info(`\n${"=".repeat(70)}`);
//   logger.info(`✅ EXTRACTION COMPLETE: ${symbol}`);
//   logger.info(`   📄 Source: ${pdfUrl}`);
//   logger.info(`   EPS: ${data.eps.actual} (${data.eps.beatPercent >= 0 ? '+' : ''}${data.eps.beatPercent.toFixed(2)}%)`);
//   logger.info(`   Revenue: $${(data.revenue.actual / 1e9).toFixed(2)}B (${data.revenue.beatPercent >= 0 ? '+' : ''}${data.revenue.beatPercent.toFixed(2)}%)`);
//   logger.info(`   YoY Revenue: ${data.yoyGrowth.revenueChange !== null ? data.yoyGrowth.revenueChange.toFixed(2) + '%' : 'N/A'}`);
//   logger.info(`${"=".repeat(70)}\n`);

//   return data;
// }



export async function fullExtraction(
  symbol: string,
  companyName: string,
  reportDate: string,
  currentPrice?: number,
  finnhubData?: {
    epsActual: number | null;
    epsEstimate: number | null | undefined;
    revenueActual: number | null;
    revenueEstimate: number | null;
  },
  quarter?: number,
  fiscalYear?: number
): Promise<FullExtractionResponse> {
  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`📊 FULL EXTRACTION: ${symbol} (${companyName})`);
  logger.info(`📅 Report Date: ${reportDate} | Quarter: Q${quarter || 'TBD'} ${fiscalYear || 'TBD'}`);
  logger.info(`💰 Current Price: $${currentPrice || 'N/A'}`);
  logger.info(`${"=".repeat(70)}`);

  const q = quarter || Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
  const yr = fiscalYear || new Date(reportDate).getFullYear();

  // ============================================
  // STEP 1: CHECK FINNHUB DATA
  // ============================================
  const hasEPS = finnhubData?.epsActual !== null && finnhubData?.epsActual !== undefined;
  const hasRevenue = finnhubData?.revenueActual !== null && finnhubData?.revenueActual !== undefined;
  const hasFinnhubData = hasEPS && hasRevenue;

  logger.info(`\n🔍 Step 1: Data Source Check`);
  logger.info(`   Finnhub EPS: ${hasEPS ? '✅' : '❌'}`);
  logger.info(`   Finnhub Revenue: ${hasRevenue ? '✅' : '❌'}`);
  logger.info(`   Mode: ${hasFinnhubData ? 'Finnhub + PDF Supplement' : 'Full PDF Extraction'}`);

  let epsActual: number | null = null;
  let epsEstimate: number | null = null;
  let revenueActual: number | null = null;
  let revenueEstimate: number | null = null;
  let epsBeatPercent: number = 0;
  let revBeatPercent: number = 0;

  if (hasFinnhubData) {
    epsActual = Math.round(finnhubData.epsActual! * 100) / 100;
    epsEstimate = finnhubData.epsEstimate ? Math.round(finnhubData.epsEstimate * 100) / 100 : epsActual;
    revenueActual = Math.round(finnhubData.revenueActual!);
    revenueEstimate = finnhubData.revenueEstimate ? Math.round(finnhubData.revenueEstimate) : revenueActual;

    epsBeatPercent = epsEstimate && epsEstimate !== 0
      ? ((epsActual! - epsEstimate) / Math.abs(epsEstimate)) * 100
      : 0;
    revBeatPercent = revenueEstimate && revenueEstimate !== 0
      ? ((revenueActual! - revenueEstimate) / revenueEstimate) * 100
      : 0;

    logger.info(`   ✅ EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent >= 0 ? '+' : ''}${epsBeatPercent.toFixed(2)}%)`);
    logger.info(`   ✅ Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent >= 0 ? '+' : ''}${revBeatPercent.toFixed(2)}%)`);
  } else {
    logger.info(`   ⚠️ Will extract EPS & Revenue from PDF`);
  }

  // ============================================
  // STEP 2: FETCH API DATA (Fallback)
  // ============================================
  logger.info(`\n📊 Step 2: Fetching API Fallback Data...`);

  const apiData = {
    yoyEpsChange: null as number | null,
    yoyRevenueChange: null as number | null,
    netMargin: null as number | null,
    operatingMargin: null as number | null,
    fcf: null as number | null
  };

  // Finnhub Metrics
  try {
    const metrics = await getFinnhubMetrics(symbol);
    if (metrics) {
      if (metrics.epsGrowthTTM !== null) {
        apiData.yoyEpsChange = metrics.epsGrowthTTM;
        logger.info(`   📊 YoY EPS: ${metrics.epsGrowthTTM.toFixed(2)}% (Finnhub TTM - fallback)`);
      }
      if (metrics.revenueGrowthTTM !== null && Math.abs(metrics.revenueGrowthTTM) <= 150) {
        apiData.yoyRevenueChange = metrics.revenueGrowthTTM;
        logger.info(`   📊 YoY Revenue: ${metrics.revenueGrowthTTM.toFixed(2)}% (Finnhub TTM - fallback)`);
      }
      if (metrics.netMarginTTM !== null) {
        apiData.netMargin = metrics.netMarginTTM;
        logger.info(`   📊 Net Margin: ${metrics.netMarginTTM.toFixed(2)}% (TTM - fallback)`);
      }
      if (metrics.operatingMarginTTM !== null) {
        apiData.operatingMargin = metrics.operatingMarginTTM;
        logger.info(`   📊 Operating Margin: ${metrics.operatingMarginTTM.toFixed(2)}% (TTM - fallback)`);
      }
      if (metrics.evFcfRatio && metrics.enterpriseValue) {
        apiData.fcf = (metrics.enterpriseValue * 1000000) / metrics.evFcfRatio;
        logger.info(`   📊 FCF: $${(apiData.fcf / 1e6).toFixed(2)}M (TTM - fallback)`);
      }
    }
  } catch (err: any) {
    logger.warn(`   ⚠️ Finnhub Metrics failed: ${err.message}`);
  }

  // FMP Quarterly
  try {
    const incomeStatement = await getIncomeStatement(symbol);
    if (incomeStatement && incomeStatement.length >= 5) {
      const currentQ = incomeStatement[0];
      const priorQ = incomeStatement[4];

      if (currentQ.revenue && priorQ.revenue && priorQ.revenue !== 0) {
        const yoyRev = ((currentQ.revenue - priorQ.revenue) / priorQ.revenue) * 100;
        if (Math.abs(yoyRev) <= 150) {
          apiData.yoyRevenueChange = yoyRev;
          logger.info(`   ✅ YoY Revenue: ${yoyRev.toFixed(2)}% (FMP Quarterly - preferred)`);
        }
      }

      if (currentQ.netIncome && currentQ.revenue && currentQ.revenue !== 0) {
        apiData.netMargin = (currentQ.netIncome / currentQ.revenue) * 100;
        logger.info(`   ✅ Net Margin: ${apiData.netMargin.toFixed(2)}% (FMP Q${q})`);
      }
      if (currentQ.operatingIncome && currentQ.revenue && currentQ.revenue !== 0) {
        apiData.operatingMargin = (currentQ.operatingIncome / currentQ.revenue) * 100;
        logger.info(`   ✅ Operating Margin: ${apiData.operatingMargin.toFixed(2)}% (FMP Q${q})`);
      }
    }
  } catch (err: any) {
    logger.warn(`   ⚠️ FMP Income Statement failed: ${err.message}`);
  }

  // FCF from FMP
  try {
    const cashFlow = await getCashFlow(symbol);
    if (cashFlow && cashFlow.length > 0) {
      const currentQ = cashFlow[0];
      if (currentQ.operatingCashFlow && currentQ.capitalExpenditure) {
        const fcf = currentQ.operatingCashFlow + currentQ.capitalExpenditure;
        if (Math.abs(fcf) <= 5e9) {
          apiData.fcf = fcf;
          logger.info(`   ✅ FCF: $${(fcf / 1e6).toFixed(2)}M (FMP Q${q})`);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`   ⚠️ FMP Cash Flow failed: ${err.message}`);
  }

  // ============================================
  // STEP 3: AI SUPPLEMENT (Original Working Prompt!)
  // ============================================
  logger.info(`\n🤖 Step 3: AI Supplement Extraction...`);

  const supplementPrompt = `
You are a financial data analyst extracting information from official earnings reports.

TARGET COMPANY: ${symbol} (${companyName})
REPORT DATE: ${reportDate}
QUARTER: Q${q} ${yr}

${hasFinnhubData ? `
KNOWN DATA (Already extracted - DO NOT EXTRACT AGAIN):
- EPS: ${epsActual} vs estimate ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
- Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs estimate $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)
` : `
⚠️ CRITICAL: EPS and Revenue NOT yet extracted - you MUST extract them!
`}

🎯 YOUR PRIMARY MISSION: Extract quarterly metrics from the official earnings PDF!

CRITICAL INSTRUCTIONS:

**STEP 1: Find the Investor Relations Website**
1. Search: "${companyName} investor relations"
2. Common URL patterns:
   - investors.${companyName}.com
   - investor.${companyName}.com
    - investors.${symbol}.com
   - investor.${symbol}.com
   - ir.{company}.com
   - {company}.com/investors
3. 🎯 SAVE THIS URL as "irWebsiteUrl"

**STEP 2: Find the Q${q} ${yr} Earnings Materials**
1. Look on the IR site for:
   - "Q${q} ${yr} Earnings Presentation" (PDF slides)
   - "Q${q} ${yr} Press Release" (PDF/HTML)
   - "Quarter Ended [date] Results"
2. 🎯 SAVE THE PDF/PRESS RELEASE URL as "pdfUrl"

🚨 MANDATORY: You MUST find and return BOTH URLs before extracting data!
If you cannot find the PDF → return error with "pdfUrl": null

**STEP 3: Extract Quarterly Metrics from PDF**

🔴 CRITICAL RULE: Extract ONLY from the QUARTERLY comparison table!
- Look for columns: "Q${q} ${yr}" and "Q${q} ${yr - 1}"
- IGNORE: "Full Year ${yr}", "FY ${yr}", "TTM", "Year to Date"
- If you see annual data → STOP and move to next section!

You MUST extract ALL of these metrics:

${!hasFinnhubData ? `
1. **EPS** (from PDF only!):
   - Actual: Q${q} ${yr} diluted EPS
   - Estimate: Wall Street consensus (if not in PDF → search "${symbol} Q${q} ${yr} EPS estimate")
   - Calculate beatPercent: ((actual - estimate) / |estimate|) * 100

2. **Revenue** (from PDF only!):
   - Actual: Q${q} ${yr} total revenue (in dollars, NOT billions!)
   - Estimate: Analyst consensus (if not in PDF → search "${symbol} Q${q} ${yr} revenue estimate")
   - Calculate beatPercent: ((actual - estimate) / estimate) * 100
` : ''}

3. **Revenue YoY Growth** (MANDATORY - QUARTERLY ONLY!):
   - Find table showing Q${q} ${yr} vs Q${q} ${yr - 1}
   - Calculate: ((current - prior) / prior) * 100
   - Return as number (e.g., 7.0 for +7%)
   
   Example:
   ✅ CORRECT: Q4 2025 Revenue $3.5B, Q4 2024 Revenue $3.3B → 6.1%
   ❌ WRONG: Full Year 2025 $14B vs Full Year 2024 $13B → 7.7%

4. **Net Margin Q${q}** (MANDATORY - CALCULATE IT):
   - Net Income Q${q} ${yr} / Revenue Q${q} ${yr} * 100
   - Return as number (e.g., 17.5 for 17.5%)
   
   Example:
   ✅ CORRECT: Q4 Net Income $500M / Q4 Revenue $3.5B = 14.3%
   ❌ WRONG: Annual Net Income $2B / Annual Revenue $14B = 14.3%

5. **Operating Margin OR Efficiency Ratio** (MANDATORY):
   
   🏦 FOR BANKS ONLY: Extract "Efficiency Ratio"
   - EXACT search: "Efficiency ratio" or "Adjusted efficiency ratio"
   - WHERE: "Quarterly Financial Highlights" or "Key Metrics" section
   - WHAT: A percentage like "62.3%"
   - ✅ If found: Return {"type": "efficiency_ratio", "value": 62.3, "source": "Page X, Section Y", "verified": true}
   - ❌ If NOT found: Return null (DO NOT estimate or calculate!)
   
   🏭 FOR NON-BANKS: Extract "Operating Margin"
   - Calculate from quarterly data or find stated margin
   - Return {"type": "operating_margin", "value": X, "source": "Page Y", "verified": true}

6. **Cash from Operations Q${q}** (MANDATORY - QUARTERLY ONLY):
   - Find "Cash Flow Statement" quarterly table
   - Look for: "Operating Cash Flow" or "Cash from Operations"
   - Q${q} ${yr} value (NOT annual, NOT TTM!)
   - Return in MILLIONS (e.g., 1500 for $1.5B)
   - 🛡️ VALIDATION: Quarterly FCF typically $100M-$3B (not $5B+!)
   
   ⚠️ DO NOT USE:
   - Net Income (wrong metric!)
   - Annual/TTM numbers

**STEP 4: Extract Qualitative Data**

7. **Guidance**:
   - Status: "raised" | "lowered" | "maintained" | "unavailable"
   - Details: One sentence in HEBREW explaining what changed

8. **Sentiment**:
   - Overall: "positive" | "neutral" | "negative"
   - Reasoning: One sentence in HEBREW explaining why

9. **Highlights**: Exactly 2 bullet points (specific achievements)

10. **Concerns**: Exactly 2 bullet points (specific risks/challenges)

OUTPUT FORMAT - Return ONLY this JSON:
{
  "irWebsiteUrl": "https://investors.{company}.com",
  "pdfUrl": "https://investors.{company}.com/.../Q${q}-${yr}-earnings.pdf" | null,
  ${!hasFinnhubData ? `
  "eps": {
    "actual": <number>,
    "estimate": <number>,
    "beatPercent": <number>
  },
  "revenue": {
    "actual": <number in dollars>,
    "estimate": <number in dollars>,
    "beatPercent": <number>
  },
  ` : ''}
  "guidance": {
    "status": "raised" | "lowered" | "maintained" | "unavailable",
    "details": "משפט בעברית" | null
  },
  "sentiment": {
    "overall": "positive" | "neutral" | "negative",
    "reasoning": "משפט בעברית" | null
  },
  "highlights": ["Achievement 1", "Achievement 2"],
  "concerns": ["Risk 1", "Risk 2"],
  "pdfMetrics": {
    "revenueYoY": 7.0 | null,
    "netMargin": 17.5 | null,
    "marginMetric": {
      "type": "efficiency_ratio" | "operating_margin",
      "value": 62.5,
      "source": "Page 12, Quarterly Highlights",
      "verified": true
    } | null,
    "cashFromOperations": 1500 | null
  },
  "dataSources": {
    "irWebsiteUrl": "https://...",
    "pdfUrl": "https://..." | null,
    "pageTitle": "Q${q} ${yr} Results",
    "searchUsed": "Which search worked"
  }
}

⚠️ CRITICAL RULES:
1. Always return irWebsiteUrl (even if PDF not found)
2. Always return dataSources object
3. Quarterly metrics ONLY (not TTM, not annual)
4. Real URLs only (user will verify them!)
5. If you cannot extract a metric → return null (don't estimate!)

🚨 IF EXTRACTION FAILS:
Return this error format (but still include URLs you found!):
{
  "error": "EXTRACTION_FAILED",
  "reason": "Specific reason why",
  "irWebsiteUrl": "https://..." (if found),
  "pdfUrl": "https://..." | null,
  "foundFields": ["list what you found"],
  "missingFields": ["list what's missing"],
  "searchesAttempted": ["searches you tried"],
  "dataSources": {
    "irWebsiteUrl": "https://...",
    "pdfUrl": null,
    "searchUsed": "..."
  }
}

🎯 SELF-CHECK BEFORE RETURNING:
- Did I find the PDF URL? (if no → set pdfUrl: null)
- Did I extract from QUARTERLY table? (not annual!)
- Are my numbers reasonable? (Revenue YoY <50%, FCF <$3B, etc.)

Return ONLY valid JSON - NO markdown, NO explanations, NO extra text.
`;

  const MAX_RETRIES = 3;
  let aiData: any = null;
  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`   🔄 AI Request Attempt ${attempt}/${MAX_RETRIES}...`);

      const aiRes = await callGrokAPI(
        [
          {
            role: "system",
            content: `You are a financial data extraction API. Always return irWebsiteUrl and dataSources, even if extraction fails. Return ONLY valid JSON with no markdown.`
          },
          {
            role: "user",
            content: supplementPrompt
          }
        ],
        0.1,
        2500,
        true
      );

      // Clean markdown
      let cleanedRes = aiRes.trim();
      if (cleanedRes.startsWith('```json')) {
        cleanedRes = cleanedRes.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
      }
      if (cleanedRes.startsWith('```')) {
        cleanedRes = cleanedRes.replace(/^```\n?/g, '').replace(/```\n?$/g, '');
      }
      cleanedRes = cleanedRes.trim();

      const tempAiData = JSON.parse(cleanedRes);

      // ============================================
      // DISPLAY EXTRACTION RESULTS
      // ============================================
      logger.info(`\n📎 ===== AI EXTRACTION RESULTS =====`);
      
      // URLs
      if (tempAiData.irWebsiteUrl || tempAiData.dataSources?.irWebsiteUrl) {
        const irUrl = tempAiData.irWebsiteUrl || tempAiData.dataSources?.irWebsiteUrl;
        logger.info(`   🏢 IR Website: ${irUrl}`);
      } else {
        logger.error(`   ❌ IR Website URL: NOT FOUND`);
      }

      if (tempAiData.pdfUrl || tempAiData.dataSources?.pdfUrl) {
        const pdfUrl = tempAiData.pdfUrl || tempAiData.dataSources?.pdfUrl;
        logger.info(`   📎 PDF Document: ${pdfUrl}`);
      } else {
        logger.warn(`   ⚠️ PDF URL: NOT FOUND`);
      }

      // Status
      if (tempAiData.error === "EXTRACTION_FAILED") {
        logger.error(`   ❌ Status: EXTRACTION FAILED`);
        logger.error(`   📝 Reason: ${tempAiData.reason}`);
        
        if (tempAiData.foundFields && tempAiData.foundFields.length > 0) {
          logger.info(`   ✅ Found: ${tempAiData.foundFields.join(', ')}`);
        }
        
        if (tempAiData.missingFields && tempAiData.missingFields.length > 0) {
          logger.warn(`   ❌ Missing: ${tempAiData.missingFields.join(', ')}`);
        }
      } else {
        logger.info(`   ✅ Status: SUCCESS`);
      }

      // Searches attempted
      if (tempAiData.searchesAttempted && tempAiData.searchesAttempted.length > 0) {
        logger.info(`   🔍 Searches: ${tempAiData.searchesAttempted.length} attempts`);
      }

      logger.info(`📎 ===== END EXTRACTION RESULTS =====\n`);

      // ============================================
      // 🔥 CRITICAL: VALIDATE PDF URL EXISTS!
      // ============================================
      const pdfUrl = tempAiData.pdfUrl || tempAiData.dataSources?.pdfUrl;
      
      if (!pdfUrl || pdfUrl === null || pdfUrl.toLowerCase().includes('not found')) {
        logger.error(`❌ CRITICAL: No PDF URL returned by AI`);
        logger.error(`   This means the earnings report is not published yet`);
        logger.error(`   🚫 ABORTING EXTRACTION`);
        
        throw new Error(`Earnings report not published - PDF URL not found for ${symbol} Q${q} ${yr}`);
      }

      logger.info(`✅ PDF URL validated: ${pdfUrl}`);
      logger.info(`   Proceeding with data extraction...\n`);

      // ============================================
      // VALIDATION & DECISION
      // ============================================
      
      if (tempAiData.error === "EXTRACTION_FAILED") {
        const foundCount = tempAiData.foundFields?.length || 0;
        const missingCount = tempAiData.missingFields?.length || 0;
        const hasUrls = !!(tempAiData.irWebsiteUrl || tempAiData.pdfUrl);

        // Accept if we have URLs or some data
        if (foundCount >= 2 || hasUrls) {
          logger.warn(`   ⚠️ Partial extraction - accepting with ${foundCount} fields + URLs`);
          
          // Convert error response to normal response
          delete tempAiData.error;
          delete tempAiData.reason;
          
          // Ensure dataSources exists
          if (!tempAiData.dataSources) {
            tempAiData.dataSources = {};
          }
          
          if (tempAiData.irWebsiteUrl) {
            tempAiData.dataSources.irWebsiteUrl = tempAiData.irWebsiteUrl;
          }
          if (tempAiData.pdfUrl) {
            tempAiData.dataSources.pdfUrl = tempAiData.pdfUrl;
          }
          
          aiData = tempAiData;
          logger.info(`   ✅ Continuing with partial data`);
          break;
        } else {
          lastError = tempAiData.reason || "Unknown extraction error";
          logger.warn(`   ⏳ Attempt ${attempt}/${MAX_RETRIES} failed - no usable data`);
          
          if (attempt < MAX_RETRIES) {
            logger.info(`   🔄 Retrying in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          } else {
            throw new Error(`Failed after ${MAX_RETRIES} attempts: ${lastError}`);
          }
        }
      }

      // Validate success response
      const hasGuidance = tempAiData.guidance?.status;
      const hasSentiment = tempAiData.sentiment?.overall;
      const hasHighlights = tempAiData.highlights?.length >= 2;
      const hasConcerns = tempAiData.concerns?.length >= 2;

      if (!hasGuidance || !hasSentiment || !hasHighlights || !hasConcerns) {
        lastError = `Incomplete qualitative data`;
        logger.warn(`   ⏳ Attempt ${attempt}/${MAX_RETRIES}: ${lastError}`);
        
        if (attempt < MAX_RETRIES) {
          logger.info(`   🔄 Retrying in 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        } else {
          logger.warn(`   ⚠️ Accepting incomplete qualitative data after ${MAX_RETRIES} attempts`);
        }
      }

      // Success!
      aiData = tempAiData;
      logger.info(`   ✅ Valid AI response received on attempt ${attempt}/${MAX_RETRIES}`);
      break;

    } catch (parseError: any) {
      lastError = parseError.message;
      logger.error(`   ❌ Attempt ${attempt}/${MAX_RETRIES} error: ${parseError.message}`);
      
      if (attempt < MAX_RETRIES) {
        logger.info(`   🔄 Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw new Error(`Failed to get valid AI response after ${MAX_RETRIES} attempts: ${lastError}`);
      }
    }
  }

  // Check if we got valid aiData
  if (!aiData) {
    throw new Error(`Failed to extract earnings data after ${MAX_RETRIES} attempts: ${lastError}`);
  }

  // ============================================
  // STEP 4: BUILD FINAL DATA OBJECT
  // ============================================
  logger.info(`\n🔗 Step 4: Building Final Data Object...`);

  // If AI extracted EPS/Revenue, use it
  if (!hasFinnhubData && aiData.eps && aiData.revenue) {
    epsActual = aiData.eps.actual;
    epsEstimate = aiData.eps.estimate;
    revenueActual = aiData.revenue.actual;
    revenueEstimate = aiData.revenue.estimate;
    epsBeatPercent = aiData.eps.beatPercent || 0;
    revBeatPercent = aiData.revenue.beatPercent || 0;
    
    logger.info(`   ✅ EPS: ${epsActual} vs ${epsEstimate} (from PDF)`);
    logger.info(`   ✅ Revenue: $${(revenueActual! / 1e9).toFixed(2)}B (from PDF)`);
  }

  // Validate critical fields
  if (epsActual === null || revenueActual === null) {
    logger.error(`❌ CRITICAL: Missing EPS or Revenue after extraction!`);
    throw new Error('Missing critical data (EPS/Revenue) - cannot proceed');
  }

  // Use PDF metrics if available, otherwise fallback to API
  const finalYoyRevenue = aiData.pdfMetrics?.revenueYoY !== null && aiData.pdfMetrics?.revenueYoY !== undefined
    ? aiData.pdfMetrics.revenueYoY
    : apiData.yoyRevenueChange;

  const finalNetMargin = aiData.pdfMetrics?.netMargin !== null && aiData.pdfMetrics?.netMargin !== undefined
    ? aiData.pdfMetrics.netMargin
    : apiData.netMargin;

  const finalOperatingMargin = aiData.pdfMetrics?.marginMetric?.value !== null && aiData.pdfMetrics?.marginMetric?.value !== undefined
    ? aiData.pdfMetrics.marginMetric.value
    : apiData.operatingMargin;

  const finalFcf = aiData.pdfMetrics?.cashFromOperations !== null && aiData.pdfMetrics?.cashFromOperations !== undefined
    ? aiData.pdfMetrics.cashFromOperations * 1e6
    : apiData.fcf;

  const pdfUrl = aiData.pdfUrl || aiData.dataSources?.pdfUrl || "Unknown";

  const data: FullExtractionResponse = {
    symbol,
    companyName,
    reportDate,
    eps: {
      actual: epsActual,
      estimate: epsEstimate,
      beatPercent: epsBeatPercent,
      beat: null,
      source: hasFinnhubData ? "Finnhub" : "PDF"
    },
    revenue: {
      actual: revenueActual,
      estimate: revenueEstimate,
      beatPercent: revBeatPercent,
      beat: null,
      source: hasFinnhubData ? "Finnhub" : "PDF"
    },
    guidance: aiData.guidance || { status: "unavailable", details: null },
    sentiment: aiData.sentiment || { overall: "neutral", reasoning: null },
    yoyGrowth: {
      epsChange: apiData.yoyEpsChange,
      revenueChange: finalYoyRevenue,
      revenueChangeType: aiData.pdfMetrics?.revenueYoY !== null ? "quarterly" : "TTM"
    },
    cashFlow: {
      freeCashFlow: finalFcf,
      yoyChange: null
    },
    margins: {
      netMargin: finalNetMargin,
      operatingMargin: finalOperatingMargin,
      trend: "stable",
      isEfficiencyRatio: aiData.pdfMetrics?.marginMetric?.type === "efficiency_ratio"
    },
    highlights: aiData.highlights || ["Data extracted from earnings report", "See PDF for details"],
    concerns: aiData.concerns || ["Data extracted from earnings report", "See PDF for details"],
    marketData: {
      price: currentPrice || null,
      marketCap: null,
      volume: null,
      source: "FMP"
    },
    reportTime: "",
    managementCommentary: null,
    dataQuality: "high" as any,
    aiRecommendation: "hold" as any
  };

  // ============================================
  // FINAL SUMMARY
  // ============================================
  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`✅ EXTRACTION COMPLETE: ${symbol}`);
  logger.info(`${"=".repeat(70)}`);
  logger.info(`📄 PDF: ${pdfUrl}`);
  logger.info(`📊 Quarter: Q${q} ${yr}`);
  logger.info(`─`.repeat(70));
  logger.info(`💰 EPS: ${data.eps.actual} vs ${data.eps.estimate} (${data.eps.beatPercent >= 0 ? '+' : ''}${data.eps.beatPercent.toFixed(2)}%) [${data.eps.source}]`);
  logger.info(`💵 Revenue: $${(data.revenue.actual / 1e9).toFixed(2)}B vs $${(data.revenue.estimate / 1e9).toFixed(2)}B (${data.revenue.beatPercent >= 0 ? '+' : ''}${data.revenue.beatPercent.toFixed(2)}%) [${data.revenue.source}]`);
  logger.info(`─`.repeat(70));
  logger.info(`📈 YoY Revenue: ${data.yoyGrowth.revenueChange !== null ? (data.yoyGrowth.revenueChange >= 0 ? '+' : '') + data.yoyGrowth.revenueChange.toFixed(2) + '%' : 'N/A'} (${data.yoyGrowth.revenueChangeType || 'N/A'})`);
  logger.info(`📊 Net Margin: ${data.margins.netMargin !== null ? data.margins.netMargin.toFixed(2) + '%' : 'N/A'}`);
  logger.info(`📊 ${data.margins.isEfficiencyRatio ? 'Efficiency Ratio' : 'Operating Margin'}: ${data.margins.operatingMargin !== null ? data.margins.operatingMargin.toFixed(2) + '%' : 'N/A'}`);
  logger.info(`💵 FCF: ${data.cashFlow.freeCashFlow !== null ? '$' + (data.cashFlow.freeCashFlow / 1e6).toFixed(2) + 'M' : 'N/A'}`);
  logger.info(`─`.repeat(70));
  logger.info(`📋 Guidance: ${data.guidance.status}`);
  logger.info(`💭 Sentiment: ${data.sentiment.overall}`);
  logger.info(`${"=".repeat(70)}\n`);

  return data;
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
  const epsDeviation = fullData.eps.estimate && fullData.eps.actual !== null
    ? (((fullData.eps.actual - fullData.eps.estimate) / Math.abs(fullData.eps.estimate)) * 100).toFixed(2)
    : "N/A";
  const revenueDeviation = fullData.revenue.estimate
    ? (((fullData.revenue.actual - fullData.revenue.estimate) / fullData.revenue.estimate) * 100).toFixed(2)
    : "N/A";

  // ✅ FIX: Safe access with defaults
  const yoyEpsGrowth = fullData.yoyGrowth?.epsChange !== null && fullData.yoyGrowth?.epsChange !== undefined
    ? `${fullData.yoyGrowth.epsChange.toFixed(2)}%`
    : "לא זמין";
  const yoyRevGrowth = fullData.yoyGrowth?.revenueChange !== null && fullData.yoyGrowth?.revenueChange !== undefined
    ? `${fullData.yoyGrowth.revenueChange.toFixed(2)}%${fullData.yoyGrowth.revenueChangeType === "TTM" ? " (TTM)" : ""}`
    : "לא זמין";
  const netMargin = fullData.margins?.netMargin !== null && fullData.margins?.netMargin !== undefined
    ? `${fullData.margins.netMargin.toFixed(2)}%`
    : "לא זמין";
const opMarginLabel = fullData.margins?.isEfficiencyRatio ? 'Efficiency' : 'Operating';
const opMargin = fullData.margins?.operatingMargin !== null && fullData.margins?.operatingMargin !== undefined
  ? `${fullData.margins.operatingMargin.toFixed(2)}%`
  : "לא זמין";

  // FCF - show dollar amount instead of "חיובי"/"שלילי"
  const fcfStatus = fullData.cashFlow?.freeCashFlow !== null && fullData.cashFlow?.freeCashFlow !== undefined
    ? `$${(fullData.cashFlow.freeCashFlow / 1e6).toFixed(2)}M`
    : 'לא זמין';
  const fcfTrend = fullData.cashFlow?.yoyChange !== null && fullData.cashFlow?.yoyChange !== undefined
    ? ` (${fullData.cashFlow.yoyChange > 0 ? '+' : ''}${fullData.cashFlow.yoyChange.toFixed(1)}% YoY)`
    : '';

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
YoY Growth: EPS ${yoyEpsGrowth} | Revenue ${yoyRevGrowth}
שולי רווח: Net ${netMargin} | ${opMarginLabel} ${opMargin}
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
- - Guidance: ${
  fullData.guidance.status === 'raised' ? '🔺 הועלה' : 
  fullData.guidance.status === 'lowered' ? '🔻 הופחת' : 
  fullData.guidance.status === 'maintained' ? '➡️ נשמר' : 
  'לא זמין'
}${fullData.guidance.details ? `
  📝 ${fullData.guidance.details}` : ''}
- שולי רווח: Net ${netMargin}% | ${opMarginLabel} ${opMargin}%
- Free Cash Flow: ${fcfStatus}${fcfTrend}
- YoY Growth: EPS ${yoyEpsGrowth}% | Revenue ${yoyRevGrowth}%
- שולי רווח: Net ${netMargin}% | ${opMarginLabel} ${opMargin}%
- סנטימנט הנהלה: ${fullData.sentiment.overall === 'positive' ? 'חיובי' : fullData.sentiment.overall === 'negative' ? 'שלילי' : 'ניטרלי'}${fullData.sentiment.reasoning ? `
  📝 ${fullData.sentiment.reasoning}` : ''}

⚖ ניקוד כולל: ${miraScore.totalScore}
⚖ סיווג סופי: ${miraScore.classification === 'POSITIVE' || miraScore.classification === 'VERY_POSITIVE' ? 'חיובי' : miraScore.classification === 'NEGATIVE' || miraScore.classification === 'VERY_NEGATIVE' ? 'שלילי' : 'ניטרלי'}
${miraScore.exceptions && miraScore.exceptions.length > 0 ? `
🔍 חריגים חכמים שהופעלו:
${miraScore.exceptions.map(e => `- ${e}`).join('\n')}
` : ''}
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
// STOCK PROCESSOR (ENGINE) - OPTIMIZED VERSION
// ============================================

interface TimeContext {
  detectionTime: Date;        // זמן הבדיקה (local/IST)
  reportingDateET: string;    // תאריך הדיווח לפי ארה"ב (YYYY-MM-DD)
  currentETHour: number;
  currentETMinute: number;  
  currentETTimeStr: string; // השעה בארה"ב עכשיו
}


function getTimeContext(): TimeContext {
  const now = new Date();
  
  const etTimeStr = now.toLocaleString('en-US', { 
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  
  const [dateStr, timeStr] = etTimeStr.split(', ');
  const [month, day, year] = dateStr.split('/');
  const reportingDateET = `${year}-${month}-${day}`;
  
  const [hourStr, minuteStr] = timeStr.split(':');
  
  return {
    detectionTime: now,
    reportingDateET,
    currentETHour: parseInt(hourStr),
    currentETMinute: parseInt(minuteStr),
    currentETTimeStr: timeStr  // ✅ שמור את "13:02" כמו שהוא!
  };
}
export class StockProcessor {
  private stocks: (StockProcessingState & { quarter?: number, fiscalYear?: number })[] = [];
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(private onComplete?: (stock: StockProcessingState) => void) {}

  /**
   * פונקציה חדשה: בודק אם מניה בטווח זמן סביר לבדיקה
   * @param windowStart - זמן התחלת החלון (HH:MM)
   * @param reportType - BMO או AMC
   * @returns true אם כדאי לבדוק את המניה עכשיו
   */
  private isWithinReasonableCheckWindow(windowStart: string, reportType: "BMO" | "AMC"): boolean {
    try {
      const now = new Date();
      const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const currentHour = nyTime.getHours();
      const currentMinute = nyTime.getMinutes();
      
      const [windowHour, windowMinute] = windowStart.split(':').map(Number);
      
      // המר לדקות מחצות
      const currentMinutesFromMidnight = currentHour * 60 + currentMinute;
      const windowMinutesFromMidnight = windowHour * 60 + windowMinute;
      
      // BMO: בדוק בין 05:00-12:00 (2 שעות לפני עד 2.5 אחרי)
      if (reportType === "BMO") {
        const checkStart = Math.max(5 * 60, windowMinutesFromMidnight - (WINDOW_BUFFER_HOURS * 60));
        const checkEnd = windowMinutesFromMidnight + (150); // 2.5 hours after
        return currentMinutesFromMidnight >= checkStart && currentMinutesFromMidnight <= checkEnd;
      }
      
      // AMC: בדוק בין 14:00-20:00 (2 שעות לפני עד 2 אחרי)
      if (reportType === "AMC") {
        const checkStart = Math.max(14 * 60, windowMinutesFromMidnight - (WINDOW_BUFFER_HOURS * 60));
        const checkEnd = windowMinutesFromMidnight + (WINDOW_BUFFER_HOURS * 60);
        return currentMinutesFromMidnight >= checkStart && currentMinutesFromMidnight <= checkEnd;
      }
      
      return true; // במקרה של ספק - בדוק
    } catch (error) {
      logger.error(`Error in isWithinReasonableCheckWindow: ${error}`);
      return true; // במקרה של שגיאה - בדוק
    }
  }

  /**
   * פונקציה מעודכנת: מעבד את כל המניות בכל iteration
   */
  private async processAllStocks(): Promise<void> {
    if (!this.isRunning) return;
    const timeContext = getTimeContext();

    logger.info(`\n${"=".repeat(60)}`);
  logger.info(`🔄 Starting new iteration - checking all stocks`);
  logger.info(`📅 Local Time (IL): ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
  logger.info(`📅 US Time (ET): ${timeContext.currentETTimeStr}`);
  logger.info(`📅 Reporting Date (US): ${timeContext.reportingDateET}`);
  logger.info(`${"=".repeat(60)}\n`);

    // סינון מניות שצריך לבדוק
 const stocksToCheck = this.stocks.filter((s) => {
  // דלג על מניות שכבר נשלחו
  if (s.sentToTelegram) return false;
  
  // דלג על מניות שכבר היו יותר מדי ניסיונות
  if (s.checkCount >= MAX_CHECK_ATTEMPTS) {
    if (s.checkCount === MAX_CHECK_ATTEMPTS) {
      logger.warn(`⚠️ ${s.symbol} - Reached max check attempts (${MAX_CHECK_ATTEMPTS}). Stopping checks.`);
    }
    return false;
  }

  // ✅ חדש: בדוק אם צריך לחכות לפני retry של extraction
  if (s.nextRetryTime) {
    const now = Date.now();
    const retryTime = new Date(s.nextRetryTime).getTime();
    
    if (now < retryTime) {
      const minutesLeft = Math.ceil((retryTime - now) / (60 * 1000));
      // Don't log every iteration - only occasionally
      if (minutesLeft % 5 === 0) {
        logger.debug(`⏰ ${s.symbol} - Waiting ${minutesLeft}m before extraction retry`);
      }
      return false; // לא בודקים עדיין
    } else {
      logger.info(`🔄 ${s.symbol} - Retry time reached, attempting extraction again (attempt ${(s.extractionAttempts || 0) + 1}/3)`);
      s.nextRetryTime = null; // נסה שוב עכשיו
    }
  }
  
  // בדוק רק מניות בטווח זמן סביר
  if (!this.isWithinReasonableCheckWindow(s.windowStart, s.reportType)) {
    return false;
  }
  
  return true;
});

    if (stocksToCheck.length === 0) {
      const totalSent = this.stocks.filter(s => s.sentToTelegram).length;
      const maxedOut = this.stocks.filter(s => s.checkCount >= MAX_CHECK_ATTEMPTS).length;
      const outOfWindow = this.stocks.length - totalSent - maxedOut - stocksToCheck.length;
      
      logger.info(`\n📊 No stocks to check in current iteration:`);
      logger.info(`   ✅ Already sent: ${totalSent}`);
      logger.info(`   🔒 Max attempts reached: ${maxedOut}`);
      logger.info(`   ⏰ Outside time window: ${outOfWindow}`);
      logger.info(`   📦 Total stocks: ${this.stocks.length}\n`);
      
      // אם כולם נשלחו - עצור
      if (totalSent === this.stocks.length) {
        logger.info("✅ All stocks processed! Stopping processor.");
        this.stop();
      }
      
      return;
    }

    logger.info(`🎯 Checking ${stocksToCheck.length} stocks in this iteration:\n`);
    stocksToCheck.forEach(s => {
      logger.info(`   • ${s.symbol} (${s.reportType} ${s.windowStart}) - Attempt ${s.checkCount + 1}/${MAX_CHECK_ATTEMPTS}`);
    });
    logger.info('');

    // לולאה על כל המניות
    for (const stock of stocksToCheck) {
      if (!this.isRunning) break;

      try {
        // דלוג אם כבר נשלח (בדיקה כפולה)
        if (stock.sentToTelegram) {
          logger.info(`⏭️ Skipping ${stock.symbol} - already sent to Telegram`);
          continue;
        }

        logger.info(`\n${"─".repeat(50)}`);
        logger.info(`📦 Processing ${stock.symbol} (${stock.reportType} ${stock.windowStart})`);
        logger.info(`   Attempt: ${stock.checkCount + 1}/${MAX_CHECK_ATTEMPTS}`);
        logger.info(`${"─".repeat(50)}`);

        stock.status = "checking";
        stock.checkCount++;
        stock.lastCheck = new Date().toISOString();
        
        // שלב 1: בדיקת Finnhub
        const finnhubHasData = await checkFinnhubUpdates(
          stock.symbol, 
          timeContext.reportingDateET
        );
        
        let reportConfirmed = false;

        if (finnhubHasData) {
          logger.info(`🚀 FINNHUB CONFIRMED: ${stock.symbol} has reported!`);
          reportConfirmed = true;
        } else {
          // שלב 2: Mini-check עם AI
          logger.info(`🔍 Running AI mini-check for ${stock.symbol}...`);
          const miniCheckResult = await miniCheck(
            stock.symbol, 
            stock.companyName, 
            stock.quarter, 
            stock.fiscalYear
          );
          
          if (miniCheckResult.result === "YES") {
            logger.info(`🤖 AI CONFIRMED: ${stock.symbol} has reported!`);
            reportConfirmed = true;
          } else {
            logger.info(`⏳ ${stock.symbol} - Not published yet (${miniCheckResult.result})`);
          }
        }
          let currentPrice = 0;

        // שלב 3: אם דוח אושר - עיבוד מלא
        if (reportConfirmed) {
          logger.info(`✅ Report confirmed for ${stock.symbol}! Starting full extraction...`);
          stock.status = "extracting";
          try {
              const quote = await getQuote(stock.symbol);
              currentPrice = quote?.price || 0;
              logger.info(`💰 Retrieved price for ${stock.symbol}: $${currentPrice}`);
            } catch (err: any) {
              logger.error(`❌ Failed to get price: ${err.message}`);
            }

           try {
    const fullData = await fullExtraction(
      stock.symbol,
      stock.companyName,
      timeContext.reportingDateET,
      currentPrice,
      stock.finnhubData,
      stock.quarter,
      stock.fiscalYear
    );

    // ✅ אם הגענו לכאן - extraction הצליח!
    stock.fullData = fullData;
    logger.info(`📊 Full extraction complete for ${stock.symbol}`);

    // ✅ חישוב Mira Score
    const miraScore = calculateDetailedScore(fullData);
    logger.info(`🎯 Mira Score for ${stock.symbol}: ${miraScore.totalScore} (${miraScore.classification})`);

    // ✅ ניתוח סופי
    const analysis = await finalAnalysis(fullData, miraScore);

    if (analysis) {
      stock.analysis = analysis;
      stock.status = "completed";
      logger.info(`✅ Analysis complete for ${stock.symbol}!`);

      // קריאה ל-callback
      if (this.onComplete) {
        await this.onComplete(stock);
      }
    } else {
      logger.error(`❌ Analysis failed for ${stock.symbol}`);
      stock.status = "error";
      stock.error = "Analysis generation failed";
    }
    
  } catch (extractionError: any) {
    // ✅ תפוס שגיאות extraction
    logger.error(`❌ Extraction error for ${stock.symbol}: ${extractionError.message}`);
    
    // ✅ בדוק אם זו שגיאת "data not ready"
    if (extractionError.message.includes('Incomplete extraction') || 
        extractionError.message.includes('AI extraction failed') ||
        extractionError.message.includes('Report may not be ready')) {
      
      stock.extractionAttempts = (stock.extractionAttempts || 0) + 1;
      stock.lastExtractionFailure = new Date().toISOString();
      
      if (stock.extractionAttempts >= 3) {
        // Give up after 3 attempts
        stock.status = "error";
        stock.error = `Failed ${stock.extractionAttempts} times: ${extractionError.message}`;
        logger.error(`🚫 ${stock.symbol}: Giving up after ${stock.extractionAttempts} extraction attempts`);
        logger.error(`   Final error: ${extractionError.message}`);
      } else {
        // Schedule retry in 20 minutes
        const retryDelay = 20 * 60 * 1000; // 20 minutes
        stock.nextRetryTime = new Date(Date.now() + retryDelay).toISOString();
        stock.status = "pending";
        
        logger.warn(`⏰ ${stock.symbol}: Data incomplete - will retry extraction`);
        logger.warn(`   Retry scheduled for: ${stock.nextRetryTime}`);
        logger.warn(`   Attempt ${stock.extractionAttempts}/3`);
        logger.warn(`   Reason: ${extractionError.message}`);
      }
    } else {
      // שגיאה אחרת (network, API, etc) - permanent
      stock.status = "error";
      stock.error = `Extraction error: ${extractionError.message}`;
      logger.error(`🚫 ${stock.symbol}: Permanent extraction error - will not retry`);
    }
  }
} else {
  // לא נמצא דוח - חזור ל-pending לניסיון הבא
  stock.status = "pending";
}

      } catch (error: any) {
        logger.error(`❌ Error processing ${stock.symbol}: ${error.message}`);
        stock.status = "error";
        stock.error = error.message;
      }

      // המתנה קצרה בין מניות (למנוע rate limits)
      if (this.isRunning) {
        await delay(DELAY_BETWEEN_STOCKS_MS);
      }
    }

    // סיכום iteration
    const summary = this.getSummary();
    logger.info(`\n${"=".repeat(60)}`);
    logger.info(`📊 Iteration Summary:`);
    logger.info(`   ✅ Completed: ${summary.completed}`);
    logger.info(`   📤 Sent to Telegram: ${summary.sent}`);
    logger.info(`   ⏳ Still pending: ${summary.pending}`);
    logger.info(`   🔄 Currently checking: ${summary.checking}`);
    logger.info(`   ❌ Errors: ${summary.errors}`);
    logger.info(`   📦 Total: ${summary.total}`);
    logger.info(`${"=".repeat(60)}\n`);
  }

  /**
   * פונקציה חדשה: מחזירה סיכום מצב
   */
  private getSummary() {
    return {
      total: this.stocks.length,
      completed: this.stocks.filter(s => s.status === 'completed').length,
      sent: this.stocks.filter(s => s.sentToTelegram).length,
      pending: this.stocks.filter(s => s.status === 'pending').length,
      checking: this.stocks.filter(s => s.status === 'checking').length,
      extracting: this.stocks.filter(s => s.status === 'extracting').length,
      errors: this.stocks.filter(s => s.status === 'error').length,
    };
  }

  getStatus() {
    return this.getSummary();
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
      sentToTelegram: s.sentToTelegram || false,
      // @ts-ignore
      quarter: s.quarter,
      // @ts-ignore
      fiscalYear: s.fiscalYear
    } as any));

    logger.info(`\n✅ Initialized processor with ${this.stocks.length} stocks`);
    logger.info(`   BMO stocks: ${this.stocks.filter(s => s.reportType === 'BMO').length}`);
    logger.info(`   AMC stocks: ${this.stocks.filter(s => s.reportType === 'AMC').length}\n`);
  }

  /**
   * מתחיל את המעבד - רץ iteration מיד ואז כל X דקות
   */
  start() {
    if (this.isRunning) {
      logger.warn("⚠️ Processor already running!");
      return;
    }

    this.isRunning = true;
    logger.info(`🚀 Starting Stock Processor...`);
    logger.info(`   Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);
    logger.info(`   Max attempts per stock: ${MAX_CHECK_ATTEMPTS}`);
    logger.info(`   Window buffer: ±${WINDOW_BUFFER_HOURS} hours\n`);

    // הרצה מיידית
    this.processAllStocks();

    // interval לבדיקות חוזרות
    this.checkInterval = setInterval(() => {
      this.processAllStocks();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * עוצר את המעבד
   */
  stop() {
    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info("🛑 Stock Processor stopped.");
  }
}

export default { morningIntelligence, miniCheck, fullExtraction, finalAnalysis, StockProcessor };//