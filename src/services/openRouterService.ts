import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger, { stockLog } from '../utils/structureLogger';
// ✅ שימוש ב-FMP ו-Finnhub לקבלת נתונים מדויקים במקום AI
import {
  getEarnings,
  getQuote,
  getFinnhubMetrics,
  getIncomeStatement,
  getCashFlow,
  runHardPreFilter,
  getEarningsCalendar
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
  Stock,
} from "../types/grok.types";
import fs from "fs";
import path from "path";
import { fetchContentWithJina } from "./contentExtractor";
import { calcIntradayPotential, calcMarketTruthOverride, calcSupercycle, calcTrendPotential, calculateDetailedScore, calculateTradeParams } from "./calculationService";
import { callGrokAPI, findEarningsPdf } from "./grokService";
dotenv.config({ quiet: true });

export const GROK_API_KEY = process.env.GROK_API_KEY;
export const MAX_API_RETRIES = 2;
export const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between iterations
export const DELAY_BETWEEN_STOCKS_MS = 5000; // 5 seconds between individual stock checks
export const MAX_CHECK_ATTEMPTS = 10; // Stop checking after 10 failed attempts
export const WINDOW_BUFFER_HOURS = 3; // Check stocks ±3 hours from their window
export const MIN_MARKET_CAP = 300_000_000; 
export const MIN_VOLUME = 1_000_000; 
interface ExtendedStock extends Stock {
    quarter?: number;
    fiscalYear?: number;
}
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


// ✅ הוסף את זה:
interface StockProcessingStateExtended extends StockProcessingState {
  isProcessing?: boolean;  // ⬅️ הוסף את זה!
  extractionAttempts?: number;
  lastExtractionFailure?: string;
  nextRetryTime?: string|null;
  
  // ✅ חדש: Cache של IR Portal - now matches IRPortal interface
  cachedIRPortal?: IRPortal | null;
  fiscalYear?: number; // <-- Add this line
quarter: number | undefined;
}

export interface IRPortal {
  url: string;
  domain: string;
  confidence: number;
  reason: string;
  verifiedAt?: string;  // ✅ Add optional timestamp for cache
}

interface IRCandidate {
  url: string;
  title: string;
  snippet: string;
}

interface EarningsDocument {
  url: string;
  type: 'press_release' | 'presentation' | '10q' | '10k' | 'unknown';
  title: string;
  publishDate?: string;
  verified: boolean;
}


/**
 * ✅ UPDATED: Call Grok API with new Responses API format
 * @param messages - Array of messages (system, user, assistant)
 * @param temperature - Randomness (0.0-2.0)
 * @param maxTokens - Max response length
 * @param enableWebSearch - Enable web_search tool (replaces old search_parameters)
 */
// ═══════════════════════════════════════════════════════════════
// API Calls - עדכון להתאים לחתימה הקיימת
// ═══════════════════════════════════════════════════════════════




// פונקציה לשמירת ה-IR Portal לדיסק באופן מיידי
function saveIrPortalToDisk(symbol: string, irPortal: any) {
  try {
    const filePath = path.join(__dirname, "../data/stocksReportingToday.json");
    
    // בדיקה שהקובץ קיים
    if (!fs.existsSync(filePath)) {
      logger.error(`❌ Cache file missing at: ${filePath}`);
      return;
    }

    // קריאה, עדכון ושמירה (סינכרוני כדי למנוע בעיות)
    const rawData = fs.readFileSync(filePath, "utf-8");
    const jsonData = JSON.parse(rawData);
    
    const stockIndex = jsonData.stocks.findIndex((s: any) => s.symbol === symbol);
    
    if (stockIndex !== -1) {
      // עדכון השדה
      jsonData.stocks[stockIndex].cachedIRPortal = irPortal;
      
      // כתיבה לדיסק
      fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2));
      logger.info(`💾 [${symbol}] IR Portal PERMANENTLY SAVED to JSON: ${irPortal.url}`);
    } else {
      logger.warn(`⚠️ [${symbol}] Stock not found in JSON, cannot save cache.`);
    }
  } catch (error: any) {
    logger.error(`❌ [${symbol}] Failed to write IR cache to disk: ${error.message}`);
  }
}


export async function callOpenRouterAPI(
  messages: any[],
  model: string = "google/gemini-2.0-flash-001", // Default to cheap/fast
  temperature: number = 0.1,
  maxTokens: number = 100
): Promise<string> {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is missing");

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: model,
          messages: messages,
          temperature: temperature,
          max_tokens: maxTokens,
          // Optional: headers for OpenRouter rankings
          // "HTTP-Referer": "https://your-site.com", 
          // "X-Title": "EarningsBot"
        },
        {
          headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 10000 // Fast timeout for validation
        }
      );

      return response.data.choices[0].message.content;

    } catch (error: any) {
      const isRateLimit = error.response?.status === 429;
      if (attempt === MAX_RETRIES || !isRateLimit) {
        throw new Error(`OpenRouter API Failed: ${error.message}`);
      }
      // Simple backoff for rate limits
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("OpenRouter max retries exceeded");
}

export async function verifyIRWithFlash(
  symbol: string,
  companyName: string,
  candidates: IRCandidate[] // אלו התוצאות ש-Serper כבר מצא לך
): Promise<IRPortal | null> {
  
  // 1. מכינים את הטקסט ל-AI (כמו שעשינו ב-MiniCheck)
  const candidatesText = candidates.map((c, i) => `
  [${i + 1}] URL: ${c.url}
  Title: ${c.title}
  Snippet: ${c.snippet}
  `).join('\n---\n');

  const prompt = `
  TASK: Identify the OFFICIAL Investor Relations (IR) website for:
  Company: ${companyName}
  Symbol: ${symbol}

  CANDIDATE URLs:
  ${candidatesText}

  RULES:
  1. Select the OFFICIAL corporate domain (e.g. investors.apple.com).
  2. Reject third-party sites (Yahoo Finance, Seeking Alpha, StreetInsider).
  3. Reject generic news sites.
  4. If unsure, return NULL.

  OUTPUT JSON ONLY:
  {
    "verifiedUrl": "THE_URL_HERE", 
    "confidence": 0.9,
    "reason": "Brief reason"
  }
  OR if none match:
  { "verifiedUrl": null, "confidence": 0, "reason": "No official site found" }
  `;

  try {
    // שולחים ל-Gemini Flash דרך OpenRouter
    // אין כאן חיפוש אינטרנטי! רק ניתוח טקסט!
    const res = await callOpenRouterAPI(
      [{ role: "user", content: prompt }],
      "google/gemini-2.0-flash-001",
      0.1,
      200
    );

    // ניקוי ה-JSON
    const cleanJson = res.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);

    if (result.verifiedUrl && result.confidence > 0.8) {
       return {
         url: result.verifiedUrl,
         domain: new URL(result.verifiedUrl).hostname,
         confidence: result.confidence,
         reason: result.reason
       };
    }
    return null;

  } catch (e: any) {
    logger.error(`❌ Flash Verification failed: ${(e as Error).message}`);
    return null;
  }
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }



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
//verification service(to anything that doesnt use open router)
// export async function morningIntelligence(date: string): Promise<MorningIntelligenceResponse> {
//   logger.info(`🌅 Running Morning Intelligence (Hybrid) for ${date}...`);

//   const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY; 
//   if (!FINNHUB_API_KEY) throw new Error("Missing FINNHUB_API_KEY");

//   logger.info(`📡 Calling Finnhub API (Range: ${date} - ${date})...`);
  
//   const response = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(
//     `https://finnhub.io/api/v1/calendar/earnings`, 
//     { params: { from: date, to: date, token: FINNHUB_API_KEY } }
//   );

//   const rawList = response.data.earningsCalendar || [];
//   logger.info(`✅ Finnhub returned ${rawList.length} raw entries.`);

//   const validatedStocks: ExtendedStock[] = [];
//   const processedSymbols = new Set<string>();

//   for (const entry of rawList) {
//     const symbol = entry.symbol.toUpperCase();
//     if (processedSymbols.has(symbol)) continue;
//     processedSymbols.add(symbol);

 

//     try {
//       // ✅ שלב 1: בדיקת שווי שוק ונפח (FMP Quote)
//       const quote = await getQuote(symbol);
      
//       if (!quote || !quote.marketCap || quote.marketCap < MIN_MARKET_CAP) {
//           logger.info(`⚠️ ${symbol} - Market cap too low ($${quote?.marketCap ? (quote.marketCap / 1e6).toFixed(1) + 'M' : 'N/A'}). Skipping.`);
//           continue;
//       }
      
//       if (!quote || !quote.volume || quote.volume < MIN_VOLUME) {
//           logger.info(`⚠️ ${symbol} - Volume too low (${quote?.volume ? (quote.volume / 1e6).toFixed(1) + 'M' : 'N/A'}). Skipping.`);
//           continue;
//       }

//       // ✅ שלב 2: אימות תאריך דיווח (רק אחרי שעבר שווי+נפח!)
//   const isDateValid = await verifyEarningsDate(symbol, date);
//   if (!isDateValid) {
//       logger.warn(`⚠️ ${symbol} - FMP date mismatch (not blocking - Finnhub is more current)`);
//       // ⚠️ DON'T skip - Finnhub is the source of truth for TODAY
//   }
//       let reportType: "BMO" | "AMC" = entry.hour.toLowerCase() === 'bmo' ? "BMO" : "AMC";
//       let windowStart = reportType === "BMO" ? "07:00" : "16:00";
//       let windowEnd = reportType === "BMO" ? "09:30" : "20:00";
      
//       logger.info(`💎 Found: ${symbol} (${quote.name}) | Q${entry.quarter} ${entry.year} | Cap: $${(quote.marketCap / 1e9).toFixed(2)}B | Volume: ${(quote.volume / 1e6).toFixed(1)}M`);

