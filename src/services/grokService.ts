import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger from "../utils/logger";
// ✅ שימוש ב-FMP לקבלת נתונים מדויקים במקום AI
import { getQuote } from "./stockService"; 
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
  temperature: number = 0.3,
  maxTokens: number = 4000,
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

async function verifyEarningsDate(symbol: string, date: string): Promise<boolean> {
    // השארנו את זה ככה למקרה שנרצה להחזיר
    return true; 
}

export async function morningIntelligence(date: string): Promise<MorningIntelligenceResponse> {
  logger.info(`🌅 Running Morning Intelligence (Hybrid) for ${date}...`);

  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY; 
  if (!FINNHUB_API_KEY) throw new Error("Missing FINNHUB_API_KEY");

  // const yesterday = new Date(date);
  // yesterday.setDate(yesterday.getDate() - 1);
  // const yesterdayStr = yesterday.toISOString().split('T')[0];

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

    if (symbol.includes(".") || symbol.length > 5 || !entry.hour) continue;

    try {
      const quote = await getQuote(symbol);
      
      if (!quote) {
          logger.warn(`❌ Skipping ${symbol}: FMP returned NULL (Rate limit?)`);
          await delay(1000);
          continue;
      }

      if (!quote.marketCap) {
          logger.warn(`❌ Skipping ${symbol}: No Market Cap data`);
          continue;
      }

      if (quote.marketCap < MIN_MARKET_CAP) {
          // logger.info(`❌ Skipping ${symbol}: Small Cap ($${(quote.marketCap/1e6).toFixed(0)}M)`);
          continue;
      }

      // if ((quote.volume || 0) < MIN_VOLUME) {
      //      // logger.info(`❌ Skipping ${symbol}: Low Volume (${(quote.volume || 0).toLocaleString()})`);
      //      continue;
      // }

      let reportType: "BMO" | "AMC" = entry.hour.toLowerCase() === 'bmo' ? "BMO" : "AMC";
      let windowStart = reportType === "BMO" ? "07:00" : "16:05";
      let windowEnd = reportType === "BMO" ? "09:30" : "20:00";
      
      const quarter = entry.quarter;
      const fiscalYear = entry.year;

      logger.info(` 💎 Found: ${symbol} (${quote.name}) | Q${quarter} ${fiscalYear} | Cap: $${(quote.marketCap / 1e9).toFixed(2)}B`);

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
          // @ts-ignore
          quarter: quarter, 
          // @ts-ignore
          fiscalYear: fiscalYear 
      });
      
      await delay(500); // דיליי למניעת חסימה

    } catch (err: any) {
      logger.error(`⚠️ CRASH processing ${symbol}: ${err.message}`);
    }
  }

  validatedStocks.sort((a, b) => b.marketCap - a.marketCap);
  logger.info(`✅ Final List: ${validatedStocks.length} stocks.`);
  return { date, stocks: validatedStocks };
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
    if (classification === "POSITIVE" && safePrice > 0) {
        return {
            direction: "LONG 🟢",
            entryPrice: Number((safePrice * 0.98).toFixed(2)),
            targetPrice: Number((safePrice * 1.05).toFixed(2)),
            stopPrice: Number((safePrice * 0.95).toFixed(2))
        };
    } else if (classification === "NEGATIVE" && safePrice > 0) {
        return {
            direction: "SHORT 🔴",
            entryPrice: Number((safePrice * 1.02).toFixed(2)),
            targetPrice: Number((safePrice * 0.95).toFixed(2)),
            stopPrice: Number((safePrice * 1.05).toFixed(2))
        };
    }
    return { direction: "NEUTRAL ⚪", entryPrice: 0, targetPrice: 0, stopPrice: 0 };
}

