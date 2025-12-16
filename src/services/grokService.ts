// ============================================
// GROK SERVICE - xAI API Integration (OPTIMIZED)
// ============================================
// Improvements:
// 1. Sequential stock processing (one at a time)
// 2. Scheduled checks every 5-10 minutes
// 3. Targeted IR searches for better data retrieval
// 4. Enhanced error handling with retries
// 5. State management for tracking progress
// 6. Rate limit handling with exponential backoff
// ============================================

import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger from "../utils/logger";
import {
  GrokRequest,
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

// ============================================
// CONFIGURATION
// ============================================

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const GROK_API_KEY = process.env.GROK_API_KEY;
const GROK_MODEL = "grok-3-mini"; // Optimized: 97% cheaper than grok-3!

// Timing configuration
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between checks
const DELAY_BETWEEN_STOCKS_MS = 2 * 60 * 1000; // 2 minutes delay between processing stocks (rate limit safety)
const MAX_API_RETRIES = 3;
const RETRY_DELAYS = [60000, 120000, 300000]; // 1min, 2min, 5min

// Market cap filter (volume filter removed - see morningIntelligence prompt)
const MIN_MARKET_CAP = 300000000; // $300M

// ============================================
// HELPER: Call Grok API with Enhanced Error Handling
// ============================================
interface FinnhubEarningsEntry {
  symbol: string;
  date: string;
  hour: string; // 'amc', 'bmo', etc.
  year: number;
  quarter: number;
  epsEstimate?: number;
  epsActual?: number;
  revenueEstimate?: number;
  revenueActual?: number;
}

export interface StockInfo {
  symbol: string;
  companyName: string; // פינהאב לא תמיד מחזיר שם מלא בקאלנדר, נצטרך להשלים או להשתמש בטיקר
  reportType: string;
  marketCap: number;
}

export interface MorningIntelligenceResponse {
  date: string;
  stocks: StockInfo[];
}
async function callGrokAPI(
  messages: GrokMessage[],
  temperature: number = 0.3,
  maxTokens: number = 4000,
  enableWebSearch: boolean = false
): Promise<string> {
  if (!GROK_API_KEY) {
    throw new Error("GROK_API_KEY is not set in environment variables");
  }

  const requestBody: any = {
    model: GROK_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // Enable Live Search (Web Search) when needed
  if (enableWebSearch) {
    requestBody.search_parameters = {
      mode: "auto",
      return_citations: true,
      max_search_results: 20,
    };
  }

  // Retry logic with exponential backoff
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    const startTime = Date.now();

    try {
      if (attempt === 0) {
        logger.info(`📡 Calling Grok API (model: ${GROK_MODEL})...`);
        logger.info(`   Temperature: ${temperature}, Max Tokens: ${maxTokens}`);
        logger.info(`   Web Search: ${enableWebSearch ? "✅ Enabled" : "❌ Disabled"}`);

        if (enableWebSearch) {
          logger.info(`   ⏳ Please wait... Grok is searching the web...`);
        }
      } else {
        logger.info(`📡 Retry attempt ${attempt}/${MAX_API_RETRIES}...`);
      }

      const response = await axios.post<GrokResponse>(
        GROK_API_URL,
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROK_API_KEY}`,
          },
          timeout: 600000, // 10 minutes timeout for web searches
        }
      );

      const duration = Date.now() - startTime;
      const usage = response.data.usage;
      const content = response.data.choices[0].message.content;

      logger.info(
        `✅ Grok API call successful (${Math.floor(duration / 1000)}s) | Tokens: ${usage.total_tokens}`
      );

      if (enableWebSearch && response.data.usage?.num_sources_used) {
        logger.info(`   🔍 Sources used: ${response.data.usage.num_sources_used}`);
      }

      return content;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        // Handle rate limit (429) with retry
        if (axiosError.response?.status === 429 && attempt < MAX_API_RETRIES) {
          const waitTime = RETRY_DELAYS[attempt];
          logger.warn(
            `⚠️ Rate limit (429) hit. Waiting ${waitTime / 1000}s before retry ${attempt + 1}/${MAX_API_RETRIES}...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }

        // Log error details
        if (axiosError.code === "ECONNABORTED") {
          logger.error(`❌ Grok API timeout after ${Math.floor(duration / 1000)}s`);
        } else {
          logger.error(`❌ Grok API error:`, {
            status: axiosError.response?.status,
            statusText: axiosError.response?.statusText,
            message: axiosError.message,
          });
        }
      } else {
        logger.error(`❌ Unexpected error calling Grok API:`, error);
      }

      // If we've exhausted retries or it's not a 429 error, throw
      if (attempt >= MAX_API_RETRIES) {
        throw error;
      }
    }
  }

  throw new Error("Max retries exceeded");
}

// ============================================
// HELPER: Delay Function
// ============================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// HELPER: Extract JSON from Response
// ============================================

function extractJSON(response: string): string {
  let jsonText = response.trim();

  // Remove markdown code blocks
  if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
  } else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/```\n?/g, "");
  }

  // Find the first '{' and last '}' to extract only JSON
  const firstBrace = jsonText.indexOf("{");
  const lastBrace = jsonText.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON object found in response");
  }

  jsonText = jsonText.substring(firstBrace, lastBrace + 1);

  // Remove trailing commas before ] or }
  jsonText = jsonText.replace(/,(\s*[}\]])/g, "$1");

  return jsonText;
}

// ============================================
// HELPER: Get Market Cap via Grok
// ============================================

async function getMarketCap(symbol: string): Promise<number> {
  const prompt = `What is the current market capitalization of ${symbol} in USD?