//       validatedStocks.push({
//           symbol: symbol,
//           companyName: quote.name || symbol,
//           reportType: reportType,
//           windowStart: windowStart,
//           windowEnd: windowEnd,
//           marketCap: quote.marketCap,
//           volume: quote.volume || 0,
//           confidence: 100,
//           sources: ["Finnhub", "FMP"],
//           quarter: entry.quarter,
//           fiscalYear: entry.year,
//           // ✅ שמור את הנתונים מ-Finnhub!
//           finnhubData: {
//               epsActual: entry.epsActual ?? null,
//               epsEstimate: entry.epsEstimate ?? null,
//               revenueActual: entry.revenueActual ?? null,
//               revenueEstimate: entry.revenueEstimate ?? null
//           }
//       });
      
//       await delay(500);

//     } catch (err: any) {
//       logger.error(`⚠️ CRASH processing ${symbol}: ${err.message}`);
//     }
//   }

//   validatedStocks.sort((a, b) => b.marketCap - a.marketCap);
//   logger.info(`✅ Final List: ${validatedStocks.length} stocks.`);
//   return { date, stocks: validatedStocks };
// }
  interface CachedStock {
  symbol: string;
  name: string;
  marketCap: number;
  volume: number;
  exchange: string;
  price: number;
  eps?: number;
  pe?: number;
}
let usStocksCache: Map<string, CachedStock> | null = null;

function loadUsStocksCache(): Map<string, CachedStock> {
  if (usStocksCache) return usStocksCache;

  try {
    const cachePath = path.join(process.cwd(), "src/data/us_stocks_cache.json");
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);

    const stocks: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.stocks)
      ? parsed.stocks
      : [];

    usStocksCache = new Map<string, CachedStock>(
      stocks.map(s => [s.symbol.toUpperCase(), s as CachedStock])
    );

    logger.info(`✅ US Stocks Cache loaded: ${usStocksCache.size} symbols`);
  } catch (err: any) {
    logger.error(`❌ Failed to load us_stocks_cache.json: ${err.message}`);
    usStocksCache = new Map();
  }

  return usStocksCache;
}

export async function morningIntelligence(date: string): Promise<MorningIntelligenceResponse> {
  logger.info(`🌅 Running Morning Intelligence (FMP-Primary + Cache + Finnhub/Grok) for ${date}...`);

  // ══════════════════════════════════════════
  // STEP 1: Load cache + FMP Calendar
  // ══════════════════════════════════════════
  const cache = loadUsStocksCache();

  logger.info(`📡 [Step 1] FMP Earnings Calendar (${date})...`);
  const fmpCalendar = await getEarningsCalendar(date, date);
  const fmpList: any[] = Array.isArray(fmpCalendar) ? fmpCalendar : [];
  logger.info(`✅ FMP returned ${fmpList.length} entries.`);

  if (fmpList.length === 0) {
    logger.warn(`⚠️ FMP returned 0 entries for ${date}.`);
    return { date, stocks: [] };
  }

  // Deduplicate symbols
  const symbolsRaw = [...new Set<string>(
    fmpList.map(e => ((e.symbol as string) ?? "").toUpperCase()).filter(Boolean)
  )];
  logger.info(`📋 Unique symbols: ${symbolsRaw.length}`);

  // ══════════════════════════════════════════
  // STEP 2: Filter via Cache — zero API calls
  // ══════════════════════════════════════════
  logger.info(`🗂️ [Step 2] Filtering via us_stocks_cache.json...`);

  const passedStocks: Array<{ symbol: string; cached: CachedStock }> = [];

  for (const symbol of symbolsRaw) {
    const cached = cache.get(symbol);

    if (!cached) {
      logger.info(`⚠️ ${symbol} - Not in US cache. Skipping.`);
      continue;
    }

    if (!cached.marketCap || cached.marketCap < MIN_MARKET_CAP) {
      logger.info(`⚠️ ${symbol} - MarketCap too low ($${
        cached.marketCap ? (cached.marketCap / 1e6).toFixed(1) + 'M' : 'N/A'
      }). Skipping.`);
      continue;
    }

    if (!cached.volume || cached.volume < MIN_VOLUME) {
      logger.info(`⚠️ ${symbol} - Volume too low (${
        cached.volume ? (cached.volume / 1e6).toFixed(1) + 'M' : 'N/A'
      }). Skipping.`);
      continue;
    }

    passedStocks.push({ symbol, cached });
  }

  logger.info(`✅ ${passedStocks.length}/${symbolsRaw.length} stocks passed filter.`);

  if (passedStocks.length === 0) return { date, stocks: [] };

  // ══════════════════════════════════════════
  // STEP 3: Finnhub — single call, build map
  // ══════════════════════════════════════════
  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
  const finnhubMap = new Map<string, FinnhubEarningsEntry>();

  if (FINNHUB_API_KEY) {
    try {
      logger.info(`📡 [Step 3] Finnhub Calendar (${date})...`);
      const finnhubResp = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(
        `https://finnhub.io/api/v1/calendar/earnings`,
        { params: { from: date, to: date, token: FINNHUB_API_KEY } }
      );
      const finnhubList = finnhubResp.data.earningsCalendar ?? [];
      logger.info(`✅ Finnhub returned ${finnhubList.length} entries.`);
      for (const e of finnhubList) {
        finnhubMap.set(e.symbol.toUpperCase(), e);
      }
    } catch (err: any) {
      logger.warn(`⚠️ Finnhub failed: ${err.message} — Grok fallback for all.`);
    }
  } else {
    logger.warn(`⚠️ FINNHUB_API_KEY missing — Grok fallback for all.`);
  }

  // ══════════════════════════════════════════
  // STEP 4: Collect unmatched → ONE Grok call
  // ══════════════════════════════════════════
  const unmatchedSymbols = passedStocks
    .map(s => s.symbol)
    .filter(sym => !finnhubMap.has(sym));

  let grokMap = new Map<string, "BMO" | "AMC">();
  if (unmatchedSymbols.length > 0) {
    logger.info(`📡 [Step 4] Grok batch for ${unmatchedSymbols.length} unmatched: ${unmatchedSymbols.join(", ")}`);
    grokMap = await askGrokReportTimeBatch(unmatchedSymbols, date);
  }

  // ══════════════════════════════════════════
  // STEP 5: Build final list
  // ══════════════════════════════════════════
  const validatedStocks: ExtendedStock[] = [];

  for (const { symbol, cached } of passedStocks) {
    const finnhubEntry = finnhubMap.get(symbol);

    let reportType: "BMO" | "AMC";
    let finnhubData: ExtendedStock["finnhubData"];
    let quarter: number | undefined;
    let fiscalYear: number | undefined;
    let sources: string[];

    if (finnhubEntry) {
      const hourRaw = (finnhubEntry.hour ?? "").toLowerCase().trim();
      reportType = hourRaw === "bmo" ? "BMO" : "AMC";
      quarter    = finnhubEntry.quarter;
      fiscalYear = finnhubEntry.year;
      finnhubData = {
        epsActual:       finnhubEntry.epsActual       ?? null,
        epsEstimate:     finnhubEntry.epsEstimate     ?? null,
        revenueActual:   finnhubEntry.revenueActual   ?? null,
        revenueEstimate: finnhubEntry.revenueEstimate ?? null,
      };
      sources = ["FMP", "Finnhub"];
    } else {
      reportType  = grokMap.get(symbol) ?? "AMC";
      finnhubData = { epsActual: null, epsEstimate: null, revenueActual: null, revenueEstimate: null };
      sources     = ["FMP", "Grok"];
    }

    const windowStart = reportType === "BMO" ? "07:00" : "16:00";
    const windowEnd   = reportType === "BMO" ? "09:30" : "20:00";

    logger.info(
      `💎 ${symbol} (${cached.name}) | ` +
      `$${(cached.marketCap / 1e9).toFixed(2)}B | ` +
      `${(cached.volume / 1e6).toFixed(1)}M vol | ` +
      `${reportType} | ${sources.join("+")}`
    );

    validatedStocks.push({
      symbol,
      companyName:  cached.name || symbol,
      reportType,
      windowStart,
      windowEnd,
      marketCap:    cached.marketCap,
      volume:       cached.volume,
      confidence:   finnhubEntry ? 100 : 80,
      sources,
      quarter,
      fiscalYear,
      finnhubData,
    });
  }

  validatedStocks.sort((a, b) => b.marketCap - a.marketCap);
  logger.info(`✅ Final List: ${validatedStocks.length} stocks.`);
  return { date, stocks: validatedStocks };
}
// ============================================
// Helper: Verify Earnings Date with FMP
// ============================================

//verification service(to anything that doesnt use open router)
// async function verifyEarningsDate(symbol: string, expectedDate: string): Promise<boolean> {
//     try {
//         logger.info(`🔍 Verifying earnings date for ${symbol} (expected: ${expectedDate})`);
        
//         const earnings = await getEarnings(symbol);
        
//         if (!earnings || earnings.length === 0) {
//             logger.warn(`⚠️ No FMP data for ${symbol} - trusting Finnhub date`);
//             return true;  // ✅ אם אין נתוני FMP - סמוך על Finnhub!
//         }

//         const sortedEarnings = earnings.sort((a, b) => 
//             new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
//         );

//         const recentEarnings = sortedEarnings.slice(0, 3);
        
//         logger.info(`📊 Latest 3 earnings for ${symbol}:`);
//         recentEarnings.forEach((e, i) => {
//             logger.info(`  ${i + 1}. Date: ${e.date} | Last Updated: ${e.lastUpdated}`);
//         });

//         const matchingEarning = recentEarnings.find(e => e.date === expectedDate);

//         if (matchingEarning) {
//             logger.info(`✅ MATCH FOUND: ${symbol} has earnings on ${expectedDate}`);
//             return true;
//         }

//         // ✅ חדש: בדוק אם ה-FMP data ישן מדי (>7 ימים)
//         const mostRecent = recentEarnings[0];
//         const daysSinceUpdate = Math.floor(
//             (new Date().getTime() - new Date(mostRecent.lastUpdated).getTime()) / (1000 * 60 * 60 * 24)
//         );

//         if (daysSinceUpdate > 7) {
//             logger.warn(`⚠️ FMP data is stale (${daysSinceUpdate} days old) - trusting Finnhub`);
//             return true;  // ✅ FMP לא מעודכן - סמוך על Finnhub
//         }

//         const closestDate = recentEarnings[0].date;
//         logger.warn(`❌ NO MATCH: ${symbol} FMP says ${closestDate}, Finnhub says ${expectedDate}`);
//         return false;  // ⚠️ רק אם FMP עדכני ולא תואם