// ============================================
// 4. FULL EXTRACTION (FORCE SYMBOL) 🛑
// ============================================
export async function fullExtraction(symbol: string, companyName: string, reportDate: string): Promise<FullExtractionResponse> {
  logger.info(`📊 Extracting ${symbol}...`);
  const extractionPrompt = `
  EXTRACT DATA FOR: ${symbol} (${companyName})
  DATE: ${reportDate}

  REQUIRED JSON FIELDS:
  - eps: { beatPercent: number, actual: number, estimate: number }
  - revenue: { beatPercent: number, actual: number, estimate: number }
  - guidance: { status: "raised"|"lowered"|"maintained"|"unavailable" }
  - yoyGrowth: { epsChange: number, revenueChange: number }
  - cashFlow: { yoyChange: number }
  - margins: { trend: "improving"|"stable"|"declining" }
  - sentiment: { overall: "positive"|"neutral"|"negative" }
  - marketData: { price: number }
  - highlights: string[] (2 key points)
  - concerns: string[]
  
  Return ONLY valid JSON.
  `;
  
  try {
    const res = await callGrokAPI([{ role: "system", content: "Return valid JSON." }, { role: "user", content: extractionPrompt }], 0.2, 4000, true);
    const jsonText = extractJSON(res);
    const data = JSON.parse(jsonText);
    
    // 🛑 FORCE SYMBOL INJECTION - התיקון הקריטי!
    data.symbol = symbol;
    data.companyName = companyName;
    data.reportDate = reportDate;
    
    return data;
  } catch (e) { logger.error(`Extraction failed for ${symbol}`, e); throw e; }
}

// ============================================
// 5. FINAL ANALYSIS (TELEGRAM FORMAT)
// ============================================
export async function finalAnalysis(fullData: FullExtractionResponse, miraScore: MiraScore): Promise<FinalAnalysis> {
  logger.info(`📝 Generating Final Telegram Report for ${fullData.symbol}...`);

  const tradeParams = calculateTradeParams(fullData.marketData.price, miraScore.classification);
  
  const prompt = `
  You are Mira, an AI financial analyst.
  Create a COMPLETE, FORMATTED Telegram report in Hebrew.

  DATA:
  Symbol: ${fullData.symbol}
  EPS: ${fullData.eps.actual} (Est ${fullData.eps.estimate})
  Revenue: ${fullData.revenue.actual} (Est ${fullData.revenue.estimate})
  Guidance: ${fullData.guidance.status}
  Score: ${miraScore.totalScore}
  Trade: ${tradeParams.direction} (${tradeParams.entryPrice}/${tradeParams.targetPrice}/${tradeParams.stopPrice})
  Highlight: ${fullData.highlights[0] || "N/A"}

  OUTPUT FORMAT (Hebrew):
  📌 סימול: ${fullData.symbol}
  📊 תוצאות:
  • EPS: $${fullData.eps.actual} (צפי: $${fullData.eps.estimate})
  • הכנסות: $${(fullData?.revenue?.actual / 1e9).toFixed(2)}B (צפי: $${(fullData.revenue.estimate / 1e9).toFixed(2)}B)
  • תחזית: ${fullData.guidance.status}

  ⚖️ ניקוד: ${miraScore.totalScore}
  🏁 סיווג: ${miraScore.classification}

  📈 אסטרטגיה (${tradeParams.direction}):
  📍 כניסה: ${tradeParams.entryPrice}
  🎯 יעד: ${tradeParams.targetPrice}
  🛑 סטופ: ${tradeParams.stopPrice}

  💡 ${fullData.highlights[0]}

  🤖 סיכום: [1 sentence analysis]

  Return ONLY the text.
  `;

  try {
     const telegramMessage = await callGrokAPI(
         [{ role: "system", content: "Output text only." }, { role: "user", content: prompt }], 
         0.4, 
         1000, 
         false
     );

     // 🛑 LOG THE GENERATED MESSAGE
     logger.info(`📝 Generated Message Preview: ${telegramMessage.substring(0, 50)}...`);

     if (!telegramMessage || telegramMessage.trim().length === 0) {
         throw new Error("Grok returned empty summary");
     }

     return {
         symbol: fullData.symbol,
         date: fullData.reportDate,
         summary: telegramMessage,
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
            
            const fullData = await fullExtraction(stock.symbol, stock.companyName, new Date().toISOString().split("T")[0]);
            stock.fullData = fullData;
            
            const miraScore = calculateDetailedScore(fullData);
            logger.info(`🧮 Score for ${stock.symbol}: ${miraScore.totalScore} (${miraScore.classification})`);

            const analysis = await finalAnalysis(fullData, miraScore);
            
            stock.analysis = analysis;
            stock.status = "completed";
            
            if (this.onComplete) this.onComplete(stock);
            
        } else {
            logger.info(`⏳ Not published yet (Finnhub & AI both negative). Waiting.`);
            stock.status = "checking";
        }
    } catch (e) {
        logger.error(`Error ${stock.symbol}`, e);
        stock.status = "error";
    }
    
    if (this.isRunning) await delay(DELAY_BETWEEN_STOCKS_MS);
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