Search Yahoo Finance, Google Finance, or MarketWatch.
Return ONLY a number (no text, no formatting). Example: 3000000000000`;

  try {
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You return only numbers. No explanation, no text, just the market cap value in USD.",
        },
        { role: "user", content: prompt },
      ],
      0.1,
      50,
      true // Enable web search
    );

    const cleanResponse = response.trim().replace(/[^0-9.]/g, "");
    const marketCap = parseFloat(cleanResponse);

    if (isNaN(marketCap) || marketCap <= 0) {
      throw new Error(`Invalid market cap response: ${response}`);
    }

    return marketCap;
  } catch (error) {
    logger.error(`Failed to get market cap for ${symbol}:`, error);
    throw error;
  }
}

// ============================================
// HELPER: Get Trading Volume via Grok
// ============================================

async function getTradingVolume(symbol: string): Promise<number> {
  const prompt = `What is the current average daily trading volume for ${symbol}?
Search Yahoo Finance or Google Finance.
Return ONLY a number (no text, no formatting). Example: 45000000`;

  try {
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You return only numbers. No explanation, no text, just the trading volume value.",
        },
        { role: "user", content: prompt },
      ],
      0.1,
      50,
      true // Enable web search
    );

    const cleanResponse = response.trim().replace(/[^0-9.]/g, "");
    const volume = parseFloat(cleanResponse);

    if (isNaN(volume) || volume <= 0) {
      throw new Error(`Invalid volume response: ${response}`);
    }

    return volume;
  } catch (error) {
    logger.error(`Failed to get volume for ${symbol}:`, error);
    throw error;
  }
}

// ============================================
// 0. FETCH US STOCKS LIST (REPLACEMENT FOR FMP API)
// ============================================

export interface USStockSymbol {
  symbol: string;
  name: string;
  price: number;
  exchange: string;
  exchangeShortName: string;
  type: string;
}

export interface USStocksList {
  lastUpdated: string;
  count: number;
  stocks: USStockSymbol[];
}

/**
 * Fetch all US stocks from NYSE, NASDAQ, and AMEX using Grok web search
 * This replaces the FMP API call
 */
export async function fetchUSStocksViaGrok(): Promise<USStocksList> {
  logger.info(`🌐 Fetching all US stocks via Grok (NYSE, NASDAQ, AMEX)...`);

  const prompt = `Search for the complete list of all publicly traded stocks on NYSE, NASDAQ, and AMEX exchanges.

For EACH exchange, find:
1. All stock tickers (symbols)
2. Company names
3. Current stock prices (approximate is OK)
4. Stock type (stock, ETF, ADR, trust, etc.)

Sources to check:
- NASDAQ official website: https://www.nasdaq.com/market-activity/stocks/screener
- NYSE official website: https://www.nyse.com/listings_directory/stock
- Yahoo Finance: https://finance.yahoo.com/screener/
- MarketWatch stock screener
- Finviz stock screener

Return ONLY valid JSON in this EXACT format (no markdown, no extra text):
{
  "nyse": [
    {"symbol": "AAPL", "name": "Apple Inc.", "price": 185.50, "type": "stock"},
    {"symbol": "BAC", "name": "Bank of America Corp", "price": 34.20, "type": "stock"}
  ],
  "nasdaq": [
    {"symbol": "MSFT", "name": "Microsoft Corporation", "price": 378.90, "type": "stock"},
    {"symbol": "TSLA", "name": "Tesla Inc", "price": 242.80, "type": "stock"}
  ],
  "amex": [
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "price": 478.50, "type": "etf"}
  ]
}

Important:
- Include ALL symbols from each exchange (this may be 3000+ stocks total)
- Valid JSON only, no trailing commas
- Use "stock" for common stocks, "etf" for ETFs, "adr" for ADRs
- Price can be approximate from latest data
- Focus on getting comprehensive coverage`;

  try {
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You are a comprehensive stock data extractor. Access stock exchange websites and return complete listings. Return ONLY valid JSON - no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      0.1, // Very low temp for accurate extraction
      16000, // Large token limit for comprehensive list
      true // Enable web search
    );

    // Extract and parse JSON
    const jsonText = extractJSON(response);
    let data: any;

    try {
      data = JSON.parse(jsonText);
    } catch (parseError: any) {
      logger.error(`❌ JSON Parse Error: ${parseError.message}`);
      throw parseError;
    }

    // Transform to our format
    const allStocks: USStockSymbol[] = [];

    // Process NYSE
    if (data.nyse && Array.isArray(data.nyse)) {
      data.nyse.forEach((stock: any) => {
        allStocks.push({
          symbol: stock.symbol,
          name: stock.name,
          price: stock.price || 0,
          exchange: "New York Stock Exchange",
          exchangeShortName: "NYSE",
          type: stock.type || "stock",
        });
      });
    }

    // Process NASDAQ
    if (data.nasdaq && Array.isArray(data.nasdaq)) {
      data.nasdaq.forEach((stock: any) => {
        allStocks.push({
          symbol: stock.symbol,
          name: stock.name,
          price: stock.price || 0,
          exchange: "NASDAQ Stock Exchange",
          exchangeShortName: "NASDAQ",
          type: stock.type || "stock",
        });
      });
    }

    // Process AMEX
    if (data.amex && Array.isArray(data.amex)) {
      data.amex.forEach((stock: any) => {
        allStocks.push({
          symbol: stock.symbol,
          name: stock.name,
          price: stock.price || 0,
          exchange: "American Stock Exchange",
          exchangeShortName: "AMEX",
          type: stock.type || "stock",
        });
      });
    }

    logger.info(`✅ Fetched ${allStocks.length} US stocks via Grok`);
    logger.info(`   NYSE: ${data.nyse?.length || 0}`);
    logger.info(`   NASDAQ: ${data.nasdaq?.length || 0}`);
    logger.info(`   AMEX: ${data.amex?.length || 0}`);

    return {
      lastUpdated: new Date().toISOString(),
      count: allStocks.length,
      stocks: allStocks,
    };
  } catch (error) {
    logger.error("❌ Failed to fetch US stocks via Grok:", error);
    throw error;
  }
}

// ============================================
// 1. MORNING INTELLIGENCE (OPTIMIZED)
// ============================================

// ============================================
// 1. MORNING INTELLIGENCE (FIXED)
// ============================================

// ============================================
// 1. MORNING INTELLIGENCE (STRICT MODE)
// ============================================

// export async function morningIntelligence(
//   date: string
// ): Promise<MorningIntelligenceResponse> {
//   logger.info(`🌅 Running Morning Intelligence for ${date}...`);

//   // שינוי אגרסיבי: איסור מוחלט על המצאת נתונים
//   const prompt = `🚨 CRITICAL DATA EXTRACTION TASK 🚨
  