//     } catch (error: any) {
//         logger.error(`❌ Error verifying earnings date for ${symbol}:`, error.message);
//         return true;  // ✅ במקרה של שגיאה - סמוך על Finnhub
//     }
// }

// ============================================
// Helper: Ask Grok for BMO/AMC when Finnhub has no match
// ============================================
async function askGrokReportTimeBatch(
  symbols: string[],
  date: string
): Promise<Map<string, "BMO" | "AMC">> {
  const result = new Map<string, "BMO" | "AMC">();
  if (symbols.length === 0) return result;

  try {
    const symbolList = symbols.join(", ");
    const messages: GrokMessage[] = [
      {
        role: "user",
        content: `For the following stocks reporting earnings on ${date}, determine if each report is released BEFORE market open (BMO) or AFTER market close (AMC).

Stocks: ${symbolList}

Return ONLY a JSON object with symbol as key and "BMO" or "AMC" as value. No explanation. Example:
{"AAPL":"AMC","MSFT":"BMO"}`
      }
    ];

    logger.info(`🤖 Grok batch BMO/AMC lookup for ${symbols.length} symbols: ${symbolList}`);
    const response = await callGrokAPI(messages, 0.1, 500, true);

    // Parse JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/s);
    if (!jsonMatch) {
      logger.warn(`⚠️ Grok batch: no JSON found in response — defaulting all to AMC`);
      symbols.forEach(s => result.set(s, "AMC"));
      return result;
    }

    const parsed: Record<string, string> = JSON.parse(jsonMatch[0]);

    for (const sym of symbols) {
      const val = (parsed[sym] ?? "").toUpperCase().trim();
      result.set(sym, val === "BMO" ? "BMO" : "AMC");
      logger.info(`   🤖 Grok resolved ${sym}: ${result.get(sym)}`);
    }

    // Fill any missing symbols with AMC
    for (const sym of symbols) {
      if (!result.has(sym)) {
        logger.warn(`   ⚠️ Grok didn't return result for ${sym} — defaulting AMC`);
        result.set(sym, "AMC");
      }
    }
  } catch (err: any) {
    logger.warn(`⚠️ askGrokReportTimeBatch failed: ${err.message} — defaulting all to AMC`);
    symbols.forEach(s => result.set(s, "AMC"));
  }

  return result;
}

export async function miniCheck(symbol: string, companyName: string, quarter?: number, fiscalYear?: number): Promise<MiniCheckResponse> {
  const dateObj = new Date();
  const now = dateObj.toISOString();
  const today = now.split("T")[0];
  
  const SERPER_API_KEY = process.env.SERPER_API_KEY;
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY is missing");
  const specificTerm = (quarter && fiscalYear) ? `Q${quarter} ${fiscalYear}` : "Quarterly";

  const query = `${symbol} ${companyName} ${specificTerm} earnings release`;
  let searchResults: any[] = [];
// ✅ ערכי default חכמים
  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);
  const targetQuarter = quarter ?? currentQuarter;
  const targetYear = fiscalYear ?? currentYear;
  const previousQuarter = targetQuarter === 1 ? 4 : targetQuarter - 1;
  const previousYear = targetQuarter === 1 ? targetYear - 1 : targetYear;
  
  try {
    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: query,
        num: 10,
        tbs: "qdr:w",
        gl: "us",
        hl: "en"
      },
      { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    
    searchResults = [...(response.data.news || []), ...(response.data.organic || [])];
    logger.info(`🔍 [MiniCheck] Serper returned ${searchResults.length} results for ${symbol}`);

  } catch (err: any) {
    logger.warn(`⚠️ [MiniCheck] Serper failed: ${err.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // FALLBACK: קווירי פשוט אם לא מצאנו כלום
  // ═══════════════════════════════════════════════════════════
  if (searchResults.length === 0) {
    logger.info(`🔄 [MiniCheck] Retrying with simpler query for ${symbol}`);
    try {
      const simpleQuery = `${symbol} earnings`;
      const retryResponse = await axios.post(
        'https://google.serper.dev/search',
        { q: simpleQuery, num: 8, gl: "us" },
        { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } }
      );
      
      searchResults = [...(retryResponse.data.news || []), ...(retryResponse.data.organic || [])];
      logger.info(`🔄 [MiniCheck] Retry found ${searchResults.length} results`);
    } catch (retryErr: any) {
      logger.error(`❌ [MiniCheck] Retry failed: ${retryErr.message}`);
      return { symbol, checkTime: now, result: "UNSURE" };
    }
  }

  if (searchResults.length === 0) {
    logger.warn(`⚠️ [MiniCheck] No results found for ${symbol}`);
    return { symbol, checkTime: now, result: "UNSURE" };
  }

  // ═══════════════════════════════════════════════════════════
  // 🔥 CRITICAL: פרומפט מחוזק שבודק תאריך ורבעון!
  // ═══════════════════════════════════════════════════════════
  
  const snippetsText = searchResults.map((r, i) => 
    `[${i+1}] Title: ${r.title}
Snippet: ${r.snippet}
Date: ${r.date || 'N/A'}
Link: ${r.link}`
  ).join('\n---\n');

const prompt = `
You are validating if a SPECIFIC earnings report has been published.

TARGET REPORT:
- Company: ${symbol} (${companyName})
- Quarter: ${specificTerm}
- Today's Date: ${today}

SEARCH RESULTS:
${snippetsText}

CRITICAL VALIDATION RULES:
1. Must mention "${specificTerm}" or "Q${targetQuarter} ${targetYear}" or "fourth quarter ${targetYear}"
2. Must have actual earnings numbers (EPS, Revenue)
3. Must be published recently (within last 7 days)
4. IGNORE old quarters (Q${previousQuarter} ${previousYear}, Q${targetQuarter} ${targetYear - 1}, etc.)
5. IGNORE previews, estimates, or "scheduled for" announcements

EXAMPLES OF WHAT TO ACCEPT:
✅ "${symbol} Reports Q${targetQuarter} ${targetYear} Earnings"
✅ "Fourth Quarter ${targetYear} Results"
✅ "Q${targetQuarter} ${targetYear} EPS: $X.XX, Revenue: $XXM"

EXAMPLES OF WHAT TO REJECT:
❌ "Q${previousQuarter} ${previousYear} Results" (wrong quarter)
❌ "Q${targetQuarter} ${targetYear - 1} Results" (wrong year)
❌ "${symbol} to Report Earnings on..." (preview, not actual)
❌ "Analysts Estimate..." (estimate, not actual)

QUESTION: Has ${symbol} published the ACTUAL ${specificTerm} earnings report?

Answer with ONE WORD ONLY: YES or NO
`;

  try {
    const res = await callOpenRouterAPI(
      [{ role: "user", content: prompt }],
      "google/gemini-2.0-flash-001",
      0.1,
      100  // ⬅️ יותר טוקנים למקרה שצריך
    );

    const cleanRes = res.trim().toUpperCase().replace(/[^A-Z]/g, '');
    let finalResult: MiniCheckResult = "UNSURE";

    if (cleanRes.includes("YES")) finalResult = "YES";
    else if (cleanRes.includes("NO")) finalResult = "NO";

    logger.info(`🤖 [MiniCheck] AI decision for ${symbol} ${specificTerm}: "${res.trim()}" → ${finalResult}`);

    stockLog.miniCheck(symbol, finalResult);
    return { symbol, checkTime: now, result: finalResult };

  } catch (e: any) { 
    logger.error(`❌ [MiniCheck] AI failed: ${e.message}`);
    return { symbol, checkTime: now, result: "UNSURE" }; 
  }
}



export async function findIRCandidates(
  symbol: string,
  companyName: string
): Promise<IRCandidate[]> {

  const SERPER_API_KEY = process.env.SERPER_API_KEY;
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY missing");
  }

  const cleanName = companyName
    .replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC)$/i, '')
    .trim();

  const cleanNameNormalized = cleanName.toLowerCase().replace(/\s+/g, '');

  const queries = [
    `${symbol} investor relations official site`,
    `"${cleanName}" investor relations website`,
    `${symbol} ${cleanName} IR site`,
    `${symbol} earnings investor relations`,
  ];

  const thirdPartyDomains = [
    'seekingalpha.com',
    'marketbeat.com',
    'zacks.com',
    'stocktitan.net',
    'alphaspread.com',
    'marketwatch.com',
    'yahoo.com',
    'finance.yahoo.com',
    'investing.com',
    'fool.com',
    'benzinga.com',
    'tipranks.com',
    'macrotrends.net',
    'stockanalysis.com',
    'sec.gov',
    'edgar',
    'nasdaq.com',
    'morningstar.com',
    'annualreports.com',
    'public.com',
    'financialmodelingprep.com',
    'youtube.com',
    'stockinsights.ai',
    'advfn.com',
    'wsj.com',
    'bloomberg.com',
    'reuters.com',
    'cnbc.com',
    'businesswire.com',
    'prnewswire.com',
    'globenewswire.com',
    'accessnewswire.com',
  ];

  const irCandidates: IRCandidate[] = [];
  const domainFallbacks: IRCandidate[] = [];

  // Track seen domains to avoid duplicates within fallbacks
  const seenDomains = new Set<string>();

  for (const query of queries) {
    logger.info(`   🔍 Query: "${query}"`);

    try {
      const response = await axios.post(
        'https://google.serper.dev/search',
        { q: query, num: 20, gl: 'us', hl: 'en' },
        {
          headers: {
            'X-API-KEY': SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      const results = response.data.organic || [];
      logger.info(`   📊 Serper returned ${results.length} results`);

      for (const result of results) {
        const url = result.link.toLowerCase();
        let domain: string;

        try {
          domain = new URL(result.link).hostname.toLowerCase();
        } catch {
          continue;
        }

        // בדיקה 1: סנן צד שלישי
        const isThirdParty = thirdPartyDomains.some(d => domain.includes(d));
        if (isThirdParty) {
          logger.info(`      ⛔ THIRD PARTY: ${domain}`);
          continue;
        }

        // בדיקה 2: האם זה URL ספציפי ל-IR?
        const isIRUrl =
          url.includes('/investor') ||
          url.includes('/ir/') ||
          url.includes('/ir-') ||
          domain.startsWith('ir.') ||
          domain.startsWith('investor.') ||
          domain.startsWith('investors.') ||
          domain.includes('.ir.') ||
          domain.includes('.investor.') ||
          domain.includes('.investors.');

        if (isIRUrl) {
          logger.info(`      ✅ IR URL: ${result.link}`);
          irCandidates.push({
            url: result.link,
            title: result.title,
            snippet: result.snippet || '',
          });
          continue;
        }

        // בדיקה 3: fallback — האם זה הדומיין הרשמי של החברה?
        const rootDomain = domain.replace(/^www\./, '');
        const looksLikeCompany =
          rootDomain.includes(cleanNameNormalized) ||
          rootDomain.includes(symbol.toLowerCase());

        if (looksLikeCompany && !seenDomains.has(rootDomain)) {
          seenDomains.add(rootDomain);
          // שמור את ה-root domain בלבד, לא sub-page ספציפי
          const rootUrl = `https://${domain}`;
          logger.info(`      🔄 COMPANY DOMAIN FALLBACK: ${rootUrl}`);
          domainFallbacks.push({
            url: rootUrl,
            title: result.title,
            snippet: result.snippet || '',
          });
        } else {
          logger.info(`      ❌ REJECTED: ${result.link}`);
        }
      }
    } catch (e: any) {
      logger.warn(`   ⚠️ Serper error: ${e.message}`);
    }
  }

  // Remove duplicates from irCandidates
  const uniqueIR = Array.from(
    new Map(irCandidates.map(c => [c.url.toLowerCase(), c])).values()
  );

  // אם נמצאו IR URLs ספציפיים — החזר אותם בלבד
  // אחרת — fallback לדומיין הרשמי של החברה
  const finalCandidates =
    uniqueIR.length > 0
      ? uniqueIR
      : domainFallbacks;

  logger.info(`\n📊 SUMMARY:`);
  logger.info(`   IR-specific URLs found: ${uniqueIR.length}`);
  logger.info(`   Company domain fallbacks: ${domainFallbacks.length}`);
  logger.info(
    uniqueIR.length > 0
      ? `   ✅ Using IR-specific URLs`
      : `   🔄 Falling back to company domain(s)`
  );

  if (finalCandidates.length > 0) {
    logger.info(`\n   🎯 Final candidates:`);
    finalCandidates.forEach((c, i) => {
      logger.info(`   ${i + 1}. ${c.url}`);
    });
  } else {
    logger.warn(`   ⚠️ No candidates found at all`);
  }

  return finalCandidates.slice(0, 10);
}

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
  fiscalYear?: number,
  cachedIRPortal?: IRPortal | null ,
    onIRPortalFound?: (portal: IRPortal) => void ,
    reportType: "BMO" | "AMC" = "BMO"   // ✅ הוסף בסוף עם default


): Promise<FullExtractionResponse> {
  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`📊 FULL EXTRACTION: ${symbol} (${companyName})`);
  logger.info(`📅 Report Date: ${reportDate} | Quarter: Q${quarter || 'TBD'} ${fiscalYear || 'TBD'}`);
  logger.info(`💰 Current Price: $${currentPrice || 'N/A'}`);
  logger.info(`${"=".repeat(70)}`);

  const q = quarter || Math.ceil((new Date(reportDate).getMonth() + 1) / 3);
  const yr = fiscalYear || new Date(reportDate).getFullYear();

  // ============================================
  // 🔥 NEW: STEP 0 - RELIABLE PDF DISCOVERY WITH SERPER
  // ============================================
  logger.info(`\n🔍 Step 0: Finding earnings report PDF using Serper.dev...`);
  
  //now free
