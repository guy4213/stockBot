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
import { callGrokAPI, deriveFiscalPeriod, findEarningsPdfCandidates, getFinnhubQuarter, grokGetQuarters, grokScanEarningsToday } from "./grokService";
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
export interface FinnhubEarningsEntry {
    date: string | number | Date;
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



export async function morningIntelligence(date: string): Promise<MorningIntelligenceResponse> {
  logger.info(`🚀 Starting Daily Check Process for ${date}`);

  // ══════════════════════════════════════════
  // STEP 1: Yahoo (Playwright) → רשימה מאושרת
  // ══════════════════════════════════════════
  logger.info(`\n🔍 [Step 1] Scanning confirmed earnings for ${date}...`);

  let rawStocks: Array<{ ticker: string; name: string; time: "BMO" | "AMC" }> = [];

  try {
    const scraped = await grokScanEarningsToday(date);
    rawStocks = scraped.map(s => ({
      ticker: s.ticker,
      name:   s.name,
      time:   s.time,
    }));
    logger.info(`✅ Found ${rawStocks.length} confirmed stocks from Yahoo`);
  } catch (e: any) {
    logger.error(`❌ Scan failed: ${e.message}`);
    return { date, stocks: [] };
  }

  if (rawStocks.length === 0) {
    logger.warn(`⚠️ No stocks found for ${date}`);
    return { date, stocks: [] };
  }

  // ══════════════════════════════════════════
  // STEP 2: Validation — Cache + FMP Quote
  // ══════════════════════════════════════════
  logger.info(`\n📊 [Step 2] Validating ${rawStocks.length} stocks via FMP...`);

  const cache = loadUsStocksCache();
  const passedStocks: Array<{
    symbol:    string;
    name:      string;
    marketCap: number;
    volume:    number;
    time:      "BMO" | "AMC";
    quarter?:  number;
    fiscalYear?: number;
  }> = [];

  for (const s of rawStocks) {
    const cached = cache.get(s.ticker);

    if (cached) {
      if (!cached.marketCap || cached.marketCap < MIN_MARKET_CAP) {
        logger.info(`⚠️ ${s.ticker} — marketCap too low (cache), skipping`);
        continue;
      }
      if (!cached.volume || cached.volume < MIN_VOLUME) {
        logger.info(`⚠️ ${s.ticker} — volume too low (cache), skipping`);
        continue;
      }
      logger.info(`💎 ${s.ticker} (${cached.name}) — $${(cached.marketCap/1e9).toFixed(1)}B | cache`);
      passedStocks.push({
        symbol:    s.ticker,
        name:      cached.name || s.name,
        marketCap: cached.marketCap,
        volume:    cached.volume,
        time:      s.time,
      });
      continue;
    }

    // לא בcache — FMP quote
    try {
      const quote = await getQuote(s.ticker);
      if (!quote?.marketCap || quote.marketCap < MIN_MARKET_CAP) {
        logger.info(`⚠️ ${s.ticker} — marketCap too low (FMP), skipping`);
        continue;
      }
      if (!quote?.volume || quote.volume < MIN_VOLUME) {
        logger.info(`⚠️ ${s.ticker} — volume too low (FMP), skipping`);
        continue;
      }
      logger.info(`💎 ${s.ticker} (${quote.name}) — $${(quote.marketCap/1e9).toFixed(1)}B | FMP`);
      passedStocks.push({
        symbol:    s.ticker,
        name:      quote.name || s.name,
        marketCap: quote.marketCap,
        volume:    quote.volume,
        time:      s.time,
      });
      await new Promise(r => setTimeout(r, 300));
    } catch (e: any) {
      logger.warn(`⚠️ FMP quote failed for ${s.ticker}: ${e.message}`);
    }
  }

  logger.info(`✅ ${passedStocks.length}/${rawStocks.length} stocks passed validation`);
  if (passedStocks.length === 0) return { date, stocks: [] };

  // ══════════════════════════════════════════
  // STEP 3: Quarter Resolution
  // Finnhub → Grok fallback → deriveFiscalPeriod
  // ══════════════════════════════════════════
  logger.info(`\n📅 [Step 3] Resolving fiscal quarters for ${passedStocks.length} stocks...`);

  // שלב 3א: Finnhub לכל מניה שעברה ולידציה — במקביל
  const finnhubResults = await Promise.allSettled(
    passedStocks.map(s => getFinnhubQuarter(s.symbol))
  );

  const periodMap: Record<string, { quarter: number; fiscalYear: number }> = {};
  const mismatchedTickers: string[] = [];

  passedStocks.forEach((s, i) => {
    const result = finnhubResults[i];
    if (result.status === 'fulfilled' && result.value) {
      periodMap[s.symbol] = result.value;
    } else {
      mismatchedTickers.push(s.symbol);
      logger.warn(`⚠️ ${s.symbol}: Finnhub mismatch — queuing for Grok`);
    }
  });

  logger.info(`  ✅ Finnhub resolved: ${Object.keys(periodMap).length} | Grok needed: ${mismatchedTickers.length}`);

  // שלב 3ב: Grok fallback — קריאה אחת לכל ה-mismatched
  if (mismatchedTickers.length > 0) {
    const grokResult = await grokGetQuarters(mismatchedTickers, date);
    for (const ticker of mismatchedTickers) {
      if (grokResult[ticker]) {
        periodMap[ticker] = grokResult[ticker];
        logger.info(`  ✅ ${ticker}: Grok → Q${grokResult[ticker].quarter} FY${grokResult[ticker].fiscalYear}`);
      }
    }
  }

  // שלב 3ג: fallback אחרון — deriveFiscalPeriod
  const fallback = deriveFiscalPeriod(date);
  passedStocks.forEach(s => {
    const period = periodMap[s.symbol] ?? fallback;
    s.quarter    = period.quarter;
    s.fiscalYear = period.fiscalYear;
    if (!periodMap[s.symbol]) {
      logger.warn(`  ⚠️ ${s.symbol}: all sources failed — fallback Q${fallback.quarter} FY${fallback.fiscalYear}`);
    }
    logger.info(`  📅 ${s.symbol}: Q${s.quarter} FY${s.fiscalYear}`);
  });

  // ══════════════════════════════════════════
  // STEP 4: Grok → אמת זמן BMO/AMC
  // ══════════════════════════════════════════
  logger.info(`\n🤖 [Step 4] Grok timing validation for ${passedStocks.length} stocks...`);

  const symbolsForGrok = passedStocks.map(s => s.symbol);
  const grokTiming = await askGrokReportTimeBatch(symbolsForGrok, date);

  // ══════════════════════════════════════════
  // BUILD FINAL STOCKS LIST
  // ══════════════════════════════════════════
  const finalStocks: Stock[] = passedStocks.map(s => {
    const resolvedTime = grokTiming.get(s.symbol) ?? s.time;
    const windowStart  = resolvedTime === "BMO" ? "07:00" : "16:00";
    const windowEnd    = resolvedTime === "BMO" ? "09:30" : "20:00";

    return {
      symbol:      s.symbol,
      companyName: s.name,
      reportType:  resolvedTime,
      windowStart,
      windowEnd,
      marketCap:   s.marketCap,
      volume:      s.volume,
      confidence:  90,
      sources:     ['Yahoo', 'Grok'],
      quarter:     s.quarter,
      fiscalYear:  s.fiscalYear,
      finnhubData: {
        epsActual:       null,
        epsEstimate:     null,
        revenueActual:   null,
        revenueEstimate: null,
      }
    };
  });

  finalStocks.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  logger.info(`\n✅ Morning Intelligence complete: ${finalStocks.length} stocks ready.`);

  return { date, stocks: finalStocks };
}

// export async function miniCheck(symbol: string, companyName: string, quarter?: number, fiscalYear?: number): Promise<MiniCheckResponse> {
//   const dateObj = new Date();
//   const now = dateObj.toISOString();
//   const today = now.split("T")[0];
  
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY is missing");
//   const specificTerm = (quarter && fiscalYear) ? `Q${quarter} ${fiscalYear}` : "Quarterly";

//   const query = `${symbol} ${companyName} ${specificTerm} earnings release`;
//   let searchResults: any[] = [];
// // ✅ ערכי default חכמים
//   const currentYear = new Date().getFullYear();
//   const currentQuarter = Math.ceil((new Date().getMonth() + 1) / 3);
//   const targetQuarter = quarter ?? currentQuarter;
//   const targetYear = fiscalYear ?? currentYear;
//   const previousQuarter = targetQuarter === 1 ? 4 : targetQuarter - 1;
//   const previousYear = targetQuarter === 1 ? targetYear - 1 : targetYear;
  
//   try {
//     const response = await axios.post(
//       'https://google.serper.dev/search',
//       {
//         q: query,
//         num: 10,
//         tbs: "qdr:w",
//         gl: "us",
//         hl: "en"
//       },
//       { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
//     );
    
//     searchResults = [...(response.data.news || []), ...(response.data.organic || [])];
//     logger.info(`🔍 [MiniCheck] Serper returned ${searchResults.length} results for ${symbol}`);

//   } catch (err: any) {
//     logger.warn(`⚠️ [MiniCheck] Serper failed: ${err.message}`);
//   }

//   // ═══════════════════════════════════════════════════════════
//   // FALLBACK: קווירי פשוט אם לא מצאנו כלום
//   // ═══════════════════════════════════════════════════════════
//   if (searchResults.length === 0) {
//     logger.info(`🔄 [MiniCheck] Retrying with simpler query for ${symbol}`);
//     try {
//       const simpleQuery = `${symbol} earnings`;
//       const retryResponse = await axios.post(
//         'https://google.serper.dev/search',
//         { q: simpleQuery, num: 8, gl: "us" },
//         { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } }
//       );
      
//       searchResults = [...(retryResponse.data.news || []), ...(retryResponse.data.organic || [])];
//       logger.info(`🔄 [MiniCheck] Retry found ${searchResults.length} results`);
//     } catch (retryErr: any) {
//       logger.error(`❌ [MiniCheck] Retry failed: ${retryErr.message}`);
//       return { symbol, checkTime: now, result: "UNSURE" };
//     }
//   }

//   if (searchResults.length === 0) {
//     logger.warn(`⚠️ [MiniCheck] No results found for ${symbol}`);
//     return { symbol, checkTime: now, result: "UNSURE" };
//   }

//   // ═══════════════════════════════════════════════════════════
//   // 🔥 CRITICAL: פרומפט מחוזק שבודק תאריך ורבעון!
//   // ═══════════════════════════════════════════════════════════
  
//   const snippetsText = searchResults.map((r, i) => 
//     `[${i+1}] Title: ${r.title}
// Snippet: ${r.snippet}
// Date: ${r.date || 'N/A'}
// Link: ${r.link}`
//   ).join('\n---\n');

// const prompt = `
// You are validating if a SPECIFIC earnings report has been published.

// TARGET REPORT:
// - Company: ${symbol} (${companyName})
// - Quarter: ${specificTerm}
// - Today's Date: ${today}

// SEARCH RESULTS:
// ${snippetsText}

// CRITICAL VALIDATION RULES:
// 1. Must mention "${specificTerm}" or "Q${targetQuarter} ${targetYear}" or "fourth quarter ${targetYear}"
// 2. Must have actual earnings numbers (EPS, Revenue)
// 3. Must be published recently (within last 7 days)
// 4. IGNORE old quarters (Q${previousQuarter} ${previousYear}, Q${targetQuarter} ${targetYear - 1}, etc.)
// 5. IGNORE previews, estimates, or "scheduled for" announcements

// EXAMPLES OF WHAT TO ACCEPT:
// ✅ "${symbol} Reports Q${targetQuarter} ${targetYear} Earnings"
// ✅ "Fourth Quarter ${targetYear} Results"
// ✅ "Q${targetQuarter} ${targetYear} EPS: $X.XX, Revenue: $XXM"

// EXAMPLES OF WHAT TO REJECT:
// ❌ "Q${previousQuarter} ${previousYear} Results" (wrong quarter)
// ❌ "Q${targetQuarter} ${targetYear - 1} Results" (wrong year)
// ❌ "${symbol} to Report Earnings on..." (preview, not actual)
// ❌ "Analysts Estimate..." (estimate, not actual)

// QUESTION: Has ${symbol} published the ACTUAL ${specificTerm} earnings report?

// Answer with ONE WORD ONLY: YES or NO
// `;

//   try {
//     const res = await callOpenRouterAPI(
//       [{ role: "user", content: prompt }],
//       "google/gemini-2.0-flash-001",
//       0.1,
//       100  // ⬅️ יותר טוקנים למקרה שצריך
//     );

//     const cleanRes = res.trim().toUpperCase().replace(/[^A-Z]/g, '');
//     let finalResult: MiniCheckResult = "UNSURE";

//     if (cleanRes.includes("YES")) finalResult = "YES";
//     else if (cleanRes.includes("NO")) finalResult = "NO";

//     logger.info(`🤖 [MiniCheck] AI decision for ${symbol} ${specificTerm}: "${res.trim()}" → ${finalResult}`);

//     stockLog.miniCheck(symbol, finalResult);
//     return { symbol, checkTime: now, result: finalResult };

//   } catch (e: any) { 
//     logger.error(`❌ [MiniCheck] AI failed: ${e.message}`);
//     return { symbol, checkTime: now, result: "UNSURE" }; 
//   }
// }

export async function miniCheck(
  symbol: string, 
  companyName: string, 
  quarter?: number, 
  fiscalYear?: number
): Promise<MiniCheckResponse> {

  const now = new Date().toISOString();
  const today = now.split("T")[0];
  const specificTerm = (quarter && fiscalYear) ? `Q${quarter} ${fiscalYear}` : "latest quarterly";

  logger.info(`🤖 [MiniCheck] Grok web search for ${symbol} ${specificTerm}...`);

  const prompt = `Search the web right now for "${symbol} ${companyName} earnings results ${specificTerm}".

Has ${symbol} (${companyName}) published their ACTUAL ${specificTerm} earnings report today (${today}) or in the last 48 hours?

Rules:
- Must be ACTUAL results (EPS + Revenue numbers), not a preview or estimate
- Must be ${specificTerm} specifically, not an older quarter
- Check press releases, IR websites, financial news

Answer with ONE WORD ONLY: YES or NO`;

  try {
    // ✅ Grok עם web search — הכי אמין
    const res = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1,
      50,
      true  // ← web search enabled
    );

    const clean = res.trim().toUpperCase().replace(/[^A-Z]/g, '');
    let result: MiniCheckResult = "UNSURE";
    if (clean.includes("YES")) result = "YES";
    else if (clean.includes("NO")) result = "NO";

    logger.info(`🤖 [MiniCheck] Grok decision for ${symbol}: ${result}`);
    stockLog.miniCheck(symbol, result);
    return { symbol, checkTime: now, result };

  } catch (e: any) {
    logger.error(`❌ [MiniCheck] Grok failed: ${e.message}`);
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
async function extractWithGemini(
  rawContent: string,
  symbol: string,
  companyName: string,
  q: number,
  yr: number,
  finnhubEpsEstimate: number | null,
  finnhubRevEstimate: number | null,
  hasFinnhubData: boolean,
  reportDate: string,
  epsActual: number | null = null,
  epsEstimate: number | null = null,
  epsBeatPercent: number = 0,
  revenueActual: number | null = null,
  revenueEstimate: number | null = null,
  revBeatPercent: number = 0
): Promise<any> {

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
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // ← אותו קוד שיש לך עכשיו בתוך הלולאה
     const aiRes = await callOpenRouterAPI(
        [
          { role: "system", content: "You are a financial data extraction API. Return ONLY valid JSON with no markdown." },
          { role: "user",   content: supplementPrompt }
        ],
        "google/gemini-2.0-flash-001",
        0.05,
        3000
      );

      let cleaned = aiRes.trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const tempAiData = JSON.parse(cleaned);

      const hasGuidance   = tempAiData.guidance?.status;
      const hasSentiment  = tempAiData.sentiment?.overall;
      const hasHighlights = tempAiData.highlights?.length >= 2;
      const hasConcerns   = tempAiData.concerns?.length >= 2;

      if (!hasGuidance || !hasSentiment || !hasHighlights || !hasConcerns) {
        lastError = `Incomplete qualitative data`;
        logger.warn(`   ⏳ Attempt ${attempt}/${MAX_RETRIES}: ${lastError}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        // אחרי MAX_RETRIES — מחזירים בכל זאת
        logger.warn(`   ⚠️ Accepting incomplete qualitative data`);
      }

      return tempAiData;
    } 
      
    
    catch (parseError: any) {
      lastError = parseError.message;
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  throw new Error(`Failed to extract after ${MAX_RETRIES} attempts: ${lastError}`);
}

async function grokSearchMissingFields(
  symbol: string,
  companyName: string,
  quarter: number,
  year: number,
  reportDate: string,
  missingFields: string[]
): Promise<{ epsActual: number | null; revenueActual: number | null }> {
  
  logger.info(`\n🔎 [GrokTargeted] Searching for missing fields: ${missingFields.join(', ')}`);

  const prompt = `Find the ACTUAL reported earnings numbers for ${companyName} (${symbol}) Q${quarter} ${year} (reported around ${reportDate}).

I need these specific values: ${missingFields.join(', ')}

Search financial news sites, earnings announcements, and press releases.

Return ONLY this JSON:
{
  "epsActual": number_or_null,
  "revenueActual": number_in_dollars_or_null
}

Examples:
{ "epsActual": 1.23, "revenueActual": 4500000000 }
{ "epsActual": -0.45, "revenueActual": null }`;

  try {
    const response = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1,
      500,
      true
    );

    const clean = response.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      epsActual: parsed.epsActual ?? null,
      revenueActual: parsed.revenueActual ?? null
    };
  } catch (e: any) {
    logger.error(`❌ [GrokTargeted] Failed: ${e.message}`);
    return { epsActual: null, revenueActual: null };
  }
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
logger.info(`\n🔍 Step 0: Finding earnings report PDFs using Serper + Grok...`);

const pdfCandidates = await findEarningsPdfCandidates(
  symbol, companyName, q, yr, reportDate, cachedIRPortal, onIRPortalFound
);

if (pdfCandidates.length === 0) {
  logger.error(`❌ CRITICAL: No PDF candidates found for ${symbol} Q${q} ${yr}`);
  throw new Error(`Earnings PDF not found for ${symbol} Q${q} ${yr}`);
}

logger.info(`✅ Found ${pdfCandidates.length} PDF candidates:`);
pdfCandidates.forEach((u, i) => logger.info(`   [${i+1}] ${u}`));

// validatedPdfUrl נשאר לשאר הקוד שמשתמש בו
const validatedPdfUrl = pdfCandidates[0];

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
const finnhubEpsEstimate = finnhubData?.epsEstimate ?? null;
const finnhubRevEstimate = finnhubData?.revenueEstimate ?? null;



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
  // STEP 3: MULTI-SOURCE EXTRACTION WITH PARTIAL ACCUMULATOR
  // ============================================
  logger.info(`\n🤖 Step 3: Multi-source extraction with partial data accumulator...`);

  // PartialData — מצטבר מכל המקורות, לא נדרס
  interface PartialAiData {
    eps?: { actual: number | null; estimate: number | null; beatPercent: number | null; epsType: string | null };
    revenue?: { actual: number | null; estimate: number | null; beatPercent: number | null; revenueType: string | null };
    pdfMetrics?: {
      epsYoY: number | null; revenueYoY: number | null; netMargin: number | null;
      marginMetric: { value: number; label: string } | null; cashFromOperations: number | null;
    };
    guidance?: any;
    pdfUrl?: string;
  }

  const partialData: PartialAiData = {};
if (hasFinnhubData) {
  partialData.eps = {
    actual:      epsActual,
    estimate:    epsEstimate,
    beatPercent: epsBeatPercent,
    epsType:     null
  };
  partialData.revenue = {
    actual:      revenueActual,
    estimate:    revenueEstimate,
    beatPercent: revBeatPercent,
    revenueType: null
  };
}
  function mergePartial(target: PartialAiData, source: PartialAiData): void {
    // EPS
    if (source.eps) {
      if (!target.eps) target.eps = { actual: null, estimate: null, beatPercent: null, epsType: null };
      if (target.eps.actual === null && source.eps.actual !== null) target.eps.actual = source.eps.actual;
      if (target.eps.estimate === null && source.eps.estimate !== null) target.eps.estimate = source.eps.estimate;
      if (target.eps.beatPercent === null && source.eps.beatPercent !== null) target.eps.beatPercent = source.eps.beatPercent;
      if (target.eps.epsType === null && source.eps.epsType !== null) target.eps.epsType = source.eps.epsType;
    }
    // Revenue
    if (source.revenue) {
      if (!target.revenue) target.revenue = { actual: null, estimate: null, beatPercent: null, revenueType: null };
      if (target.revenue.actual === null && source.revenue.actual !== null) target.revenue.actual = source.revenue.actual;
      if (target.revenue.estimate === null && source.revenue.estimate !== null) target.revenue.estimate = source.revenue.estimate;
      if (target.revenue.beatPercent === null && source.revenue.beatPercent !== null) target.revenue.beatPercent = source.revenue.beatPercent;
      if (target.revenue.revenueType === null && source.revenue.revenueType !== null) target.revenue.revenueType = source.revenue.revenueType;
    }
    // pdfMetrics
    if (source.pdfMetrics) {
      if (!target.pdfMetrics) target.pdfMetrics = { epsYoY: null, revenueYoY: null, netMargin: null, marginMetric: null, cashFromOperations: null };
      if (target.pdfMetrics.epsYoY === null && source.pdfMetrics.epsYoY !== null) target.pdfMetrics.epsYoY = source.pdfMetrics.epsYoY;
      if (target.pdfMetrics.revenueYoY === null && source.pdfMetrics.revenueYoY !== null) target.pdfMetrics.revenueYoY = source.pdfMetrics.revenueYoY;
      if (target.pdfMetrics.netMargin === null && source.pdfMetrics.netMargin !== null) target.pdfMetrics.netMargin = source.pdfMetrics.netMargin;
      if (target.pdfMetrics.marginMetric === null && source.pdfMetrics.marginMetric !== null) target.pdfMetrics.marginMetric = source.pdfMetrics.marginMetric;
      if (target.pdfMetrics.cashFromOperations === null && source.pdfMetrics.cashFromOperations !== null) target.pdfMetrics.cashFromOperations = source.pdfMetrics.cashFromOperations;
    }
    // guidance
    if (!target.guidance && source.guidance) target.guidance = source.guidance;
    // pdfUrl (שומרים את ה-URL הראשון שהצליח)
    if (!target.pdfUrl && source.pdfUrl) target.pdfUrl = source.pdfUrl;
  }

  function isCriticalDataComplete(data: PartialAiData): boolean {
    // EPS actual הוא הכי קריטי
    return data.eps?.actual !== null && data.eps?.actual !== undefined
        && data.revenue?.actual !== null && data.revenue?.actual !== undefined;
  }

  // עוברים על כל URL candidate
  for (let urlIdx = 0; urlIdx < pdfCandidates.length; urlIdx++) {
    const candidateUrl = pdfCandidates[urlIdx];
    logger.info(`\n   📄 Trying source [${urlIdx + 1}/${pdfCandidates.length}]: ${candidateUrl}`);

    // Fetch content
    let rawContent: string | null = null;

    // retry רק על network errors — לא על content שגוי
    for (let netAttempt = 1; netAttempt <= 2; netAttempt++) {
      try {
        rawContent = await fetchContentWithJina(candidateUrl);
        break; // הצלחה — יוצאים מ-retry
      } catch (netErr: any) {
        logger.warn(`   ⚠️ Network error attempt ${netAttempt}: ${netErr.message}`);
        if (netAttempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (rawContent === null) {
      logger.warn(`   ❌ Source [${urlIdx + 1}] failed (short/blocked) — trying next`);
      continue; // לא retry, עוברים ל-URL הבא
    }

    // Gemini extraction
    try {
    const extractedData = await extractWithGemini(
      rawContent, symbol, companyName, q, yr,
      finnhubEpsEstimate, finnhubRevEstimate,
      hasFinnhubData,
      reportDate,
      epsActual, epsEstimate, epsBeatPercent,
      revenueActual, revenueEstimate, revBeatPercent
    );

      logger.info(`   📊 Source [${urlIdx + 1}] extracted:`);
      logger.info(`      EPS actual: ${extractedData.eps?.actual ?? 'null'}`);
      logger.info(`      Revenue actual: ${extractedData.revenue?.actual ?? 'null'}`);

      // מיזוג — לא דורסים שדות קיימים
      mergePartial(partialData, { ...extractedData, pdfUrl: candidateUrl });

      logger.info(`   📦 Accumulated so far — EPS: ${partialData.eps?.actual ?? 'null'}, Revenue: ${partialData.revenue?.actual ?? 'null'}`);

      if (isCriticalDataComplete(partialData)) {
        logger.info(`   ✅ Critical data complete after source [${urlIdx + 1}]`);
        break;
      } else {
        logger.info(`   ⚠️ Still missing critical data, trying next source...`);
      }

    } catch (extractErr: any) {
      logger.warn(`   ❌ Gemini extraction failed for source [${urlIdx + 1}]: ${extractErr.message}`);
    }
  }

  // אם אחרי כל ה-URLs עדיין חסר EPS actual — Grok targeted search
  if (!isCriticalDataComplete(partialData)) {
    logger.warn(`\n   ⚠️ EPS actual still missing after ${pdfCandidates.length} sources — calling Grok targeted search`);
    
    const missingFields: string[] = [];
    if (partialData.eps?.actual === null || partialData.eps?.actual === undefined) missingFields.push('EPS actual');
    if (partialData.revenue?.actual === null || partialData.revenue?.actual === undefined) missingFields.push('Revenue actual');

    const grokResult = await grokSearchMissingFields(symbol, companyName, q, yr, reportDate, missingFields);

if (grokResult.epsActual != null && (partialData.eps?.actual == null)) {
      if (!partialData.eps) partialData.eps = { actual: null, estimate: null, beatPercent: null, epsType: null };
      partialData.eps.actual = grokResult.epsActual;
      logger.info(`   ✅ Grok filled EPS actual: ${grokResult.epsActual}`);
    }
    if (grokResult.revenueActual !== null && partialData.revenue?.actual === null) {
      if (!partialData.revenue) partialData.revenue = { actual: null, estimate: null, beatPercent: null, revenueType: null };
      partialData.revenue.actual = grokResult.revenueActual;
      logger.info(`   ✅ Grok filled Revenue actual: ${grokResult.revenueActual}`);
    }
  }

  // בדיקה סופית
  if (!isCriticalDataComplete(partialData)) {
    throw new Error(`Missing critical data (EPS/Revenue) for ${symbol} after all sources`);
  }

  let aiData = partialData as any; // ממשיך עם aiData כרגיל
 // ============================================
  // STEP 4: BUILD FINAL DATA OBJECT
  // ============================================
  logger.info(`\n🔗 Step 4: Building Final Data Object...`);

  // אם Finnhub לא נתן EPS/Revenue — קח מה-AI
  if (!hasFinnhubData && aiData.eps && aiData.revenue) {
    epsActual     = aiData.eps.actual;
    epsEstimate   = aiData.eps.estimate ?? finnhubEpsEstimate;
    revenueActual = aiData.revenue.actual;
    revenueEstimate = aiData.revenue.estimate ?? finnhubRevEstimate;

    epsBeatPercent = epsEstimate && epsEstimate !== 0
      ? ((epsActual! - epsEstimate) / Math.abs(epsEstimate)) * 100 : 0;
    revBeatPercent = revenueEstimate && revenueEstimate !== 0
      ? ((revenueActual! - revenueEstimate) / revenueEstimate) * 100 : 0;

    logger.info(`   ✅ EPS: ${epsActual} vs ${epsEstimate} (from PDF + Finnhub estimate)`);
    logger.info(`   ✅ Revenue: $${(revenueActual! / 1e9).toFixed(2)}B`);
  }

  // אם hasFinnhubData=true אבל EPS actual עדיין null — override מה-AI
  if (epsActual === null && aiData.eps?.actual !== null && aiData.eps?.actual !== undefined) {
    epsActual = aiData.eps.actual;
    logger.info(`   🔄 EPS actual overridden from AI: ${epsActual}`);
  }

  if (epsActual === null || revenueActual === null) {
    logger.error(`❌ CRITICAL: Missing EPS or Revenue after extraction!`);
    throw new Error('Missing critical data (EPS/Revenue) - cannot proceed');
  }

  const finalYoyRevenue = aiData.pdfMetrics?.revenueYoY ?? apiData.yoyRevenueChange;
  const finalYoyEps     = aiData.pdfMetrics?.epsYoY     ?? apiData.yoyEpsChange;
  const finalNetMargin  = aiData.pdfMetrics?.netMargin  ?? apiData.netMargin;
  const finalOperatingMargin = aiData.pdfMetrics?.marginMetric?.value ?? apiData.operatingMargin;
  const finalFcf = aiData.pdfMetrics?.cashFromOperations != null
    ? aiData.pdfMetrics.cashFromOperations * 1e6
    : apiData.fcf;

  const finalFcfYoyChange = finalFcf != null && apiData.fcfQ4 != null && apiData.fcfQ4 !== 0
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
    guidance:  aiData.guidance  || { status: "unavailable", details: null },
    sentiment: aiData.sentiment || { overall: "neutral", reasoning: null },
    yoyGrowth: {
      epsChange: finalYoyEps,
      revenueChange: finalYoyRevenue,
      revenueChangeType: aiData.pdfMetrics?.revenueYoY != null ? "quarterly" : "TTM",
      prevQuarterEpsChange: apiData.prevQuarterEpsChange,
      prevQuarterRevChange: apiData.prevQuarterRevChange,
    },
    cashFlow: {
      freeCashFlow: finalFcf,
      yoyChange: finalFcfYoyChange,
      commonStockRepurchased: apiData.commonStockRepurchased,
      commonDividendsPaid:    apiData.commonDividendsPaid,
    },
    margins: {
      netMargin: finalNetMargin,
      operatingMargin: finalOperatingMargin,
      trend: marginTrend,
      isEfficiencyRatio: aiData.pdfMetrics?.marginMetric?.type === "efficiency_ratio"
    },
    highlights: aiData.highlights || ["Data extracted from earnings report", "See PDF for details"],
    concerns:   aiData.concerns  || ["Data extracted from earnings report", "See PDF for details"],
    marketData: {
      price:     currentPrice || null,
      marketCap: hardPreFilter?.marketCap ?? null,
      volume:    hardPreFilter?.volume    ?? null,
      source:    "FMP"
    },
    reportTime: "",
    managementCommentary: null,
    dataQuality: "high" as any,
    aiRecommendation: "hold" as any,
    hardPreFilter
  };

  logger.info(`\n${"=".repeat(70)}`);
  logger.info(`✅ EXTRACTION COMPLETE: ${symbol}`);
  logger.info(`${"=".repeat(70)}`);
  logger.info(`📄 PDF: ${validatedPdfUrl}`);
  logger.info(`💰 EPS: ${data.eps.actual} vs ${data.eps.estimate} (${data.eps.beatPercent?.toFixed(2) ?? 'N/A'}%)`);
  logger.info(`💵 Revenue: $${(data.revenue.actual / 1e9).toFixed(2)}B`);
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
      const checkEnd = 10*60; // 570

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