//   TARGET URL: https://finance.yahoo.com/calendar/earnings?day=${date}

//   INSTRUCTIONS:
//   1. Go to the URL above via Web Search.
//   2. Look strictly at the list of companies reporting on THIS SPECIFIC DATE (${date}).
//   3. Extract symbols/tickers found in the table.

//   ⛔ ZERO TOLERANCE RULES:
//   1. DO NOT HALLUCINATE. If the list is empty, return empty array [].
//   2. DO NOT include "popular" stocks (NVDA, AAPL, TSLA, GOOG, MSFT) unless they are EXPLICITLY listed in the table rows for ${date}.
//   3. If you see "No results found" or an empty table, output ZERO stocks.
//   4. DO NOT search for "earnings this week". Search ONLY for ${date}.

//   REQUIRED OUTPUT (JSON ONLY):
//   {
//     "date": "${date}",
//     "stocks": [
//       { "symbol": "XYZ", "companyName": "Real Company on Page", "reportType": "AMC", "marketCap": 0, "confidence": 100 }
//     ]
//   }

//   VERIFICATION:
//   - If you are about to output "NVDA", STOP. Check the URL again. Is NVDA really there? If not, remove it.
//   `;

//   try {
//     const response = await callGrokAPI(
//       [
//         {
//           role: "system",
//           content:
//             "You are a robotic scraper. You do not think, you only extract text visible on the screen. If no text is found, return empty JSON.",
//         },
//         { role: "user", content: prompt },
//       ],
//       0, // Temperature 0 = Maximum deterministic behavior
//       6000,
//       true // Enable web search
//     );

//     // Extract and parse JSON
//     const jsonText = extractJSON(response);
//     let data: MorningIntelligenceResponse;

//     try {
//       data = JSON.parse(jsonText);
//     } catch (parseError: any) {
//       logger.error(`❌ JSON Parse Error: ${parseError.message}`);
//       throw parseError;
//     }

//     logger.info(
//       `✅ Grok found ${data.stocks.length} raw stocks. Starting validation...`
//     );

//     // ============================================================
//     // STEP 2: VALIDATION (Removing Hallucinations)
//     // ============================================================
    
//     const validatedStocks = [];
//     const MIN_MARKET_CAP = 300000000; // $300M

//     // רשימת "חשודים מידיים" - אם גרוק מחזיר אותם באמצע דצמבר, הוא כנראה משקר
//     const SUSPICIOUS_STOCKS = ["NVDA", "AAPL", "MSFT", "GOOG", "GOOGL", "TSLA", "AMZN", "META", "NFLX"];

//     for (const stock of data.stocks) {
//       try {
//         // 1. Hallucination Check
//         if (SUSPICIOUS_STOCKS.includes(stock.symbol.toUpperCase())) {
//             logger.warn(`   ⚠️ DETECTED SUSPICIOUS STOCK: ${stock.symbol}. This is likely a hallucination for date ${date}. SKIPPING.`);
//             continue; 
//         }

//         // 2. Foreign Stock Check
//         if (stock.symbol.includes(".")) {
//           continue;
//         }

//         // 3. Market Cap Check
//         if (!stock.marketCap || stock.marketCap === 0) {
//             logger.info(`   🔍 Checking Market Cap for ${stock.symbol}...`);
//             try {
//                 const cap = await getMarketCap(stock.symbol);
//                 stock.marketCap = cap;
//             } catch (e) {
//                 logger.warn(`   ⚠️ Could not fetch cap for ${stock.symbol}, skipping.`);
//                 continue; 
//             }
//         }

//         if (stock.marketCap >= MIN_MARKET_CAP) {
//             logger.info(`   ✅ APPROVED: ${stock.symbol} ($${(stock.marketCap/1e9).toFixed(2)}B)`);
//             validatedStocks.push(stock);
//         } else {
//             logger.info(`   ❌ REJECTED: ${stock.symbol} (Small Cap)`);
//         }
        
//         await delay(500); 

//       } catch (err) {
//         logger.error(`   ❌ Error processing ${stock.symbol}`, err);
//       }
//     }

//     data.stocks = validatedStocks;
    
//     if (validatedStocks.length === 0) {
//         logger.info(`📭 No valid US stocks found reporting on ${date}. (This is good! It means no hallucinations).`);
//     } else {
//         logger.info(`\n   🎯 Final List: ${validatedStocks.length} stocks ready.\n`);
//     }