const validatedPdfUrl = await findEarningsPdf(
    symbol,
    companyName,
    q,
    yr,
    reportDate,
    cachedIRPortal,
    onIRPortalFound  
  );

if (!validatedPdfUrl) {
  logger.error(`❌ CRITICAL: Could not find a valid earnings PDF for ${symbol} Q${q} ${yr}`);
  logger.error(`   Possible reasons:`);
  logger.error(`   1. Report not published yet`);
  logger.error(`   2. PDF not indexed by Google yet`);
  logger.error(`   3. Company uses non-standard URL patterns`);
  logger.error(`   🚫 ABORTING EXTRACTION`);
  
  throw new Error(`Earnings PDF not found for ${symbol} Q${q} ${yr} - report may not be published`);
}

 const epsBeatForPreFilter = finnhubData?.epsActual != null && finnhubData?.epsEstimate != null && finnhubData.epsEstimate !== 0
    ? ((finnhubData.epsActual - finnhubData.epsEstimate) / Math.abs(finnhubData.epsEstimate)) * 100
    : null;
const hardPreFilter = await runHardPreFilter(symbol, companyName, reportType, epsBeatForPreFilter,reportDate);




logger.info(`✅ Validated PDF URL: ${validatedPdfUrl}`);
  logger.info(`   Proceeding with extraction...\n`);

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
    yoyEpsChange:           null as number | null,
    yoyRevenueChange:       null as number | null,
    netMargin:              null as number | null,
    operatingMargin:        null as number | null,
    fcf:                    null as number | null,
    fcfQ4:                  null as number | null,  // ← חדש: FCF של שנה שעברה
    fcfYoyChange:           null as number | null,  // fallback אם אין AI FCF
    prevQuarterEpsChange:   null as number | null,
    prevQuarterRevChange:   null as number | null,
    commonStockRepurchased: null as number | null,
    commonDividendsPaid:    null as number | null,
    prevNetMargin: null as number | null,  

  };
 // Finnhub Metrics (fallback)
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

 // ── 2C: FMP Cash Flow — limit=5 ──────────────────────────────────
  // [0]=Q-1  [1]=Q-2  [2]=Q-3  [3]=Q-4  [4]=Q-5
  try {
    const cfRows = await getCashFlow(symbol, 5);
    if (cfRows && cfRows.length > 0) {
      const q1 = cfRows[0];
      const q4 = cfRows[3] ?? null; // ← Q-4: שנה שעברה של הרבעון הנוכחי
      const q5 = cfRows[4] ?? null;

      // Fallback FCF (Q-1)
      if (q1.operatingCashFlow != null && q1.capitalExpenditure != null) {
        const fcfQ1 = q1.operatingCashFlow + q1.capitalExpenditure;
        if (Math.abs(fcfQ1) <= 100e9) {
          apiData.fcf = fcfQ1;
          logger.info(`   ✅ FCF fallback (Q-1): $${(fcfQ1 / 1e6).toFixed(2)}M`);
        }
      }

      // FCF Q-4 — לשימוש ב-Step 4 להשוואה מול AI Q-0
      if (q4?.operatingCashFlow != null && q4?.capitalExpenditure != null) {
        const fcfQ4 = q4.operatingCashFlow + q4.capitalExpenditure;
        if (Math.abs(fcfQ4) <= 100e9) {
          apiData.fcfQ4 = fcfQ4;
          logger.info(`   ✅ FCF Q-4 (לשוואה עם AI): $${(fcfQ4 / 1e6).toFixed(2)}M`);
        }
      }

      // FCF YoY fallback: Q-1 vs Q-5 (יוחלף ב-Step 4 ע"י AI Q-0 vs Q-4)
      if (apiData.fcf != null && q5?.operatingCashFlow != null && q5?.capitalExpenditure != null) {
        const fcfQ5 = q5.operatingCashFlow + q5.capitalExpenditure;
        if (fcfQ5 !== 0 && Math.abs(fcfQ5) <= 100e9) {
          apiData.fcfYoyChange = ((apiData.fcf - fcfQ5) / Math.abs(fcfQ5)) * 100;
          logger.info(`   ✅ FCF YoY fallback: ${apiData.fcfYoyChange.toFixed(1)}% (Q-1 vs Q-5)`);
        }
      }

      // Stage 6: Buybacks / Capital Return
      apiData.commonStockRepurchased = q1.commonStockRepurchased ?? null;
      apiData.commonDividendsPaid    = q1.commonDividendsPaid    ?? null;
      logger.info(`   ✅ Buybacks: ${apiData.commonStockRepurchased ?? 'N/A'} | Dividends: ${apiData.commonDividendsPaid ?? 'N/A'}`);
    }
  } catch (err: any) {
    logger.warn(`   ⚠️ FMP Cash Flow failed: ${err.message}`);
  }
// ── 2D: FMP Income Statement — prevNetMargin ─────────────────────
try {
  const incRows = await getIncomeStatement(symbol, 2);
  if (incRows && incRows.length >= 2) {
    const prevRow = incRows[1]; // Q-2 — רבעון לפני הנוכחי
 const prevNetIncome = prevRow.netIncome ?? prevRow.bottomLineNetIncome ?? null;
const prevRevenue = prevRow.revenue ?? null;
if (prevNetIncome != null && prevRevenue != null && prevRevenue !== 0) {
  apiData.prevNetMargin = (prevNetIncome / prevRevenue) * 100;
  logger.info(`   ✅ Prev Net Margin (Q-2): ${apiData.prevNetMargin.toFixed(2)}%`);
}
  }
} catch (err: any) {
  logger.warn(`   ⚠️ FMP Income Statement failed: ${err.message}`);
}
// ── 2E: FMP Earnings History — YoY Acceleration ──────────────────
try {
  const today = new Date().toISOString().split("T")[0];
  const rawRows = await getEarnings(symbol); // שולף יותר כדי שיישאר 6 אחרי פילטר
  
  const earningsRows = (rawRows ?? []).filter(
    (r: any) => r.date < today && r.epsActual != null
  );
  // earningsRows[0] = הרבעון האחרון שדווח בפועל
  // earningsRows[1] = לפניו, earningsRows[5] = שנה שעברה של [1]

  if (earningsRows.length >= 6) {
    const q1 = earningsRows[1];
    const q5 = earningsRows[5];

    if (q1?.epsActual != null && q5?.epsActual != null && q5.epsActual !== 0) {
      apiData.prevQuarterEpsChange =
        ((q1.epsActual - q5.epsActual) / Math.abs(q5.epsActual)) * 100;
      logger.info(`   ✅ Prev EPS YoY (Q1 vs Q5): ${apiData.prevQuarterEpsChange.toFixed(1)}%`);
    }

    if (q1?.revenueActual != null && q5?.revenueActual != null && q5.revenueActual !== 0) {
      apiData.prevQuarterRevChange =
        ((q1.revenueActual - q5.revenueActual) / Math.abs(q5.revenueActual)) * 100;
      logger.info(`   ✅ Prev Rev YoY (Q1 vs Q5): ${apiData.prevQuarterRevChange.toFixed(1)}%`);
    }
  } else {
    logger.warn(`   ⚠️ Not enough earnings history for ${symbol} (${earningsRows.length} rows after filter)`);
  }
} catch (err: any) {
  logger.warn(`   ⚠️ Earnings History failed: ${err.message}`);
}

  // ============================================
  // STEP 3: AI SUPPLEMENT - NOW WITH VERIFIED PDF URL!
  // ============================================

