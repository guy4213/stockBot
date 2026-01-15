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
    revenueEstimate: null;
    epsEstimate: number | null | undefined; 
    symbol: string; 
    hour: string; 
    quarter: number; 
    year: number;
    epsActual?: number | null|undefined;
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



// ============================================
// 4. FULL EXTRACTION (FORCE SYMBOL) 🛑
// ============================================
// HELPER: Validate AI Response
// ============================================
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

// ============================================
// 4. FULL EXTRACTION & ANALYSIS
// ============================================
export async function fullExtraction(
  symbol: string,
  companyName: string,
  reportDate: string,
  currentPrice?: number,
  finnhubData?: {
    epsActual: number | null;
    epsEstimate: number | null|undefined;
    revenueActual: number | null;
    revenueEstimate: number | null;
  },
  quarter?: number,
  fiscalYear?: number
): Promise<FullExtractionResponse> {
  logger.info(`📊 Extracting ${symbol}...`);
  
  // ✅ אם יש נתוני Finnhub - השתמש בהם ישירות!
  if (finnhubData && 
      finnhubData.epsActual !== null && 
      finnhubData.revenueActual !== null) {
    
    logger.info(`🎯 Using Finnhub data directly for ${symbol}!`);

    // Round actual values to 2 decimal places for consistency
    const epsActual = finnhubData.epsActual !== null ? Math.round(finnhubData.epsActual * 100) / 100 : null;
    const revenueActual = finnhubData.revenueActual !== null ? Math.round(finnhubData.revenueActual) : null;

    // Use estimate if available, otherwise warn and use actual
    let epsEstimate = finnhubData.epsEstimate ? Math.round(finnhubData.epsEstimate * 100) / 100 : null;
    let revenueEstimate = finnhubData.revenueEstimate ? Math.round(finnhubData.revenueEstimate) : null;

    // 🛡️ VALIDATION: Check if estimates are missing
    if (!epsEstimate && epsActual !== null) {
      logger.warn(`   ⚠️ EPS estimate missing from Finnhub - using actual ${epsActual} (beat will be 0%)`);
      epsEstimate = epsActual;
    }
    if (!revenueEstimate && revenueActual !== null) {
      logger.warn(`   ⚠️ Revenue estimate missing from Finnhub - using actual $${(revenueActual / 1e9).toFixed(2)}B (beat will be 0%)`);
      revenueEstimate = revenueActual;
    }

    // Calculate beat percentages
    const epsBeatPercent = epsEstimate && epsEstimate !== 0 && epsActual !== null
      ? ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100
      : 0;

    const revBeatPercent = revenueEstimate && revenueEstimate !== 0 && revenueActual !== null && revenueEstimate !== null
      ? ((revenueActual - revenueEstimate) / revenueEstimate) * 100
      : 0;

    // 🛡️ VALIDATION: Warn if beat% is suspicious
    if (Math.abs(epsBeatPercent) > 50 && epsActual !== null && epsActual !== epsEstimate) {
      logger.warn(`   ⚠️ EPS beat ${epsBeatPercent.toFixed(2)}% is very large - verify estimate accuracy`);
    }
    if (Math.abs(revBeatPercent) > 20) {
      logger.warn(`   ⚠️ Revenue beat ${revBeatPercent.toFixed(2)}% is very large - verify estimate accuracy`);
    }

    logger.info(`📊 ${symbol} - EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)`);
    logger.info(`📊 ${symbol} - Revenue: $${revenueActual !== null ? (revenueActual / 1e9).toFixed(2) : 'N/A'}B vs $${revenueEstimate !== null ? (revenueEstimate / 1e9).toFixed(2) : 'N/A'}B (${revBeatPercent.toFixed(2)}%)`);

    // ✅ בנה את האובייקט עם נתונים אמיתיים
    const data: FullExtractionResponse = {
      symbol,
      companyName,
      reportDate,
      eps: {
        actual: epsActual!,
        estimate: epsEstimate!,
        beatPercent: epsBeatPercent,
        beat: null,
        source: ""
      },
      revenue: {
        actual: revenueActual!,
        estimate: revenueEstimate!,
        beatPercent: revBeatPercent,
        beat: null,
        source: ""
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
        price: currentPrice || null,
        marketCap: null,
        volume: null,
        source: ""
      },
      highlights: [],
      concerns: [],
      reportTime: "",
      managementCommentary: null,
      dataQuality: "high" as any,
      aiRecommendation: "buy" as any
    };

    // ✅ תחילה - נסה לחלץ YoY/FCF/Margins מ-Finnhub Metrics (הכי אמין!)
    logger.info(`📊 Fetching Finnhub Metrics for ${symbol}...`);
    try {
      const finnhubMetrics = await getFinnhubMetrics(symbol);
      if (finnhubMetrics) {
        // YoY Growth - EPS
        if (finnhubMetrics.epsGrowthTTM !== null && finnhubMetrics.epsGrowthTTM !== undefined) {
          data.yoyGrowth.epsChange = finnhubMetrics.epsGrowthTTM;
          logger.info(`   ✅ YoY EPS Growth (Finnhub): ${finnhubMetrics.epsGrowthTTM}%`);
        } else {
          // ⚠️ Finnhub מחזיר null בשני מקרים:
          // 1. המניה בהפסד (EPS שלילי)
          // 2. נתוני Q2 עדיין לא פורסמו בFinnhub
          logger.info(`   ⚠️ YoY EPS Growth unavailable from Finnhub - trying manual calculation from quarterly data...`);
          try {
            const earningsData = await getEarnings(symbol);
            if (earningsData && earningsData.length >= 5) {
              // הרבעון הנוכחי (אינדקס 0) vs אותו רבעון אשתקד (אינדקס 4)
              const currentQ = earningsData[0];
              const priorYearQ = earningsData[4]; // 4 רבעונים אחורה = שנה

              if (currentQ?.epsActual !== null && currentQ.epsActual !== undefined &&
                  priorYearQ?.epsActual !== null && priorYearQ.epsActual !== undefined) {
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
                logger.info(`   ✅ YoY EPS Growth (manual calc): ${yoyGrowth.toFixed(2)}% ($${prior} → $${current}) [${currentQ.date} vs ${priorYearQ.date}]`);
              } else {
                logger.warn(`   ⚠️ YoY EPS unavailable - missing Q2 or prior year EPS data (current: ${currentQ?.epsActual}, prior: ${priorYearQ?.epsActual})`);
              }
            } else {
              logger.warn(`   ⚠️ YoY EPS unavailable - not enough quarterly data (need 5 quarters, got ${earningsData?.length || 0})`);
            }
          } catch (err: any) {
            logger.warn(`   ⚠️ YoY EPS unavailable - calculation failed: ${err.message}`);
          }
        }

        // YoY Growth - Revenue (QUARTERLY comparison, not TTM!)
        // Try manual calculation from FMP quarterly data first
        logger.info(`   🔍 Calculating YoY Revenue Growth from quarterly data...`);
        try {
          const incomeStatement = await getIncomeStatement(symbol);
          if (incomeStatement && incomeStatement.length >= 5) {
            const currentQ = incomeStatement[0]; // Latest quarter
            const priorYearQ = incomeStatement[4]; // 4 quarters back = 1 year

            if (currentQ?.revenue !== null && priorYearQ?.revenue !== null && priorYearQ.revenue !== 0) {
              const current = currentQ.revenue;
              const prior = priorYearQ.revenue;
              const yoyRevGrowth = ((current - prior) / prior) * 100;

              // 🛡️ VALIDATION: Revenue YoY shouldn't exceed 150%
              if (Math.abs(yoyRevGrowth) > 150) {
                logger.warn(`   ⚠️ Revenue YoY Growth ${yoyRevGrowth.toFixed(2)}% is unrealistic - possibly wrong comparison`);
              } else {
                data.yoyGrowth.revenueChange = yoyRevGrowth;
                data.yoyGrowth.revenueChangeType = "quarterly";
                logger.info(`   ✅ YoY Revenue Growth (quarterly): ${yoyRevGrowth.toFixed(2)}% ($${(prior / 1e9).toFixed(2)}B → $${(current / 1e9).toFixed(2)}B) [${priorYearQ.date} vs ${currentQ.date}]`);
              }
            } else {
              logger.warn(`   ⚠️ Missing revenue data for YoY calculation (current: ${currentQ?.revenue}, prior: ${priorYearQ?.revenue})`);
            }
          } else {
            logger.warn(`   ⚠️ Not enough quarterly data for YoY Revenue (got ${incomeStatement?.length || 0} quarters)`);
          }
        } catch (err: any) {
          logger.warn(`   ⚠️ Could not calculate YoY Revenue manually: ${err.message}`);
        }

        // Fallback to Finnhub TTM if manual calculation failed
        if (data.yoyGrowth.revenueChange === null && finnhubMetrics.revenueGrowthTTM !== null && finnhubMetrics.revenueGrowthTTM !== undefined) {
          // 🛡️ VALIDATION: Revenue YoY shouldn't exceed 150% (unrealistic for most companies)
          if (Math.abs(finnhubMetrics.revenueGrowthTTM) > 150) {
            logger.warn(`   ⚠️ Revenue YoY Growth ${finnhubMetrics.revenueGrowthTTM}% (TTM) is unrealistic - rejecting`);
          } else {
            data.yoyGrowth.revenueChange = finnhubMetrics.revenueGrowthTTM;
            data.yoyGrowth.revenueChangeType = "TTM";
            logger.warn(`   ⚠️ YoY Revenue Growth (TTM fallback): ${finnhubMetrics.revenueGrowthTTM}% - Not quarterly comparison!`);
          }
        }

        // Margins - FALLBACK to TTM if Q2 unavailable
        if (finnhubMetrics.netMarginTTM !== null && finnhubMetrics.netMarginTTM !== undefined) {
          data.margins.netMargin = finnhubMetrics.netMarginTTM;
          logger.info(`   📊 Net Margin (TTM fallback): ${finnhubMetrics.netMarginTTM}%`);
        }
        if (finnhubMetrics.operatingMarginTTM !== null && finnhubMetrics.operatingMarginTTM !== undefined) {
          data.margins.operatingMargin = finnhubMetrics.operatingMarginTTM;
          logger.info(`   📊 Operating Margin (TTM fallback): ${finnhubMetrics.operatingMarginTTM}%`);
        }

        // FCF - FALLBACK calculation from EV/FCF
        if (finnhubMetrics.evFcfRatio && finnhubMetrics.enterpriseValue) {
          // EV / FCF = ratio → FCF = EV / ratio
          const fcf = (finnhubMetrics.enterpriseValue * 1000000) / finnhubMetrics.evFcfRatio;
          data.cashFlow.freeCashFlow = fcf;
          logger.info(`   📊 Free Cash Flow (TTM fallback): $${(fcf / 1e6).toFixed(2)}M`);
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

    // 🎯 PRIMARY: שליפת נתונים רבעוניים (Q2) מ-FMP - עדיפות על TTM!
    logger.info(`📊 Fetching Q2 quarterly data for ${symbol}...`);

    // בדיקה: האם נתוני FMP מעודכנים לדוח הזה?
    let fmpDataIsFresh = false;
    let needAIExtraction = {
      netMargin: true,
      operatingMargin: true,
      fcf: true
    };

    // 1️⃣ Margins - נסה לחלץ את הרבעון האחרון מ-Income Statement
    try {
      const incomeStatement = await getIncomeStatement(symbol);
      if (incomeStatement && incomeStatement.length > 0) {
        const latestQ = incomeStatement[0]; // הרבעון האחרון

        // בדיקת תאריך: האם הנתונים מתאימים לדוח?
        const latestQDate = new Date(latestQ.date);
        const reportDateObj = new Date(reportDate);
        const daysDiff = Math.abs((reportDateObj.getTime() - latestQDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysDiff <= 45) {
          // FMP מעודכן! (הנתונים בטווח של 45 ימים מהדוח)
          fmpDataIsFresh = true;
          logger.info(`   ✅ FMP data is fresh (${latestQ.date}, ${Math.round(daysDiff)} days from report)`);

          // חישוב Net Margin: (Net Income / Revenue) * 100
          if (latestQ.netIncome !== null && latestQ.revenue !== null && latestQ.revenue !== 0) {
            const netMargin = (latestQ.netIncome / latestQ.revenue) * 100;
            data.margins.netMargin = netMargin;
            needAIExtraction.netMargin = false;
            logger.info(`   ✅ Net Margin Q2: ${netMargin.toFixed(2)}% (${latestQ.calendarYear} ${latestQ.period})`);
          }

          // חישוב Operating Margin: (Operating Income / Revenue) * 100
          if (latestQ.operatingIncome !== null && latestQ.revenue !== null && latestQ.revenue !== 0) {
            const operatingMargin = (latestQ.operatingIncome / latestQ.revenue) * 100;
            data.margins.operatingMargin = operatingMargin;
            needAIExtraction.operatingMargin = false;
            logger.info(`   ✅ Operating Margin Q2: ${operatingMargin.toFixed(2)}%`);
          }
        } else {
          logger.warn(`   ⚠️ FMP data is stale (${latestQ.date}, ${Math.round(daysDiff)} days old) - will request AI extraction`);
        }
      } else {
        logger.warn(`   ⚠️ No income statement data available`);
      }
    } catch (err: any) {
      logger.warn(`   ⚠️ Could not fetch Q2 margins from FMP: ${err.message}`);
    }

    // 2️⃣ FCF - נסה לחלץ את הרבעון האחרון מ-Cash Flow Statement
    try {
      const cashFlow = await getCashFlow(symbol);
      if (cashFlow && cashFlow.length > 0) {
        const latestQ = cashFlow[0]; // הרבעון האחרון

        // בדיקת תאריך: האם הנתונים מתאימים לדוח?
        const latestQDate = new Date(latestQ.date);
        const reportDateObj = new Date(reportDate);
        const daysDiff = Math.abs((reportDateObj.getTime() - latestQDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysDiff <= 45 && fmpDataIsFresh) {
          // FCF = Operating Cash Flow - CapEx
          if (latestQ.operatingCashFlow !== null && latestQ.capitalExpenditure !== null) {
            const fcf = latestQ.operatingCashFlow + latestQ.capitalExpenditure; // capitalExpenditure הוא שלילי

            // 🛡️ VALIDATION: FCF shouldn't exceed $5B quarterly for most stocks
            if (Math.abs(fcf) > 5e9) {
              logger.warn(`   ⚠️ FCF too large ($${(fcf / 1e9).toFixed(2)}B) - possibly annual data, not quarterly! Rejecting.`);
              needAIExtraction.fcf = true; // Request AI to find correct quarterly FCF
            } else {
              data.cashFlow.freeCashFlow = fcf;
              needAIExtraction.fcf = false;
              logger.info(`   ✅ Free Cash Flow Q${Math.ceil((new Date(latestQ.date).getMonth() + 1) / 3)}: $${(fcf / 1e6).toFixed(2)}M (${latestQ.calendarYear} ${latestQ.period})`);

              // YoY FCF Change (אם יש נתון של אותו רבעון אשתקד)
              if (cashFlow.length >= 5) {
                const priorYearQ = cashFlow[4]; // 4 רבעונים אחורה
                if (priorYearQ.operatingCashFlow !== null && priorYearQ.capitalExpenditure !== null) {
                  const priorFcf = priorYearQ.operatingCashFlow + priorYearQ.capitalExpenditure;
                  if (priorFcf !== 0) {
                    const yoyChange = ((fcf - priorFcf) / Math.abs(priorFcf)) * 100;

                    // 🛡️ VALIDATION: YoY shouldn't exceed 200% (unrealistic)
                    if (Math.abs(yoyChange) > 200) {
                      logger.warn(`   ⚠️ FCF YoY change too extreme (${yoyChange.toFixed(2)}%) - possibly comparing wrong periods`);
                    } else {
                      data.cashFlow.yoyChange = yoyChange;
                      logger.info(`   ✅ FCF YoY Change: ${yoyChange.toFixed(2)}% ($${(priorFcf / 1e6).toFixed(2)}M → $${(fcf / 1e6).toFixed(2)}M)`);
                    }
                  }
                }
              }
            }
          }
        } else {
          logger.warn(`   ⚠️ Cash flow data is stale (${latestQ.date}, ${Math.round(daysDiff)} days old) - will request AI extraction`);
        }
      } else {
        logger.warn(`   ⚠️ No cash flow data available`);
      }
    } catch (err: any) {
      logger.warn(`   ⚠️ Could not fetch Q2 FCF from FMP: ${err.message}`);
    }

    // Margin Trend (עדכון לאחר שיש לנו נתוני Q2)
    if (data.margins.netMargin !== null) {
      data.margins.trend = data.margins.netMargin > 0 ? "improving" : "declining";
    }

    logger.info(`✅ Quarterly data extraction complete for ${symbol}`);

    // 🔍 Track missing data for AI extraction
    const missingDataSummary = [];
    if (needAIExtraction.netMargin) missingDataSummary.push('Net Margin');
    if (needAIExtraction.operatingMargin) missingDataSummary.push('Operating Margin');
    if (needAIExtraction.fcf) missingDataSummary.push('Free Cash Flow');
    if (data.yoyGrowth.epsChange === null) missingDataSummary.push('YoY EPS Growth');

    if (missingDataSummary.length > 0) {
      logger.info(`🔍 Missing quarterly data: ${missingDataSummary.join(', ')} - will request AI extraction`);
    } else {
      logger.info(`✅ All quarterly metrics available from APIs`);
    }

    // ✅ עכשיו תשתמש ב-AI רק לנתונים חסרים (guidance, sentiment, highlights)
    try {
      // Use quarter/fiscalYear from parameters (from stockReportingToday JSON)
      // If not provided, fallback to calculation from reportDate
      const q = quarter || Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
      const yr = fiscalYear || new Date(reportDate).getFullYear();
      logger.info(`📅 Report date ${reportDate} → Q${q} ${yr} earnings${quarter ? ' (from calendar)' : ' (calculated)'}`);
      
      const supplementPrompt = `
You are a financial data analyst extracting information from official earnings reports.

TARGET COMPANY: ${symbol} (${companyName})
REPORT DATE: ${reportDate}
QUARTER: Q${q} ${yr}

KNOWN DATA (Already extracted from Finnhub - DO NOT EXTRACT AGAIN):
- EPS: ${epsActual} vs estimate ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
- Revenue: $${revenueActual !== null ? (revenueActual / 1e9).toFixed(2) : 'N/A'}B vs estimate $${revenueEstimate !== null ? (revenueEstimate / 1e9).toFixed(2) : 'N/A'}B (${revBeatPercent.toFixed(2)}%)

CRITICAL INSTRUCTIONS:
1. **SEARCH STRATEGY** - Search by COMPANY NAME, not ticker symbol:

   STEP 1: Find the company's investor relations page
   - Search: "${companyName} investor relations"
   - Common patterns:
     * {companyname}.com/investors
     * {companyname}.com/investor-relations
     * investors.{companyname}.com
     * ir.{companyname}.com
   - For major banks: often {company}.com/about/investor-relations

   STEP 2: Once on IR site, look for Q${q} ${yr} materials (in order of priority):

   a) **PDF Earnings Presentation/Slides**:
      - Usually in: /earnings, /presentations, /quarterly-results, /events
      - Look for: "Q${q} ${yr} Earnings Presentation" or "Quarter Ended [date] Investor Presentation"

   b) **Earnings Press Release (PDF/HTML)**:
      - Usually in: /press-releases, /news-releases, /financial-results
      - Look for: "Reports Q${q} ${yr} Results" or "Q${q} Earnings"

   c) **8-K SEC Filing** (last resort):
      - sec.gov/cgi-bin/browse-edgar → search for ${symbol} → recent 8-K filings

   d) **Conference Call Transcript**:
      - Usually in: /events, /webcasts
      - Seeking Alpha also publishes transcripts

2. **PDF URLs - CRITICAL RULES**:
   - ✅ ONLY return URLs you ACTUALLY FOUND and VISITED
   - ❌ DO NOT invent/guess URLs (like "ir.wfc.com/static-files/xyz123.pdf")
   - ❌ DO NOT use placeholder URLs
   - If you cannot find the PDF URL, return null (it's better than a fake URL!)
   - The URL MUST be the direct link to the PDF or HTML page you extracted data from

3. **Search Priority**: PDFs contain the most accurate quarterly data!
   - Financial tables are usually on pages 10-15
   - Look for "Q${q} ${yr}" or "Quarter Ended" headers
   - Ignore "Full Year" or "FY ${yr}" sections

4. DO NOT use news articles, analyst reports, or third-party summaries (unless you can't find IR materials)
5. DO NOT confuse quarterly vs annual/TTM data:
   ❌ WRONG: "FY 2025 FCF: $4.6B" (annual)
   ✅ CORRECT: "Q4 FCF: $1.2B" (quarterly)

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

⚠️ **MANDATORY PDF EXTRACTION** (for validation and override of API data):

**STEP 1: Find the Quarterly Comparison Table in the PDF**
This is CRITICAL! Look for a table showing:
- Column 1: "Q${q} ${yr}" or "4Q25" or "Quarter Ended [date]"
- Column 2: "Q${q} ${yr - 1}" or "4Q24" (prior year same quarter)
This table is usually on pages 5-15 of the earnings presentation or press release.

**STEP 2: Extract ALL of the following metrics (MANDATORY, not optional!):**

5. **Revenue YoY Growth** (MANDATORY):
   a) Find "Total Revenue" or "Net Interest Income" (for banks) or "Total Income":
      - Q${q} ${yr}: $X.X billion
      - Q${q} ${yr - 1}: $Y.Y billion
   b) Calculate: ((current - prior) / prior) * 100
   c) Or the PDF states "up X%" or "increased X%" - use that!
   d) Return as number (e.g., 7.0 for +7%, -2.5 for -2.5%)

   ⚠️ CRITICAL: Must be QUARTERLY comparison, NOT "Full Year" or "TTM"!
   ⚠️ If table shows "Total revenue up 7%" → return 7.0

6. **Net Margin Q${q}** (MANDATORY - calculate it):
   a) From the quarterly table, find:
      - Net Income Q${q} ${yr}: $A.A billion
      - Revenue Q${q} ${yr}: $B.B billion
   b) Calculate: (Net Income / Revenue) * 100
   c) Return as number (e.g., 17.5 for 17.5%)
   d) For banks, this is usually 15-20%

   ⚠️ Must use Q${q} ${yr} quarterly numbers, NOT TTM!

7. **Operating Margin OR Efficiency Ratio** (MANDATORY):
   - **For BANKS**: Look for "Efficiency Ratio" (usually 55-70%)
     * This is: (Noninterest Expense / Total Revenue) * 100
     * The PDF usually shows this explicitly
   - **For other companies**: Look for "Operating Margin" or "EBIT Margin"
   - Return as number (e.g., 62.5 for 62.5% efficiency ratio)

   ⚠️ For banks, return efficiency ratio, NOT operating margin!

8. **Cash from Operations Q${q}** (MANDATORY):
   a) Look for "Cash Flow Statement" or "Cash Flow Summary" in the PDF
   b) Find "Cash from Operating Activities" or "Operating Cash Flow"
      - Q${q} ${yr}: $X.X billion
   c) Return as number in MILLIONS (e.g., 3500 for $3.5B)

   OR if available:

   **Free Cash Flow Q${q}**:
   - "Free Cash Flow": $X.X billion (quarterly)
   - OR calculate: Operating Cash Flow - Capital Expenditures
   - Return as number in MILLIONS

   ⚠️ CRITICAL:
   - ✅ CORRECT: "Q${q} Operating cash flow: $3.5B" → return 3500
   - ❌ WRONG: "Full Year ${yr} cash flow" ← התעלם מזה!
   - ❌ WRONG: "TTM" ← התעלם מזה!
   - If FCF not available, return Operating Cash Flow instead

**SUMMARY - You MUST extract ALL 4 metrics above (5-8):**
1. Revenue YoY Growth (quarterly comparison)
2. Net Margin (calculate from Net Income / Revenue)
3. Operating Margin or Efficiency Ratio (for banks: Efficiency Ratio)
4. Cash from Operations or FCF (quarterly)

These are MANDATORY extractions from the PDF to validate/override API data!

SEARCH QUERY EXAMPLES TO USE (use COMPANY NAME, not ticker):
1. First, find the IR page:
   - "${companyName} investor relations"
   - "${companyName} earnings"
   - "${companyName} quarterly results"

2. Then, search for specific quarter materials:
   - "${companyName} Q${q} ${yr} earnings presentation PDF"
   - "${companyName} Q${q} ${yr} press release"
   - "${companyName} Q${q} ${yr} investor presentation"
   - site:{domain-you-found} Q${q} ${yr}

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
  ],
  "pdfMetrics": {
    "revenueYoY": 7.0 | null,
    "netMargin": 17.5 | null,
    "efficiencyRatioOrOperatingMargin": 62.5 | null,
    "cashFromOperations": 3500 | null
  },
  "dataSources": {
    "pdfUrl": "https://full-url-to-pdf-presentation.pdf" | null,
    "pressReleaseUrl": "https://full-url-to-press-release" | null,
    "pagesReferenced": "10-15" | null,
    "extractionMethod": "PDF Slides" | "Press Release" | "Call Transcript" | "IR Website"
  }
}

⚠️ **CRITICAL - MANDATORY PDF REQUIREMENT**:
This is NOT optional! The response will be REJECTED if these requirements are not met:

1. **YOU MUST FIND THE OFFICIAL PDF**:
   - Search "${companyName} investor relations" → Find their IR website
   - Look for "Q${q} ${yr} earnings" materials on that site
   - The PDF is usually named like: "Q${q}-${yr}-earnings.pdf" or "fourth-quarter-${yr}-earnings.pdf"

2. **YOU MUST EXTRACT QUARTERLY METRICS FROM THE PDF**:
   - Find the quarterly comparison table (Q${q} ${yr} vs Q${q} ${yr - 1})
   - Extract ALL 4 required metrics: revenueYoY, netMargin, efficiency/operating, cashFromOps
   - If you cannot extract these → THE RESPONSE WILL BE REJECTED AND RETRIED

3. **REAL URLs ONLY** (User will verify these manually!):
   - ✅ CORRECT: "https://www.wellsfargo.com/assets/pdf/about/investor-relations/earnings/fourth-quarter-2025-earnings.pdf"
   - ❌ WRONG: Made-up URLs like "https://ir.wfc.com/static-files/abc123.pdf"
   - ❌ WRONG: Generic placeholders or null values
   - The user will click this URL - it MUST work!

4. **IF YOU CANNOT FIND THE PDF**:
   - Do NOT return generic "no data available" responses
   - Do NOT make up URLs or metrics
   - The system will automatically retry with a different search strategy
   - Try searching: "${companyName} ${reportDate} earnings", "${symbol} Q${q} ${yr} investor presentation"

⚠️ **THIS RESPONSE WILL BE VALIDATED**:
- Missing PDF URL → REJECTED & RETRY
- All metrics null → REJECTED & RETRY
- Generic "no data" responses → REJECTED & RETRY
- Made-up/non-working URLs → REJECTED & RETRY

Return ONLY valid JSON - NO markdown, NO explanations, NO extra text
`;

      // ✅ Retry Loop: Try up to 3 times to get valid AI response with PDF
      const MAX_RETRIES = 3;
      let aiData: any = null;
      let lastError: string = "";

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          logger.info(`🤖 Calling AI to supplement with guidance & sentiment (Attempt ${attempt}/${MAX_RETRIES})...`);
          logger.info(`🔍 AI will search: ir.${symbol.toLowerCase()}.com and ${companyName} Investor Relations`);

          const aiRes = await callGrokAPI(
            [
              {
                role: "system",
                content: `You are a financial data extraction API. YOUR RESPONSE WILL BE VALIDATED AND REJECTED IF INCOMPLETE.

MANDATORY REQUIREMENTS:
1. Find the official earnings PDF from ${companyName} investor relations
2. Extract quarterly metrics from the PDF (not TTM, not annual)
3. Return the REAL PDF URL (user will verify it works)
4. Return specific highlights/concerns (not generic "no data" responses)

If you cannot find the PDF or extract data → your response will be REJECTED and retried.
Return ONLY valid JSON with no markdown formatting or explanations.`
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

          const tempAiData = JSON.parse(cleanedRes);

          // 🛑 DEBUG: Print parsed JSON
          logger.info(`📥 ===== PARSED JSON OBJECT =====`);
          logger.info(JSON.stringify(tempAiData, null, 2));
          logger.info(`📥 ===== END OF PARSED JSON =====`);

          // ✅ VALIDATE: Check if AI found PDF and extracted data
          const validation = validateAIResponse(tempAiData, symbol);
          if (!validation.isValid) {
            lastError = validation.reason;
            logger.warn(`⚠️ Attempt ${attempt}/${MAX_RETRIES} failed: ${validation.reason}`);
            if (attempt < MAX_RETRIES) {
              logger.info(`🔄 Retrying in 5 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              continue;  // Try again
            } else {
              throw new Error(`Failed after ${MAX_RETRIES} attempts: ${lastError}`);
            }
          }

          // ✅ Valid response - save it and break the retry loop
          aiData = tempAiData;
          logger.info(`✅ Valid AI response received on attempt ${attempt}/${MAX_RETRIES}`);
          break;

        } catch (parseError: any) {
          lastError = parseError.message;
          logger.error(`❌ Attempt ${attempt}/${MAX_RETRIES} error: ${parseError.message}`);
          if (attempt < MAX_RETRIES) {
            logger.info(`🔄 Retrying in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            throw new Error(`Failed to get valid AI response after ${MAX_RETRIES} attempts: ${lastError}`);
          }
        }
      }

      // ✅ Check if we got valid aiData after all retries
      if (!aiData) {
        throw new Error(`Failed to extract earnings data after ${MAX_RETRIES} attempts: ${lastError}`);
      }

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

      // ✅ PDF Metrics - VALIDATION & OVERRIDE of API data
      if (aiData.pdfMetrics) {
        logger.info(`📄 ===== PDF METRICS (for validation) =====`);

        // 1. Revenue YoY Growth - Compare with API calculation
        if (aiData.pdfMetrics.revenueYoY !== null && aiData.pdfMetrics.revenueYoY !== undefined) {
          const pdfRevYoY = aiData.pdfMetrics.revenueYoY;
          const apiRevYoY = data.yoyGrowth.revenueChange;

          logger.info(`📊 Revenue YoY: PDF=${pdfRevYoY.toFixed(2)}%, API=${apiRevYoY !== null ? apiRevYoY.toFixed(2) : 'N/A'}%`);

          // If API is TTM or significantly different, use PDF
          if (data.yoyGrowth.revenueChangeType === "TTM" || apiRevYoY === null || Math.abs(pdfRevYoY - apiRevYoY) > 10) {
            logger.warn(`   🔄 OVERRIDING API Revenue YoY with PDF data (${pdfRevYoY.toFixed(2)}%)`);
            data.yoyGrowth.revenueChange = pdfRevYoY;
            data.yoyGrowth.revenueChangeType = "quarterly";
          }
        }

        // 2. Net Margin - Override if different or unavailable
        if (aiData.pdfMetrics.netMargin !== null && aiData.pdfMetrics.netMargin !== undefined) {
          const pdfNetMargin = aiData.pdfMetrics.netMargin;
          const apiNetMargin = data.margins.netMargin;

          logger.info(`📊 Net Margin: PDF=${pdfNetMargin.toFixed(2)}%, API=${apiNetMargin !== null ? apiNetMargin.toFixed(2) : 'N/A'}%`);

          if (apiNetMargin === null || Math.abs(pdfNetMargin - apiNetMargin) > 5) {
            logger.warn(`   🔄 OVERRIDING API Net Margin with PDF data (${pdfNetMargin.toFixed(2)}%)`);
            data.margins.netMargin = pdfNetMargin;
          }
        }

        // 3. Operating Margin / Efficiency Ratio - Override if available
        if (aiData.pdfMetrics.efficiencyRatioOrOperatingMargin !== null && aiData.pdfMetrics.efficiencyRatioOrOperatingMargin !== undefined) {
          const pdfOpMargin = aiData.pdfMetrics.efficiencyRatioOrOperatingMargin;
          const apiOpMargin = data.margins.operatingMargin;

          logger.info(`📊 Operating/Efficiency: PDF=${pdfOpMargin.toFixed(2)}%, API=${apiOpMargin !== null ? apiOpMargin.toFixed(2) : 'N/A'}%`);

          if (apiOpMargin === null || Math.abs(pdfOpMargin - apiOpMargin) > 5) {
            logger.warn(`   🔄 OVERRIDING API Operating Margin with PDF data (${pdfOpMargin.toFixed(2)}%)`);
            data.margins.operatingMargin = pdfOpMargin;
          }
        }

        // 4. Cash from Operations / FCF - Use if FCF unavailable
        if (aiData.pdfMetrics.cashFromOperations !== null && aiData.pdfMetrics.cashFromOperations !== undefined) {
          const pdfCashFlow = aiData.pdfMetrics.cashFromOperations * 1e6; // Convert millions to dollars

          logger.info(`📊 Cash from Operations: PDF=$${(pdfCashFlow / 1e9).toFixed(2)}B`);

          if (data.cashFlow.freeCashFlow === null) {
            logger.warn(`   🔄 Using PDF Cash from Operations (FCF unavailable): $${(pdfCashFlow / 1e6).toFixed(2)}M`);
            data.cashFlow.freeCashFlow = pdfCashFlow;
          }
        }

        logger.info(`📄 ===== END PDF METRICS =====`);
      } else {
        logger.warn(`⚠️ No pdfMetrics found in AI response - cannot validate API data`);
      }

      // ✅ Data Sources (PDF URLs for verification)
      if (aiData.dataSources) {
        logger.info(`📄 DATA SOURCES:`);
        if (aiData.dataSources.pdfUrl) {
          logger.info(`   📎 PDF: ${aiData.dataSources.pdfUrl}`);
        }
        if (aiData.dataSources.pressReleaseUrl) {
          logger.info(`   📰 Press Release: ${aiData.dataSources.pressReleaseUrl}`);
        }
        if (aiData.dataSources.pagesReferenced) {
          logger.info(`   📖 Pages: ${aiData.dataSources.pagesReferenced}`);
        }
        if (aiData.dataSources.extractionMethod) {
          logger.info(`   🔍 Method: ${aiData.dataSources.extractionMethod}`);
        }
      } else {
        logger.warn(`⚠️ No data sources returned by AI`);
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

  // Use quarter/fiscalYear from parameters (from stockReportingToday JSON)
  // If not provided, fallback to calculation from reportDate
  const q = quarter || Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
  const yr = fiscalYear || new Date(reportDate).getFullYear();

  const extractionPrompt = `
You are a financial data extraction bot. Your ONLY job is to return valid JSON.

SYMBOL: ${symbol}
COMPANY: ${companyName}
DATE: ${reportDate}
QUARTER: Q${q} ${yr}

CRITICAL INSTRUCTIONS:
1. **SEARCH STRATEGY** - Search by COMPANY NAME "${companyName}", not ticker:
   - First search: "${companyName} investor relations"
   - Find their IR website (usually: {company}.com/investors OR {company}.com/investor-relations)
   - For major banks: often {company}.com/about/investor-relations
   - Then search: "${companyName} Q${q} ${yr} earnings" on that site

2. Extract ONLY the following data from official sources (NOT news articles!)
3. If a field is unavailable, use null (NOT 0, NOT empty string)
4. Return ONLY valid JSON - NO explanations, NO markdown, NO extra text

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
שולי רווח: Net ${netMargin} | Operating ${opMargin}
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
        if (s.sentToTelegram) return false;  // ✅ Skip if already sent
        return true;
    });

    if (!stock) {
        const remaining = this.stocks.filter(s =>
            (s.status === "pending" || s.status === "checking") && !s.sentToTelegram
        ).length;
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
        // ✅ Double-check: Skip if already sent to Telegram
        if (stock.sentToTelegram) {
            logger.info(`⏭️ Skipping ${stock.symbol} - already sent to Telegram`);
            return;
        }

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
                stock.finnhubData,
                stock.quarter,      // ✅ הרבעון מ-JSON
                stock.fiscalYear    // ✅ שנת הכספים מ-JSON
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
          sentToTelegram: s.sentToTelegram || false,  // ✅ Preserve existing flag or default to false
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