//     return data;
//   } catch (error) {
//     logger.error("❌ Morning Intelligence failed:", error);
//     throw error;
//   }
// }



export async function morningIntelligence(
  date: string // Format: YYYY-MM-DD
): Promise<MorningIntelligenceResponse> {
  logger.info(`🌅 Running Morning Intelligence (Finnhub Source) for ${date}...`);

  // בדיקת API KEY
  const FINNHUB_API_KEY = "d50m00pr01qm94qmq7kgd50m00pr01qm94qmq7l0";
  if (!FINNHUB_API_KEY) {
    throw new Error("❌ Missing FINNHUB_API_KEY in environment variables");
  }

  try {
    // ============================================================
    // STEP 1: FETCH DATA FROM FINNHUB
    // ============================================================
    const url = `https://finnhub.io/api/v1/calendar/earnings`;
    logger.info(`📡 Calling Finnhub API for earnings...`);
    
    // קריאה לפינהאב
    const response = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(url, {
      params: {
        from: date,
        to: date,
        token: FINNHUB_API_KEY
      }
    });

    const rawList = response.data.earningsCalendar || [];
    logger.info(`✅ Finnhub returned ${rawList.length} raw entries.`);

    // ============================================================
    // STEP 2: FILTER & ENRICH TO MATCH 'Stock' INTERFACE
    // ============================================================
    
    const validatedStocks: Stock[] = [];
    const MIN_MARKET_CAP = 300_000_000; // $300M

    for (const entry of rawList) {
      const symbol = entry.symbol.toUpperCase();

      // סינון ראשוני: נקודות (מניות זרות), טיקרים ארוכים, או חוסר במידע זמן
      if (symbol.includes(".") || symbol.length > 5 || !entry.hour) {
        continue;
      }

      try {
        // A. בדיקת שווי שוק (Market Cap)
        const cap = await getMarketCap(symbol);
        if (!cap || cap < MIN_MARKET_CAP) {
           continue; // דילוג על מניות קטנות
        }

        // B. השלמת ווליום (Volume) - נדרש לפי האינטרפייס שלך
        // משתמשים בפונקציה getTradingVolume שקיימת אצלך בקוד
        let volume = 0;
        try {
            volume = await getTradingVolume(symbol);
        } catch (e) {
            logger.warn(`⚠️ Could not fetch volume for ${symbol}, defaulting to 0`);
        }

        // C. חישוב חלונות זמנים (Windows) וסוג דיווח
        // המרה של הנתון הגולמי מפינהאב (bmo/amc) לפורמט שלך
        let reportType: "BMO" | "AMC" = "AMC"; // ברירת מחדל
        let windowStart = "16:05";
        let windowEnd = "20:00";

        const rawHour = entry.hour.toLowerCase();

        if (rawHour === 'bmo') {
            reportType = "BMO";
            windowStart = "07:00";
            windowEnd = "09:30"; // לפני הפתיחה
        } else if (rawHour === 'amc') {
            reportType = "AMC";
            windowStart = "16:05"; // קצת אחרי הסגירה
            windowEnd = "20:00";
        } else {
            // אם כתוב 'dmh' (במהלך המסחר) או משהו לא ברור, נסווג כ-AMC לבדיקה בסוף היום
            reportType = "AMC"; 
        }

        logger.info(` 💎 Found Gem: ${symbol} | Type: ${reportType} | Cap: $${(cap / 1e9).toFixed(2)}B`);

        // D. בניית האובייקט הסופי לפי המבנה של Stock
        const stockObj: Stock = {
            symbol: symbol,
            companyName: symbol, // פינהאב לא נותן שם מלא, נשאיר סימבול בינתיים
            reportType: reportType,
            windowStart: windowStart,
            windowEnd: windowEnd,
            marketCap: cap,
            volume: volume,
            confidence: 100, // זה מגיע מ-API רשמי, אז הוודאות גבוהה
            sources: ["Finnhub API"]
        };
           
        validatedStocks.push(stockObj);

        // Rate Limit Protection
        await delay(300); 

      } catch (err) {
        logger.warn(`⚠️ Error processing ${symbol}, skipping.`);
      }
    }

    // מיון לפי שווי שוק
    validatedStocks.sort((a, b) => b.marketCap - a.marketCap);

    logger.info(`\n 🎯 Final Clean List: ${validatedStocks.length} stocks ready for automation.\n`);

    return {
      date,
      stocks: validatedStocks
    };

  } catch (error: any) {
    logger.error("❌ Finnhub Morning Intelligence failed:", error.message);
    throw error;
  }
}








// ============================================
// 2. MINI-CHECK (INDIVIDUAL STOCK)
// ============================================

export async function miniCheck(
  symbol: string,
  companyName: string
): Promise<MiniCheckResponse> {
  logger.info(`🔍 Mini-Check for ${symbol}...`);

  const now = new Date().toISOString();
  const today = now.split("T")[0];

  const prompt = `Quick verification task.
Company: ${symbol} (${companyName})
Current time: ${now}
Today's date: ${today}

Question: Has this company published their quarterly earnings report TODAY (${today})?

Search for:
1. Recent news about ${symbol} earnings
2. Company IR website for press releases
3. SEC EDGAR for 8-K filings today
4. Financial news sites (Bloomberg, Reuters, CNBC)

Answer with ONE WORD ONLY:
- YES (if earnings report was published TODAY)
- NO (if earnings report NOT published today)
- UNSURE (if you cannot determine)

No explanation needed.`;

  try {
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You are a quick fact checker. Answer with ONE word only: YES, NO, or UNSURE.",
        },
        { role: "user", content: prompt },
      ],
      0.1,
      10,
      true // Enable web search for accuracy
    );

    const result = response.trim().toUpperCase() as MiniCheckResult;

    if (!["YES", "NO", "UNSURE"].includes(result)) {
      logger.warn(
        `⚠️ Unexpected Mini-Check response: "${response}". Defaulting to UNSURE.`
      );
      return {
        symbol,
        checkTime: now,
        result: "UNSURE",
      };
    }

    logger.info(`✅ Mini-Check for ${symbol}: ${result}`);

    return {
      symbol,
      checkTime: now,
      result,
    };
  } catch (error) {
    logger.error(`❌ Error in Mini-Check for ${symbol}:`, error);
    return {
      symbol,
      checkTime: now,
      result: "UNSURE",
    };
  }
}