logger.info(`\n🤖 Step 3: Fetching content via Jina → Gemini extraction...`);

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
let rawContent: string | null = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  rawContent = await fetchContentWithJina(validatedPdfUrl);
  
  if (rawContent !== null) break;
  
  if (attempt < MAX_ATTEMPTS) {
    logger.warn(`   🔄 Attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt)); // backoff
  }
}

if (rawContent === null) {
  throw new Error(`Content extraction failed for ${symbol} after ${MAX_ATTEMPTS} attempts`);
}

// ✅ הוסף לפני הפרומפט
const finnhubEpsEstimate = finnhubData?.epsEstimate ?? null;
const finnhubRevEstimate = finnhubData?.revenueEstimate ?? null;

const supplementPrompt = `
You are a professional financial data analyst extracting QUARTERLY earnings data from official press releases.

════════════════════════════════════════════════════════════════
📊 EXTRACTION MISSION
════════════════════════════════════════════════════════════════

TARGET COMPANY: ${symbol} (${companyName})
REPORT DATE: ${reportDate}
QUARTER: Q${q} ${yr}

⚠️ Extract data ONLY from the document text provided below.
⚠️ NEVER use external knowledge, TTM, or fallback values.

════════════════════════════════════════════════════════════════
🚨 RULE 1 — QUARTERLY DATA ONLY
════════════════════════════════════════════════════════════════

✅ ONLY use data labeled: Q${q} ${yr} | "Three months ended" | "Quarter ended"
❌ NEVER use: Annual | Full Year | TTM | YTD | Twelve months | Cumulative

════════════════════════════════════════════════════════════════
🚨 RULE 2 — EPS PRIORITY (CRITICAL)
════════════════════════════════════════════════════════════════

Wall Street analyst estimates are always compared to non-GAAP EPS.
Follow this priority order — use the FIRST type you find:

  Priority 1 → "Adjusted EPS" / "Adjusted earnings per share"
  Priority 2 → "Non-GAAP EPS" / "Non-GAAP earnings per share"
  Priority 3 → "Operating EPS" / "Operating earnings per share"
  Priority 4 → "Normalized EPS" / "Core EPS" / "Underlying EPS"
  Priority 5 → GAAP / Reported EPS (ONLY if none of the above exist)

Always use DILUTED per share, not basic.
Record which type you used in "epsType".

════════════════════════════════════════════════════════════════
🚨 RULE 3 — OPERATING MARGIN (CRITICAL)
════════════════════════════════════════════════════════════════

Operating Margin MUST be calculated from the document ONLY:

  Operating Margin = (Operating Income / Operating Revenue) * 100

  ✅ Use ONLY values from the "Three Months Ended" Q${q} ${yr} table
  ✅ Look for: "Income from operations" / "Operating income" / "Operating earnings"
  ✅ Divide by Operating Revenue from the SAME table
  ❌ NEVER use TTM, annual, or any external source
  ❌ If the document does NOT contain an income statement → return null

════════════════════════════════════════════════════════════════
🚨 RULE 4 — CASH FROM OPERATIONS (CRITICAL)
════════════════════════════════════════════════════════════════

  ✅ ONLY extract if document contains a Cash Flow Statement
  ✅ ONLY use "Three Months Ended" Q${q} ${yr} value
  ❌ If document has NO Cash Flow Statement → return null immediately
  ❌ NEVER use annual cash flow
  ❌ NEVER use values from external APIs or knowledge

════════════════════════════════════════════════════════════════
📋 DATA TO EXTRACT
════════════════════════════════════════════════════════════════

${!hasFinnhubData ? `
── EPS ──────────────────────────────────────────────────────
• actual:      Q${q} ${yr} EPS (per priority Rule 2 above)
• estimate:    ${finnhubEpsEstimate !== null
    ? `USE THIS EXACT VALUE: ${finnhubEpsEstimate} (Finnhub consensus) — DO NOT look in document`
    : 'not available, return null'}
• beatPercent: ${finnhubEpsEstimate !== null
    ? '((actual - estimate) / |estimate|) * 100'
    : 'null'}
• epsType:     exact label used e.g. "Adjusted EPS", "Operating EPS", "GAAP EPS"

── REVENUE ──────────────────────────────────────────────────
• actual:      Q${q} ${yr} revenue in dollars (not billions)
• For BANKS / REITs → use Net Interest Income instead of Total Revenue
• estimate:    ${finnhubRevEstimate !== null
    ? `USE THIS EXACT VALUE: ${finnhubRevEstimate} (Finnhub consensus) — DO NOT look in document`
    : 'not available, return null'}
• beatPercent: ${finnhubRevEstimate !== null
    ? '((actual - estimate) / estimate) * 100'
    : 'null'}

── YoY CALCULATIONS ─────────────────────────────────────────
• epsYoY:     ((Q${q}_${yr}_EPS - Q${q}_${yr-1}_EPS) / |Q${q}_${yr-1}_EPS|) * 100
• revenueYoY: ((Q${q}_${yr}_Rev - Q${q}_${yr-1}_Rev) / Q${q}_${yr-1}_Rev) * 100

` : `
ALREADY KNOWN — DO NOT RE-EXTRACT:
  EPS:     ${epsActual} vs ${epsEstimate} (${epsBeatPercent?.toFixed(2)}%)
  Revenue: ${revenueActual ? (revenueActual / 1e9).toFixed(2) + 'B' : 'N/A'} vs ${revenueEstimate ? (revenueEstimate / 1e9).toFixed(2) + 'B' : 'N/A'} (${revBeatPercent?.toFixed(2)}%)

EXTRACT ONLY:
• epsYoY:     ((Q${q}_${yr}_EPS - Q${q}_${yr-1}_EPS) / |Q${q}_${yr-1}_EPS|) * 100
• revenueYoY: ((Q${q}_${yr}_Rev - Q${q}_${yr-1}_Rev) / Q${q}_${yr-1}_Rev) * 100
`}

── NET MARGIN ────────────────────────────────────────────────
• Formula: (Net Income / Operating Revenue) * 100
• Source: "Three Months Ended" Q${q} ${yr} table ONLY
• If not available in document → null

── OPERATING MARGIN (follow Rule 3 above) ───────────────────
• Formula: (Operating Income / Operating Revenue) * 100
• Source: "Three Months Ended" Q${q} ${yr} table ONLY
• FOR BANKS ONLY: use Efficiency Ratio instead
• If income statement not in document → null

── CASH FROM OPERATIONS (follow Rule 4 above) ───────────────
• Source: Cash Flow Statement "Three Months Ended" Q${q} ${yr} ONLY
• If no Cash Flow Statement in document → null

── ALWAYS EXTRACT ────────────────────────────────────────────
• companyType: "REIT" | "Bank" | "Regular"
• guidance:    "raised" | "lowered" | "maintained" | "unavailable" + details in Hebrew
  ⚠️ details MUST be written in Hebrew. If source is in English → translate to Hebrew.
• sentiment:   "positive" | "neutral" | "negative" + reasoning in Hebrew
  ⚠️ reasoning MUST be written in Hebrew. If source is in English → translate to Hebrew.
• highlights:  exactly 2 specific achievements in Hebrew
• concerns:    exactly 2 specific risks in Hebrew

════════════════════════════════════════════════════════════════
📤 OUTPUT — RETURN ONLY THIS JSON, NO MARKDOWN
════════════════════════════════════════════════════════════════

{
  "companyType": "REIT" | "Bank" | "Regular",
  ${!hasFinnhubData ? `
  "eps": {
    "actual": <number> | null,
    "estimate": <number> | null,
    "beatPercent": <number> | null,
    "epsType": "<exact label from document>"
  },
  "revenue": {
    "actual": <number in dollars> | null,
    "estimate": <number in dollars> | null,
    "beatPercent": <number> | null,
    "revenueType": "net_interest_income" | "total_revenue"
  },
  ` : ''}
  "guidance": {
    "status": "raised" | "lowered" | "maintained" | "unavailable",
    "details": "<Hebrew string>" | null
  },
  "sentiment": {
    "overall": "positive" | "neutral" | "negative",
    "reasoning": "<Hebrew string>"
  },
  "highlights": ["<Hebrew>", "<Hebrew>"],
  "concerns": ["<Hebrew>", "<Hebrew>"],
  "pdfMetrics": {
    "epsYoY": <number> | null,
    "revenueYoY": <number> | null,
    "netMargin": <number> | null,
    "marginMetric": {
      "type": "operating_margin" | "efficiency_ratio",
      "value": <number>,
      "formula": "<Operating Income> / <Operating Revenue> * 100",
      "source": "Three Months Ended Q${q} ${yr}",
      "verified": true
    } | null,
    "cashFromOperations": <number in millions> | null
  }
}

════════════════════════════════════════════════════════════════
📄 DOCUMENT TEXT:
════════════════════════════════════════════════════════════════

${rawContent}
`;

  const MAX_RETRIES = 3;
  let aiData: any = null;
  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`   🔄 AI Request Attempt ${attempt}/${MAX_RETRIES}...`);

  const aiRes = await callOpenRouterAPI(
      [
        {
          role: "system",
          content: "You are a financial data extraction API. Return ONLY valid JSON with no markdown."
        },
        {
          role: "user",
          content: supplementPrompt
        }
      ],
      "google/gemini-2.0-flash-001",
      0.05,  // טמפרטורה נמוכה מאוד - עובדה, לא יצירתיות
      3000
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
      stockLog.extractionData(symbol, {
        eps: tempAiData.eps || null,
        revenue: tempAiData.revenue || null,
        pdfMetrics: tempAiData.pdfMetrics || null
      });
      // ============================================
      // DISPLAY EXTRACTION RESULTS
      // ============================================
      logger.info(`\n📎 ===== AI EXTRACTION RESULTS =====`);
      logger.info(`   📄 Source PDF: ${validatedPdfUrl}`);
      logger.info(`   ✅ Status: SUCCESS`);
      
      if (tempAiData.pdfMetrics) {
        logger.info(`   📊 Extracted Metrics:`);
        if (tempAiData.pdfMetrics.revenueYoY !== null) {
          logger.info(`      - Revenue YoY: ${tempAiData.pdfMetrics.revenueYoY}%`);
        }
        if (tempAiData.pdfMetrics.netMargin !== null) {
          logger.info(`      - Net Margin: ${tempAiData.pdfMetrics.netMargin}%`);
        }
        if (tempAiData.pdfMetrics.marginMetric) {
          logger.info(`      - ${tempAiData.pdfMetrics.marginMetric.type}: ${tempAiData.pdfMetrics.marginMetric.value}%`);
        }
        if (tempAiData.pdfMetrics.cashFromOperations !== null) {
          logger.info(`      - Cash from Ops: $${tempAiData.pdfMetrics.cashFromOperations}M`);
        }
      }
      
      logger.info(`📎 ===== END EXTRACTION RESULTS =====\n`);

      // Validate response
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
      aiData.pdfUrl = validatedPdfUrl; // Ensure we use the validated URL
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
    epsEstimate = aiData.eps.estimate ?? finnhubEpsEstimate; 
    revenueActual = aiData.revenue.actual;
    revenueEstimate = aiData.revenue.estimate ?? finnhubRevEstimate;
 // ✅ חשב beatPercent מחדש — חשוב כי ג'מיני אולי קיבל estimate מפינהאב
  epsBeatPercent = epsEstimate && epsEstimate !== 0
    ? ((epsActual! - epsEstimate) / Math.abs(epsEstimate)) * 100
    : 0;
  revBeatPercent = revenueEstimate && revenueEstimate !== 0
    ? ((revenueActual! - revenueEstimate) / revenueEstimate) * 100
    : 0;

  logger.info(`   ✅ EPS: ${epsActual} vs ${epsEstimate} (from PDF + Finnhub estimate)`);
  logger.info(`   ✅ Revenue: $${(revenueActual! / 1e9).toFixed(2)}B (from PDF + Finnhub estimate)`);
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

  const finalYoyEps = aiData.pdfMetrics?.epsYoY !== null && aiData.pdfMetrics?.epsYoY !== undefined
  ? aiData.pdfMetrics.epsYoY
  : apiData.yoyEpsChange;

const finalNetMargin = aiData.pdfMetrics?.netMargin !== null && aiData.pdfMetrics?.netMargin !== undefined
  ? aiData.pdfMetrics.netMargin
  : apiData.netMargin;

const finalOperatingMargin = aiData.pdfMetrics?.marginMetric?.value !== null && aiData.pdfMetrics?.marginMetric?.value !== undefined
  ? aiData.pdfMetrics.marginMetric.value
  : apiData.operatingMargin;

 const finalFcf = aiData.pdfMetrics?.cashFromOperations !== null && aiData.pdfMetrics?.cashFromOperations !== undefined
  ? aiData.pdfMetrics.cashFromOperations * 1e6
  : apiData.fcf;

const finalFcfYoyChange =
    finalFcf != null && apiData.fcfQ4 != null && apiData.fcfQ4 !== 0
      ? ((finalFcf - apiData.fcfQ4) / Math.abs(apiData.fcfQ4)) * 100
      : apiData.fcfYoyChange; 

      const marginTrend: "improving" | "declining" | "stable" =
  finalNetMargin != null && apiData.prevNetMargin != null
    ? finalNetMargin > apiData.prevNetMargin + 1 ? "improving"
    : finalNetMargin < apiData.prevNetMargin - 1 ? "declining"
    : "stable"
  : "stable";
  const data: FullExtractionResponse = {
    symbol,
    companyName,
    reportDate,
    eps: {
      actual: epsActual,
      estimate: epsEstimate || epsActual,
      beatPercent: epsBeatPercent,
      beat: null,
      source: hasFinnhubData ? "Finnhub" : "PDF"
    },
    revenue: {
      actual: revenueActual,
      estimate: revenueEstimate || revenueActual,
      beatPercent: revBeatPercent,
      beat: null,
      source: hasFinnhubData ? "Finnhub" : "PDF"
    },
    guidance: aiData.guidance || { status: "unavailable", details: null },
    sentiment: aiData.sentiment || { overall: "neutral", reasoning: null },
  yoyGrowth: {
    epsChange: finalYoyEps,
    revenueChange: finalYoyRevenue,
    revenueChangeType: aiData.pdfMetrics?.revenueYoY !== null ? "quarterly" : "TTM",
    prevQuarterEpsChange: apiData.prevQuarterEpsChange,  // ← חדש
    prevQuarterRevChange: apiData.prevQuarterRevChange,  // ← חדש
  },
   cashFlow: {
    freeCashFlow: finalFcf,
    yoyChange: finalFcfYoyChange,
    commonStockRepurchased: apiData.commonStockRepurchased,  // ← חדש
    commonDividendsPaid:    apiData.commonDividendsPaid,     // ← חדש
  },
    margins: {
      netMargin: finalNetMargin,
      operatingMargin: finalOperatingMargin,
      trend:marginTrend,
      isEfficiencyRatio: aiData.pdfMetrics?.marginMetric?.type === "efficiency_ratio"
    },
    highlights: aiData.highlights || ["Data extracted from earnings report", "See PDF for details"],
    concerns: aiData.concerns || ["Data extracted from earnings report", "See PDF for details"],
      marketData: {
        price: currentPrice || null,
        marketCap: hardPreFilter?.marketCap ?? null, 
        volume: hardPreFilter?.volume ?? null,          
        source: "FMP"
      },
    reportTime: "",
    managementCommentary: null,
    dataQuality: "high" as any,
    aiRecommendation: "hold" as any,
    hardPreFilter
  };

  // ============================================
  // FINAL SUMMARY
  // ============================================
  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`✅ EXTRACTION COMPLETE: ${symbol}`);
  logger.info(`${"=".repeat(70)}`);
  logger.info(`📄 PDF: ${validatedPdfUrl}`);
  logger.info(`📊 Quarter: Q${q} ${yr}`);
  logger.info(`─`.repeat(70));
  logger.info(`💰 EPS: ${data.eps.actual} vs ${data.eps.estimate} (${data.eps.beatPercent !== null ? (data.eps.beatPercent >= 0 ? '+' : '') + data.eps.beatPercent.toFixed(2) : 'N/A'}%) [${data.eps.source}]`);
  logger.info(`💵 Revenue: $${(data.revenue.actual / 1e9).toFixed(2)}B vs $${(data.revenue.estimate / 1e9).toFixed(2)}B (${data.revenue.beatPercent !== null ? (data.revenue.beatPercent >= 0 ? '+' : '') + data.revenue.beatPercent.toFixed(2) : 'N/A'}%) [${data.revenue.source}]`);
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

//using gemini-open router  
export async function finalAnalysis(fullData: FullExtractionResponse, miraScore: MiraScore): Promise<FinalAnalysis> {
  logger.info(`📝 Generating Final Telegram Report for ${fullData.symbol} using Gemini Flash...`);

  const currentPrice = fullData.marketData?.price || 0;
  const preFilter = fullData.hardPreFilter;

  

  if (!currentPrice || currentPrice === 0) {
    logger.warn(`⚠️ No valid price for ${fullData.symbol} - cannot calculate trade parameters`);
  } else {
    logger.info(`💰 Using price $${currentPrice} for ${fullData.symbol} trade calculations`);
  }
  
  const tradeParams = calculateTradeParams(currentPrice, miraScore.classification);

  // חישובי עזר (נשאר אותו דבר)
  const epsDeviation = fullData.eps.estimate && fullData.eps.actual !== null
    ? (((fullData.eps.actual - fullData.eps.estimate) / Math.abs(fullData.eps.estimate)) * 100).toFixed(2)
    : "N/A";
  const revenueDeviation = fullData.revenue.estimate
    ? (((fullData.revenue.actual - fullData.revenue.estimate) / fullData.revenue.estimate) * 100).toFixed(2)
    : "N/A";

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

  const fcfStatus = fullData.cashFlow?.freeCashFlow !== null && fullData.cashFlow?.freeCashFlow !== undefined
    ? `$${(fullData.cashFlow.freeCashFlow / 1e6).toFixed(2)}M`
    : 'לא זמין';
  const fcfTrend = fullData.cashFlow?.yoyChange !== null && fullData.cashFlow?.yoyChange !== undefined
    ? ` (${fullData.cashFlow.yoyChange > 0 ? '+' : ''}${fullData.cashFlow.yoyChange.toFixed(1)}% YoY)`
    : '';


const marketCapStr = fullData.marketData?.marketCap
  ? fullData.marketData.marketCap >= 1e9
    ? `$${(fullData.marketData.marketCap / 1e9).toFixed(1)}B`
    : `$${(fullData.marketData.marketCap / 1e6).toFixed(0)}M`
  : "לא זמין";

const volumeStr = fullData.marketData?.volume
  ? `${(fullData.marketData.volume / 1e6).toFixed(1)}M`
  : "לא זמין";

const fcfYoy = fullData.cashFlow?.yoyChange !== null && fullData.cashFlow?.yoyChange !== undefined
  ? `${fullData.cashFlow.yoyChange > 0 ? "+" : ""}${fullData.cashFlow.yoyChange.toFixed(1)}%`
  : "לא זמין";

// % מהכניסה עבור יעד 1, יעד 2, סטופ
const pctFromEntry = (price: number, entry: number) =>
  entry > 0 ? `${((price - entry) / entry * 100) > 0 ? "+" : ""}${((price - entry) / entry * 100).toFixed(1)}%` : "";

const target1Pct = tradeParams.hasPriceData ? pctFromEntry(tradeParams.targetPrice, tradeParams.entryPrice) : "";
const target2Pct = tradeParams.hasPriceData && tradeParams.targetPrice2 ? pctFromEntry(tradeParams.targetPrice2, tradeParams.entryPrice) : "";
const stopPct    = tradeParams.hasPriceData ? pctFromEntry(tradeParams.stopPrice, tradeParams.entryPrice) : "";




const preFilterSection = preFilter
  ? `
🔍 ניתוח שוק (Pre-Filter):
- Run-Up 30 יום: ${preFilter.runUp30d !== null ? (preFilter.runUp30d >= 0 ? "+" : "") + preFilter.runUp30d.toFixed(1) + "%" : "לא זמין"}
- Run-Up 60 יום: ${preFilter.runUp60d !== null ? (preFilter.runUp60d >= 0 ? "+" : "") + preFilter.runUp60d.toFixed(1) + "%" : "לא זמין"}
- תגובת AH: ${preFilter.ahChangePercent !== null ? (preFilter.ahChangePercent >= 0 ? "+" : "") + preFilter.ahChangePercent.toFixed(1) + "%" : "לא זמין"}
- נפח יחסי: ${preFilter.volumeRatio !== null ? "×" + preFilter.volumeRatio.toFixed(1) : "לא זמין"}
- Multiple Expansion: ${preFilter.peExpansion !== null ? (preFilter.peExpansion >= 0 ? "+" : "") + preFilter.peExpansion.toFixed(1) + "%" : "לא זמין"}
- EPS Revision: ${preFilter.epsRevision !== null ? (preFilter.epsRevision >= 0 ? "+" : "") + preFilter.epsRevision.toFixed(1) + "%" : "לא זמין"}
- Priced-In: ${preFilter.pricedInClassification === "Fully" ? "🔴 מתומחר במלואו" : preFilter.pricedInClassification === "Partially" ? "🟡 מתומחר חלקית" : preFilter.pricedInClassification === "Not" ? "🟢 לא מתומחר" : "לא זמין"} ${preFilter.pricedInScore !== null ? `(${preFilter.pricedInScore > 0 ? "+" : ""}${preFilter.pricedInScore})` : ""}
${preFilter.signals.filter(s => s.includes("🚨") || s.includes("🔴") || s.includes("🟡")).join("\n")}`
  : "";

const sectorHeatLine = preFilter?.sectorHeatClassification
  ? `- מצב סקטור: ${
      preFilter.sectorHeatClassification === "Hot"    ? "🔥 חם"
      : preFilter.sectorHeatClassification === "Cold" ? "❄️ חלש"
      : "⚪ ניטרלי"
    } (${preFilter.sectorName ?? "?"})
  • סקטור: ${preFilter.sectorChange !== null ? (preFilter.sectorChange >= 0 ? "+" : "") + preFilter.sectorChange.toFixed(1) + "%" : "N/A"}
  • Peers: ${preFilter.peersAvgChange !== null ? (preFilter.peersAvgChange >= 0 ? "+" : "") + preFilter.peersAvgChange.toFixed(1) + "%" : "N/A"}
  • ETF Flow: ${preFilter.etfFlowSignal === "positive" ? "📈 חיובי" : preFilter.etfFlowSignal === "negative" ? "📉 שלילי" : "➡️ ניטרלי"}
  • News: ${preFilter.newsMomentumSignal === "positive" ? "📰 חיובי" : preFilter.newsMomentumSignal === "negative" ? "📰 שלילי" : "📰 ניטרלי"}${preFilter.sectorLongBlocked ? "\n  ⛔ חסם LONG" : ""}`
  : "- מצב סקטור: לא זמין";

const intradayPotential = calcIntradayPotential(fullData);
fullData.intradayPotential = intradayPotential;


const intradayLine = `⚡ פוטנציאל יומי: ${
  intradayPotential.classification === "High"   ? "🟢 גבוה"
  : intradayPotential.classification === "Medium" ? "🟡 בינוני"
  : "🔴 נמוך — אין המלצת Day Trade"
} (${intradayPotential.score}/6)`;


const trendPotential = calcTrendPotential(fullData);
fullData.trendPotential = trendPotential;

const trendLine = `📈 פוטנציאל מגמה: ${
  trendPotential.classification === "High"   ? "🟢 גבוה"
  : trendPotential.classification === "Medium" ? "🟡 בינוני"
  : "🔴 נמוך — אין המלצת Swing"
} (${trendPotential.score}/7)`;
   
const supercycle = await calcSupercycle(fullData);
fullData.supercycle = supercycle;

const supercycleLine = `🌀 Supercycle: ${
  supercycle.confirmed ? "✅ מאושר"  : "❌ לא מאושר"
} (${supercycle.score}/5)`;



const marketTruth = calcMarketTruthOverride(fullData, tradeParams.direction);
fullData.marketTruthOverride = marketTruth;

// אם מופעל — דורס את כיוון המסחר ל-NO TRADE
const finalDirection = marketTruth.triggered
  ? "NO TRADE ❌"
  : tradeParams.direction;

const marketTruthLine = marketTruth.triggered
  ? `⚠️ Market Truth Override: NO TRADE — ${marketTruth.reason}`
  : null;

if (miraScore.totalScore >= 9 && supercycle.confirmed) {
  miraScore.classification = "EXTREME";
}

const sectorHeatShort = preFilter?.sectorHeatClassification
  ? preFilter.sectorHeatClassification === "Hot"  ? "🔥 חם"
  : preFilter.sectorHeatClassification === "Cold" ? "❄️ חלש"
  : "⚪ ניטרלי"
  : "לא זמין";

  
const prompt = `
אתה Mira, אנליסט פיננסי AI מומחה.
צור דוח טלגרם מפורט ומעוצב בעברית בלבד.

📊 נתונים גולמיים:
סימול: ${fullData.symbol}
שם: ${fullData.companyName}
תאריך: ${fullData.reportDate}
מחיר נוכחי: $${currentPrice}
שווי שוק: ${marketCapStr}
נפח מסחר: ${volumeStr}

ביצועים:
EPS: ${fullData.eps.actual} (צפי: ${fullData.eps.estimate}) | סטייה: ${epsDeviation}%
הכנסות: $${(fullData.revenue.actual / 1e9).toFixed(2)}B (צפי: $${(fullData.revenue.estimate / 1e9).toFixed(2)}B) | סטייה: ${revenueDeviation}%
תחזית (Guidance): ${fullData.guidance.status}${fullData.guidance.details ? ` - ${fullData.guidance.details}` : ''}
FCF YoY: ${fcfYoy}
צמיחה YoY: EPS ${yoyEpsGrowth} | Revenue ${yoyRevGrowth}
סקטור: ${sectorHeatShort}
פוטנציאל יומי: ${intradayPotential.classification} (${intradayPotential.score}/6)
פוטנציאל מגמה: ${trendPotential.classification} (${trendPotential.score}/7)
ניקוד מערכת: ${miraScore.totalScore}
סיווג מערכת: ${miraScore.classification}
${marketTruth.triggered ? `⚠️ Market Truth Override: NO TRADE — ${marketTruth.reason}` : ''}

הוראות סיווג קריטיות:
- אם הסיווג "POSITIVE" → כיוון חייב להיות "LONG 🟢"
- אם הסיווג "STRONG"   → כיוון חייב להיות "LONG 🟢🟢"
- אם הסיווג "EXTREME"  → כיוון חייב להיות "LONG 🟢🟢🟢"
- אם הסיווג "NEGATIVE" → כיוון חייב להיות "SHORT 🔴"
- אם הסיווג "NEUTRAL"  → כיוון "NEUTRAL ⚪"
- אם Market Truth Override מופעל → כיוון חייב להיות "NO TRADE ❌"

המלצת מסחר (מחושבת):
כיוון: ${finalDirection}
${tradeParams.hasPriceData ? `
כניסה: $${tradeParams.entryPrice}
יעד 1: $${tradeParams.targetPrice} (${target1Pct})
יעד 2: $${tradeParams.targetPrice2} (${target2Pct})
סטופ: $${tradeParams.stopPrice} (${stopPct})
סיכוי/סיכון: ${tradeParams.riskReward?.toFixed(1) ?? "N/A"}
` : 'מחיר לא זמין'}

המשימה שלך:
כתוב את ההודעה הסופית לטלגרם בדיוק בפורמט הבא — לא להוסיף שדות שלא מופיעים כאן.

פורמט נדרש:

📌 סימול: ${fullData.symbol}
🏢 חברה: ${fullData.companyName}
💰 מחיר: $${currentPrice}
📊 שווי שוק: ${marketCapStr}
📈 נפח מסחר: ${volumeStr}

📊 תוצאות רבעוניות:
• EPS: $${fullData.eps.actual} (צפי: $${fullData.eps.estimate})
• הכנסות: $${(fullData.revenue.actual / 1e9).toFixed(2)}B (צפי: $${(fullData.revenue.estimate / 1e9).toFixed(2)}B)

📈 צמיחה שנתית (YoY):
• EPS[%]: ${yoyEpsGrowth}
• הכנסות[%]: ${yoyRevGrowth}
• FCF[%]: ${fcfYoy}

🔥 מצב סקטור: ${sectorHeatShort}
⚡ פוטנציאל יומי: ${
  intradayPotential.classification === "High"   ? "🟢 גבוה"
  : intradayPotential.classification === "Medium" ? "🟡 בינוני"
  : "🔴 נמוך"
} (${intradayPotential.score}/6)
📈 פוטנציאל מגמה: ${
  trendPotential.classification === "High"   ? "🟢 גבוה"
  : trendPotential.classification === "Medium" ? "🟡 בינוני"
  : "🔴 נמוך"
} (${trendPotential.score}/7)
📊 ניקוד: ${miraScore.totalScore}
🎯 סיווג: ${
  miraScore.classification === 'EXTREME'  ? '🟢🟢🟢 Extreme' :
  miraScore.classification === 'STRONG'   ? '🟢🟢 Strong'    :
  miraScore.classification === 'POSITIVE' ? '🟢 Positive'    :
  miraScore.classification === 'NEGATIVE' ? '❌ Negative'    :
  '❌ Neutral'
}
${miraScore.classification === 'STRONG'
  ? `🌀 Supercycle: ${supercycle.confirmed ? "✅ מאושר" : `❌ לא מאושר (${supercycle.score}/5) — חסר ${5 - supercycle.score} תנאים ל-Extreme`}`
  : ''}
${marketTruth.triggered ? `\n⚠️ Market Truth Override: NO TRADE — ${marketTruth.reason}` : ''}

💼 תוכנית מסחר:
כיוון: ${finalDirection}
${tradeParams.hasPriceData && finalDirection !== "NO TRADE ❌" ? `כניסה: $${tradeParams.entryPrice}
יעד 1: $${tradeParams.targetPrice} (${target1Pct})
יעד 2: $${tradeParams.targetPrice2} (${target2Pct})
סטופ: $${tradeParams.stopPrice} (${stopPct})
סיכוי/סיכון: ${tradeParams.riskReward?.toFixed(1) ?? "N/A"}` : finalDirection === "NO TRADE ❌" ? `⚠️ אין כניסה — השוק דוחה את הדוח` : `⚠️ אין מחיר`}

📝 סיכום:
[כתוב משפט אחד-שניים חדים בעברית. הסבר את הסיווג ואת כיוון המסחר על בסיס הנתונים.]
`;
  try {
    // 🔥 השינוי הגדול: שימוש ב-Gemini Flash דרך OpenRouter
    const telegramMessage = await callOpenRouterAPI(
      [
        { 
          role: "system", 
          content: "אתה עיתונאי פיננסי בכיר. אתה כותב בעברית בלבד. אתה מדויק, תמציתי ומקצועי." 
        }, 
        { 
          role: "user", 
          content: prompt 
        }
      ],
      "google/gemini-2.0-flash-001", // המודל הזול והמהיר
      0.4,  // טמפרטורה בינונית ליצירתיות בטקסט
      1000  // מספיק טוקנים לפלט
    );

    logger.info(`📝 Generated Message Preview: ${telegramMessage.substring(0, 50)}...`);

    if (!telegramMessage || telegramMessage.trim().length === 0) {
      throw new Error("AI returned empty summary");
    }

    const trimmedMessage = telegramMessage.trim();

    // בדיקת תקינות (Safety Check)
    if (miraScore.classification === 'POSITIVE' && !trimmedMessage.includes('LONG')) {
       logger.warn(`⚠️ Warning: POSITIVE score but AI text missed 'LONG' keyword.`);
    }

    return {
      symbol: fullData.symbol,
      date: fullData.reportDate,
      summary: trimmedMessage,
      miraScore,
      tradingRecommendation: tradeParams,
      aiReasoning: "Generated by Gemini Flash",
      conclusion: "Report Generated",
      dataSources: ["Finnhub", "FMP", "Gemini"],
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
  now.setDate(now.getDate()); // Ensure current date
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
  private stocks: (StockProcessingStateExtended)[] = [];
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
    
    const currentMinutesFromMidnight = currentHour * 60 + currentMinute;
    
    if (reportType === "BMO") {
      // BMO: 6:00 AM - 9:30 AM
      const checkStart = 6 * 60; // 360
      // const checkEnd = 9 * 60 + 30; // 570
      const checkEnd = 10; // 570

      return currentMinutesFromMidnight >= checkStart && currentMinutesFromMidnight <= checkEnd;
    }
    
    if (reportType === "AMC") {
      // AMC: 4:00 PM - 8:00 PM
      const checkStart = 16 * 60; // 960
      const checkEnd = 20 * 60; // 1200
      return currentMinutesFromMidnight >= checkStart && currentMinutesFromMidnight <= checkEnd;
    }
    
    return true;
  } catch (error) {
    logger.error(`Error in isWithinReasonableCheckWindow: ${error}`);
    return true;
  }
}
  /**
   * פונקציה מעודכנת: מעבד את כל המניות בכל iteration
   */
private async processAllStocks(): Promise<void> {
  if (!this.isRunning) return;
  const timeContext = getTimeContext();

  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`🔄 Starting new iteration`);
  logger.info(`${"=".repeat(60)}\n`);

  const stocksToCheck = this.stocks.filter((s) => {
    if (s.sentToTelegram || s.status === 'completed') return false;
    if (s.isProcessing) return false;
    if (s.checkCount >= MAX_CHECK_ATTEMPTS) return false;
    
    if (s.nextRetryTime) {
      const now = Date.now();
      const retryTime = new Date(s.nextRetryTime).getTime();
      if (now < retryTime) return false;
      s.nextRetryTime = null;
    }
    
    if (!this.isWithinReasonableCheckWindow(s.windowStart, s.reportType)) {
      return false;
    }
    
    return true;
  });

  if (stocksToCheck.length === 0) {
    const totalSent = this.stocks.filter(s => s.sentToTelegram).length;
    logger.info(`\n📊 No stocks to check - ${totalSent}/${this.stocks.length} sent\n`);
    
    if (totalSent === this.stocks.length) {
      logger.info("✅ All stocks processed! Stopping processor.");
      this.stop();
    }
    return;
  }

  logger.info(`🎯 Checking ${stocksToCheck.length} stocks\n`);

  for (const stock of stocksToCheck) {
    if (!this.isRunning) break;

    // ✅ FIX #1: בדיקה כפולה + סימון - לפני הכל!
    if (stock.sentToTelegram || stock.isProcessing) {
      logger.info(`⏭️ Skipping ${stock.symbol} - already sent/processing`);
      continue;
    }

    stock.isProcessing = true;  // ✅ נעילה

    try {
      logger.info(`\n${"─".repeat(50)}`);
      logger.info(`📦 Processing ${stock.symbol}`);
      logger.info(`${"─".repeat(50)}`);

      stock.status = "checking";
      stock.checkCount++;
      stock.lastCheck = new Date().toISOString();
      
      // בדיקת Finnhub
      const finnhubHasData = await checkFinnhubUpdates(
        stock.symbol, 
        timeContext.reportingDateET
      );
      
      let reportConfirmed = false;

        if (finnhubHasData) {
          // ✅ אם Finnhub אישר - סמוך עליו ללא miniCheck
          logger.info(`🚀 FINNHUB CONFIRMED: ${stock.symbol} - Proceeding without miniCheck`);
          reportConfirmed = true;
          
        } else {
          // ⚠️ אם Finnhub לא אישר - נסה miniCheck
          logger.info(`⚠️ No Finnhub data for ${stock.symbol} - Running miniCheck as fallback...`);
          
          const miniCheckResult = await miniCheck(
            stock.symbol, 
            stock.companyName, 
            stock.quarter, 
            stock.fiscalYear
          );
          
          if (miniCheckResult.result === "YES") {
            logger.info(`🤖 AI CONFIRMED (via miniCheck): ${stock.symbol}`);
            reportConfirmed = true;
          } else {
            logger.info(`⏳ ${stock.symbol} - miniCheck said ${miniCheckResult.result}, will retry later`);
          }
        }

      if (reportConfirmed) {
        logger.info(`✅ Report confirmed! Starting extraction...`);
        stock.status = "extracting";
        
        try {
          const quote = await getQuote(stock.symbol);
          const currentPrice = quote?.price || 0;
          
          const fullData = await fullExtraction(
            stock.symbol,
            stock.companyName,
            timeContext.reportingDateET,
            currentPrice,
            stock.finnhubData,
            stock.quarter,
            stock.fiscalYear,
            stock.cachedIRPortal,
     (foundIrPortal) => {
    // 1. עדכון בזיכרון (כדי שירוץ עכשיו)
    stock.cachedIRPortal = foundIrPortal;
    
    // 2. שמירה לדיסק (כדי שירוץ מחר/אחרי קריסה)
    saveIrPortalToDisk(stock.symbol, foundIrPortal);
  },
  stock.reportType
);
  
          stock.fullData = fullData;
          const miraScore = calculateDetailedScore(fullData);
          const analysis = await finalAnalysis(fullData, miraScore);

          if (analysis) {
            stock.analysis = analysis;
            stock.status = "completed";
            
          
            stock.isProcessing = false;
            
            logger.info(`✅ ${stock.symbol} - Marked as sent!`);

            if (this.onComplete) {
              await this.onComplete(stock);
            }
          } else {
            stock.status = "error";
            stock.error = "Analysis generation failed";
            stock.isProcessing = false;  // ✅
          }
          
        } catch (extractionError: any) {
          logger.error(`❌ Extraction error: ${extractionError.message}`);
          
          stock.extractionAttempts = (stock.extractionAttempts || 0) + 1;
          
          if (stock.extractionAttempts >= 3) {
            stock.status = "error";
            stock.error = `Failed ${stock.extractionAttempts} times`;
            stock.isProcessing = false;  // ✅
          } else {
            stock.nextRetryTime = new Date(Date.now() + 20 * 60 * 1000).toISOString();
            stock.status = "pending";
            stock.isProcessing = false;  // ✅
          }
        }
      } else {
        // ✅ FIX #3: לא נמצא דוח - אפס isProcessing!
        stock.status = "pending";
        stock.isProcessing = false;
        logger.info(`⏳ ${stock.symbol} - Not published yet`);
      }

    } catch (error: any) {
      logger.error(`❌ Error processing ${stock.symbol}: ${error.message}`);
      stock.status = "error";
      stock.error = error.message;
      stock.isProcessing = false;  // ✅
    } finally {
      // ✅ FIX #4: finally block - ביטוח אחרון!
      if (stock.isProcessing) {
        logger.warn(`⚠️ ${stock.symbol} - isProcessing still true in finally, forcing false`);
        stock.isProcessing = false;
      }
    }

    if (this.isRunning) {
      await delay(DELAY_BETWEEN_STOCKS_MS);
    }
  }

  const summary = this.getSummary();
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`📊 Iteration Summary:`);
  logger.info(`   ✅ Completed: ${summary.completed}`);
  logger.info(`   📤 Sent: ${summary.sent}`);
  logger.info(`   ⏳ Pending: ${summary.pending}`);
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
      cachedIRPortal: s.cachedIRPortal || null,
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