// ============================================
// 3. FULL EXTRACTION (OPTIMIZED WITH TARGETED IR SEARCH)
// ============================================

export async function fullExtraction(
  symbol: string,
  companyName: string,
  reportDate: string
): Promise<FullExtractionResponse> {
  logger.info(`📊 Full Extraction for ${symbol} (${companyName})...`);

  // Step 1: Find the Investor Relations site
  const irPrompt = `Find the official Investor Relations website for ${companyName} (${symbol}).

Search for: "IR ${companyName}" OR "${companyName} investor relations"

Return ONLY the URL to the investor relations page.
Example: https://investor.nvidia.com/`;

  let irUrl = "";
  try {
    logger.info(`   🔍 Step 1: Finding IR website for ${symbol}...`);
    const irResponse = await callGrokAPI(
      [
        {
          role: "system",
          content: "You return only URLs. No explanation, just the URL.",
        },
        { role: "user", content: irPrompt },
      ],
      0.1,
      100,
      true
    );
    irUrl = irResponse.trim();
    logger.info(`   ✅ IR Website: ${irUrl}`);
  } catch (error) {
    logger.warn(`   ⚠️ Could not find IR website, will use alternative sources`);
  }

  // Step 2: Extract financial data from targeted sources
  const extractionPrompt = `You are a financial data extraction specialist.
Company: ${symbol} (${companyName})
Report Date: ${reportDate}

🎯 MISSION: Extract ALL financial data from the quarterly earnings report

📍 SEARCH PRIORITY:
1. ${irUrl ? `Company IR site: ${irUrl}` : `Company Investor Relations (search "IR ${companyName}")`}
2. SEC EDGAR - 8-K filing for ${symbol}
3. Press releases from ${companyName}
4. Bloomberg, Reuters, CNBC for ${symbol} earnings ${reportDate}
5. Yahoo Finance ${symbol} earnings

📊 DATA REQUIRED:

MARKET DATA:
- Current stock price
- Market capitalization
- Trading volume today
- Company name

EARNINGS PER SHARE (EPS):
- Actual EPS
- Estimated EPS (analyst consensus)
- Beat/miss amount
- Beat/miss percentage

REVENUE:
- Actual revenue ($)
- Estimated revenue ($)
- Beat/miss amount
- Beat/miss percentage

YEAR-OVER-YEAR GROWTH:
- EPS YoY change (%)
- Revenue YoY change (%)

FREE CASH FLOW:
- Current quarter FCF
- Prior year same quarter FCF
- YoY change (%)

PROFIT MARGINS:
- Gross margin (%)
- Operating margin (%)
- Net profit margin (%)
- Change from prior quarter
- Trend: "improving" / "stable" / "declining"

GUIDANCE:
- Status: "raised" / "maintained" / "lowered" / "unavailable"
- Details
- Comparison to prior guidance
- Analyst expectations

SENTIMENT:
- Overall: "positive" / "neutral" / "negative"
- Sentiment score: -1.0 to +1.0
- Social media mentions
- Analyst reactions
- Price movement post-announcement (%)

HIGHLIGHTS & CONCERNS:
- Key positive points
- Key negative points
- Management commentary

⚠️ QUALITY RULES:
- NEVER invent numbers
- If data unavailable → set to null
- Always include source URLs
- Cross-reference between sources
- Flag any conflicting data

📤 RETURN FORMAT - JSON ONLY (no markdown, no extra text):
{
  "symbol": "${symbol}",
  "companyName": "${companyName}",
  "reportDate": "${reportDate}",
  "reportTime": "16:05",
  "marketData": {
    "price": 185.32,
    "marketCap": 2850000000000,
    "volume": 58423000,
    "source": "https://..."
  },
  "eps": {
    "actual": 2.18,
    "estimate": 2.10,
    "beat": 0.08,
    "beatPercent": 3.81,
    "source": "https://..."
  },
  "revenue": {
    "actual": 124500000000,
    "estimate": 124000000000,
    "beat": 500000000,
    "beatPercent": 0.40,
    "source": "https://..."
  },
  "yoyGrowth": {
    "epsChange": 12.5,
    "revenueChange": 8.3,
    "source": "https://..."
  },
  "cashFlow": {
    "currentFCF": 28500000000,
    "priorYearFCF": 24800000000,
    "yoyChange": 14.9,
    "source": "https://..."
  },
  "margins": {
    "grossMargin": 44.1,
    "operatingMargin": 30.2,
    "netMargin": 25.3,
    "changeFromPrior": 0.8,
    "trend": "improving",
    "source": "https://..."
  },
  "guidance": {
    "status": "raised",
    "details": "Q2 revenue guidance $90-93B vs prior $88-91B",
    "analystExpectation": "$89B",
    "beat": true,
    "source": "https://..."
  },
  "sentiment": {
    "overall": "positive",
    "score": 0.75,
    "socialMediaMentions": 1847,
    "analystReactions": ["Morgan Stanley: Upgrade to Overweight"],
    "priceChange": 3.2,
    "sources": ["https://..."]
  },
  "highlights": [
    "iPhone revenue beat expectations by 5%",
    "Services revenue hit all-time high"
  ],
  "concerns": [
    "Mac sales down 8% YoY"
  ],
  "managementCommentary": "Tim Cook: 'We're pleased...'",
  "dataQuality": {
    "completeness": 95,
    "confidence": 90,
    "crossValidated": true,
    "sources": ["https://..."]
  },
  "aiRecommendation": {
    "decision": "SEND",
    "reasoning": "All critical data found with high confidence"
  }
}

🚦 AI DECISION LOGIC:
- completeness > 80% AND confidence > 75% → "SEND"
- completeness 60-80% OR confidence 60-75% → "SEND_WITH_WARNING"
- completeness < 60% OR confidence < 60% → "WAIT"
- No report found at all → "NOT_PUBLISHED_YET"

Return ONLY valid JSON.`;

  try {
    logger.info(`   🔍 Step 2: Extracting financial data...`);
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You are a financial data extraction expert. Always return valid JSON only.",
        },
        { role: "user", content: extractionPrompt },
      ],
      0.2,
      4000,
      true // Enable web search for data extraction
    );

    // Extract and parse JSON
    const jsonText = extractJSON(response);
    const data: FullExtractionResponse = JSON.parse(jsonText);

    logger.info(`✅ Full Extraction for ${symbol} completed`);
    logger.info(
      `   📊 EPS: ${data.eps.actual} vs ${data.eps.estimate} (${data.eps.beatPercent}%)`
    );
    logger.info(
      `   💰 Revenue: $${data.revenue.actual} vs $${data.revenue.estimate} (${data.revenue.beatPercent}%)`
    );
    logger.info(
      `   📈 Data Quality: ${data.dataQuality.completeness}% complete, ${data.dataQuality.confidence}% confident`
    );
    logger.info(`   🚦 AI Recommendation: ${data.aiRecommendation.decision}`);

    return data;
  } catch (error) {
    logger.error(`❌ Error in Full Extraction for ${symbol}:`, error);
    throw error;
  }
}

// ============================================
// 4. FINAL ANALYSIS (HEBREW) - UNCHANGED
// ============================================

export async function finalAnalysis(
  fullData: FullExtractionResponse,
  miraScore: MiraScore
): Promise<FinalAnalysis> {
  logger.info(`🎯 Final Analysis (Hebrew) for ${fullData.symbol}...`);

  // Calculate trading recommendation
  const price = fullData.marketData.price || 0;
  let direction: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  let entryPrice = price;
  let targetPrice = null;
  let stopPrice = null;

  if (miraScore.totalScore >= 2) {
    direction = "LONG";
    targetPrice = price * 1.05; // 5% upside
    stopPrice = price * 0.97; // 3% stop loss
  } else if (miraScore.totalScore <= -2) {
    direction = "SHORT";
    targetPrice = price * 0.95; // 5% downside target
    stopPrice = price * 1.03; // 3% stop loss
  }

  const tradingRecommendation = {
    direction,
    entryPrice: price || null,
    targetPrice,
    stopPrice,
  };

  // Build score breakdown text
  const scoreBreakdownText = `
EPS: ${miraScore.breakdown.epsScore.toFixed(1)}
Revenue: ${miraScore.breakdown.revenueScore.toFixed(1)}
Guidance: ${miraScore.breakdown.guidanceScore.toFixed(1)}
YoY EPS: ${miraScore.breakdown.yoyEpsScore.toFixed(1)}
YoY Revenue: ${miraScore.breakdown.yoyRevenueScore.toFixed(1)}
FCF: ${miraScore.breakdown.fcfScore.toFixed(1)}
Margins: ${miraScore.breakdown.marginScore.toFixed(1)}
Sentiment: ${miraScore.breakdown.sentimentScore.toFixed(1)}
  `.trim();

  const exceptionsText =
    miraScore.exceptions.length > 0
      ? miraScore.exceptions.map((e) => `• ${e}`).join("\n")
      : "אין חריגים";

  const prompt = `You are Mira - an AI financial analyst writing in Hebrew.

I have complete earnings data for ${fullData.symbol}:

📊 EARNINGS DATA:
- Symbol: ${fullData.symbol}
- Company: ${fullData.companyName}
- Report Date: ${fullData.reportDate}
- EPS: $${fullData.eps.actual} vs $${fullData.eps.estimate} (${fullData.eps.beatPercent}%)
- Revenue: $${fullData.revenue.actual} vs $${fullData.revenue.estimate} (${fullData.revenue.beatPercent}%)
- YoY Growth: EPS ${fullData.yoyGrowth.epsChange}% | Revenue ${fullData.yoyGrowth.revenueChange}%
- FCF Change: ${fullData.cashFlow.yoyChange}% YoY
- Margins: ${fullData.margins.trend} (Gross: ${fullData.margins.grossMargin}%, Operating: ${fullData.margins.operatingMargin}%, Net: ${fullData.margins.netMargin}%)
- Guidance: ${fullData.guidance.status}
- Sentiment: ${fullData.sentiment.overall} (score: ${fullData.sentiment.score})
- Highlights: ${fullData.highlights.join(", ")}
- Concerns: ${fullData.concerns.join(", ")}

⚖️ MIRA SCORE:
- Total Score: ${miraScore.totalScore}
- Classification: ${miraScore.classification}
- Breakdown:
${scoreBreakdownText}
- Exceptions:
${exceptionsText}

📈 TRADING RECOMMENDATION:
- Direction: ${tradingRecommendation.direction}
- Entry: $${tradingRecommendation.entryPrice?.toFixed(2)}
- Target: $${tradingRecommendation.targetPrice?.toFixed(2)}
- Stop: $${tradingRecommendation.stopPrice?.toFixed(2)}

Write analysis in Hebrew for Telegram in this EXACT format:

📌 סימול: ${fullData.symbol}
🏢 חברה: ${fullData.companyName}
📅 תאריך דוח: ${fullData.reportDate}

📊 תוצאות מרכזיות:
• EPS: $${fullData.eps.actual} מול תחזית $${fullData.eps.estimate} (${fullData.eps.beatPercent && fullData.eps.beatPercent > 0 ? "⬆️" : "⬇️"} ${fullData.eps.beatPercent}%)
• Revenue: $${fullData.revenue.actual} מול תחזית $${fullData.revenue.estimate} (${fullData.revenue.beatPercent && fullData.revenue.beatPercent > 0 ? "⬆️" : "⬇️"} ${fullData.revenue.beatPercent}%)
• Guidance: [emoji] ${fullData.guidance.status}
• Free Cash Flow: [emoji] ${fullData.cashFlow.yoyChange}% YoY
• YoY: EPS ${fullData.yoyGrowth.epsChange}% | Revenue ${fullData.yoyGrowth.revenueChange}%
• Margins: ${fullData.margins.trend}
• Sentiment: ${fullData.sentiment.overall}

⚖️ ניקוד כולל: ${miraScore.totalScore}
🏁 סיווג סופי: ${miraScore.classification}

🧩 חריגים חכמים:
${exceptionsText}

📈 המלצת מסחר:
${tradingRecommendation.direction === "LONG" ? "🔵" : tradingRecommendation.direction === "SHORT" ? "🔴" : "⚪"} כיוון: ${tradingRecommendation.direction}
📍 כניסה: $${tradingRecommendation.entryPrice?.toFixed(2)}
🎯 יעד: $${tradingRecommendation.targetPrice?.toFixed(2)}
🛑 סטופ: $${tradingRecommendation.stopPrice?.toFixed(2)}

🤖 שיקול דעת AI:
[Write 2-3 sentences in Hebrew explaining WHY this classification, key strengths/weaknesses]

📝 מסקנה:
[Write 1-2 sentences in Hebrew with clear recommendation for investors]

⚠️ מקורות נתונים:
• Grok AI (Real-time web search)
• רמת ודאות: ${fullData.dataQuality.confidence}%

Guidelines:
- Write ONLY in Hebrew (except numbers, symbols, and technical terms)
- Keep it concise and actionable
- Focus on what matters most
- Be direct and confident
- Use appropriate emojis for guidance and FCF status

Return the COMPLETE Hebrew formatted message ready to send to Telegram.`;

  try {
    const response = await callGrokAPI(
      [
        {
          role: "system",
          content:
            "You are Mira, a Hebrew-speaking financial analyst. Write clear, concise Hebrew analysis.",
        },
        { role: "user", content: prompt },
      ],
      0.4,
      2000,
      false
    );

    logger.info(`✅ Final Analysis (Hebrew) for ${fullData.symbol} completed`);

    const finalAnalysis: FinalAnalysis = {
      symbol: fullData.symbol,
      date: fullData.reportDate,
      summary: response.trim(),
      miraScore,
      tradingRecommendation,
      aiReasoning: response.trim(),
      conclusion: response.trim(),
      dataSources: fullData.dataQuality.sources,
      confidence: fullData.dataQuality.confidence,
    };

    return finalAnalysis;
  } catch (error) {
    logger.error(`❌ Error in Final Analysis for ${fullData.symbol}:`, error);
    throw error;
  }
}

// ============================================
// 5. STOCK PROCESSOR CLASS (NEW)
// ============================================

export class StockProcessor {
  private stocks: StockProcessingState[] = [];
  private isRunning: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(private onComplete?: (stock: StockProcessingState) => void) {}

  // Initialize with stocks from morning intelligence
  initialize(morningData: MorningIntelligenceResponse): void {
    logger.info(`🚀 Initializing Stock Processor with ${morningData.stocks.length} stocks`);

    this.stocks = morningData.stocks.map((stock) => ({
      symbol: stock.symbol,
      companyName: stock.companyName,
      reportType: stock.reportType,
      windowStart: stock.windowStart,
      windowEnd: stock.windowEnd,
      marketCap: stock.marketCap,
      volume: stock.volume,
      status: "pending" as ProcessingStatus,
      lastCheck: null,
      checkCount: 0,
      error: null,
      fullData: null,
      analysis: null,
    }));

    logger.info(`✅ Stock Processor initialized with ${this.stocks.length} stocks`);
    this.stocks.forEach((stock) => {
      logger.info(
        `   - ${stock.symbol} (${stock.companyName}): ${stock.reportType} ${stock.windowStart}-${stock.windowEnd}`
      );
    });
  }

  // Start the scheduled processor
  start(): void {
    if (this.isRunning) {
      logger.warn("⚠️ Stock Processor is already running");
      return;
    }

    logger.info(`🚀 Starting Stock Processor (checks every ${CHECK_INTERVAL_MS / 1000}s)`);
    this.isRunning = true;

    // Run immediately, then schedule
    this.processNextStock();

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.processNextStock();
    }, CHECK_INTERVAL_MS);
  }

  // Stop the processor
  stop(): void {
    logger.info("🛑 Stopping Stock Processor...");
    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    logger.info("✅ Stock Processor stopped");
  }

  // Process next pending or checking stock
  private async processNextStock(): Promise<void> {
    if (!this.isRunning) return;

    // Find next stock to process
    const stock = this.stocks.find(
      (s) => s.status === "pending" || s.status === "checking"
    );

    if (!stock) {
      logger.info("✅ All stocks processed!");
      this.stop();
      return;
    }

    try {
      logger.info(`\n${"=".repeat(60)}`);
      logger.info(`📦 Processing: ${stock.symbol} (${stock.companyName})`);
      logger.info(`   Status: ${stock.status} | Check #${stock.checkCount + 1}`);
      logger.info(`${"=".repeat(60)}\n`);

      stock.status = "checking";
      stock.checkCount += 1;
      stock.lastCheck = new Date().toISOString();

      // Step 1: Mini-Check - Is report published?
      const miniCheckResult = await miniCheck(stock.symbol, stock.companyName);

      if (miniCheckResult.result === "YES") {
        // Report published! Extract full data
        logger.info(`✅ Report published for ${stock.symbol}! Extracting data...`);
        stock.status = "extracting";

        // Add delay before extraction to be respectful to API
        await delay(2000);

        // Step 2: Full Extraction
        const fullData = await fullExtraction(
          stock.symbol,
          stock.companyName,
          stock.lastCheck.split("T")[0]
        );

        stock.fullData = fullData;

        // Check AI recommendation
        if (
          fullData.aiRecommendation.decision === "SEND" ||
          fullData.aiRecommendation.decision === "SEND_WITH_WARNING"
        ) {
          // Step 3: Final Analysis (Hebrew)
          logger.info(`📝 Generating final analysis for ${stock.symbol}...`);

          // Add delay before analysis
          await delay(2000);

          // Calculate Mira Score (simplified - you may have a more complex logic)
          const miraScore: MiraScore = {
            totalScore: this.calculateMiraScore(fullData),
            classification: "POSITIVE", // Simplified
            breakdown: {
              epsScore: fullData.eps.beatPercent || 0,
              revenueScore: fullData.revenue.beatPercent || 0,
              guidanceScore: fullData.guidance.status === "raised" ? 1 : 0,
              yoyEpsScore: fullData.yoyGrowth.epsChange || 0,
              yoyRevenueScore: fullData.yoyGrowth.revenueChange || 0,
              fcfScore: fullData.cashFlow.yoyChange || 0,
              marginScore: fullData.margins.changeFromPrior || 0,
              sentimentScore: fullData.sentiment.score || 0,
            },
            exceptions: [],
          };

          const analysis = await finalAnalysis(fullData, miraScore);
          stock.analysis = analysis;

          stock.status = "completed";
          logger.info(`✅ ${stock.symbol} completed successfully!`);

          // Callback for sending to Telegram
          if (this.onComplete) {
            this.onComplete(stock);
          }
        } else if (fullData.aiRecommendation.decision === "WAIT") {
          logger.info(`⏳ ${stock.symbol} - Data incomplete, will check again later`);
          stock.status = "checking";
        } else {
          logger.info(`⏭️ ${stock.symbol} - Report not published yet`);
          stock.status = "checking";
        }
      } else if (miniCheckResult.result === "NO") {
        logger.info(`⏳ ${stock.symbol} - Report not published yet, will check again`);
        stock.status = "checking";
      } else {
        // UNSURE
        logger.info(`❓ ${stock.symbol} - Status unclear, will check again`);
        stock.status = "checking";
      }

      // Add delay between stocks to avoid rate limits
      if (this.isRunning) {
        logger.info(`\n⏳ Waiting ${DELAY_BETWEEN_STOCKS_MS / 1000}s before next stock...\n`);
        await delay(DELAY_BETWEEN_STOCKS_MS);
      }
    } catch (error) {
      logger.error(`❌ Error processing ${stock.symbol}:`, error);
      stock.status = "error";
      stock.error = error instanceof Error ? error.message : "Unknown error";

      // Add delay even on error
      await delay(DELAY_BETWEEN_STOCKS_MS);
    }
  }

  // Simple Mira Score calculation (you can enhance this)
  private calculateMiraScore(data: FullExtractionResponse): number {
    let score = 0;

    // EPS beat/miss
    if (data.eps.beatPercent) {
      score += data.eps.beatPercent > 0 ? 1 : -1;
    }

    // Revenue beat/miss
    if (data.revenue.beatPercent) {
      score += data.revenue.beatPercent > 0 ? 1 : -1;
    }

    // Guidance
    if (data.guidance.status === "raised") score += 1;
    if (data.guidance.status === "lowered") score -= 1;

    // Sentiment
    if (data.sentiment.score) {
      score += data.sentiment.score > 0.5 ? 1 : data.sentiment.score < -0.5 ? -1 : 0;
    }

    return score;
  }

  // Get current status
  getStatus(): {
    total: number;
    pending: number;
    checking: number;
    extracting: number;
    completed: number;
    error: number;
  } {
    return {
      total: this.stocks.length,
      pending: this.stocks.filter((s) => s.status === "pending").length,
      checking: this.stocks.filter((s) => s.status === "checking").length,
      extracting: this.stocks.filter((s) => s.status === "extracting").length,
      completed: this.stocks.filter((s) => s.status === "completed").length,
      error: this.stocks.filter((s) => s.status === "error").length,
    };
  }

  // Get all stocks
  getStocks(): StockProcessingState[] {
    return this.stocks;
  }
}

// ============================================
// EXPORT ALL FUNCTIONS
// ============================================

export default {
  fetchUSStocksViaGrok,
  morningIntelligence,
  miniCheck,
  fullExtraction,
  finalAnalysis,
  StockProcessor,
};
