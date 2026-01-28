import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import logger, { stockLog } from '../utils/structureLogger';
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
import fs from "fs";
import path from "path";
dotenv.config({ quiet: true });

const GROK_API_KEY = process.env.GROK_API_KEY;
const GROK_MODEL = "grok-3"; 
const MAX_API_RETRIES = 2;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 10 minutes between iterations
const DELAY_BETWEEN_STOCKS_MS = 5000; // 5 seconds between individual stock checks
const MAX_CHECK_ATTEMPTS = 10; // Stop checking after 10 failed attempts
const WINDOW_BUFFER_HOURS = 3; // Check stocks ±3 hours from their window
const MIN_MARKET_CAP = 300_000_000; 
const MIN_VOLUME = 3_000_000; 
interface ExtendedStock extends Stock {
    quarter?: number;
    fiscalYear?: number;
}

interface GrokResponseNew {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: any[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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

interface IRPortal {
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
// Grok API Calls - עדכון להתאים לחתימה הקיימת
// ═══════════════════════════════════════════════════════════════

async function callGrokAPI(
  messages: GrokMessage[],
  temperature: number = 0.3,
  maxTokens: number = 4000,
  enableWebSearch: boolean = false
): Promise<string> {
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY missing");

  const GROK_API_URL = "https://api.x.ai/v1/responses";
  
  const requestBody: any = {
    model: "grok-4-fast-reasoning",
    input: messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  if (enableWebSearch) {
    requestBody.tools = [
      {
        type: "web_search"
      }
    ];
  }

  logger.info(`\n🔹 Grok API Request:`);
  logger.info(`   Model: ${requestBody.model}`);
  logger.info(`   Temperature: ${temperature}`);
  logger.info(`   Max Tokens: ${maxTokens}`);
  logger.info(`   Web Search: ${enableWebSearch ? 'ENABLED' : 'DISABLED'}`);
  logger.info(`   Messages: ${messages.length} message(s)`);
  if (messages[0]?.content) {
    logger.info(`   First message preview: ${messages[0].content.substring(0, 150)}...`);
  }

  for (let attempt = 0; attempt < MAX_API_RETRIES; attempt++) {
    try {
      logger.info(`\n🔄 API Call Attempt ${attempt + 1}/${MAX_API_RETRIES }...`);
      
      const response = await axios.post(
        GROK_API_URL,
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROK_API_KEY}`
          },
          timeout: enableWebSearch ? 90000 : 60000,
        }
      );

      logger.info(`\n📥 Raw API Response:`);
      logger.info(`   Status: ${response.status}`);
      logger.info(`   Response keys: ${Object.keys(response.data).join(', ')}`);
      
      let content = null;
      
      // נסיון 1: response.content (Responses API)
      if (response.data.response?.content) {
        content = response.data.response.content;
        logger.info(`   ✅ Found content via response.content`);
      }
      // נסיון 2: choices[0].message.content (Chat API)
      else if (response.data.choices?.[0]?.message?.content) {
        content = response.data.choices[0].message.content;
        logger.info(`   ✅ Found content via choices[0].message.content`);
      }
      // נסיון 3: output
      else if (response.data.output) {
        content = response.data.output;
        logger.info(`   ✅ Found content via output`);
      }
      // נסיון 4: text
      else if (response.data.text) {
        content = response.data.text;
        logger.info(`   ✅ Found content via text`);
      }
      else {
        logger.error(`\n❌ Could not find content in response!`);
        logger.error(`   Full response data: ${JSON.stringify(response.data, null, 2)}`);
        throw new Error("Content not found in response structure");
      }
      
      // ✅ FIX: Convert content to string if it's not already
      let contentStr: string|null=null;
      
      // First, check if content is a JSON string that needs parsing
      if (typeof content === 'string' && (content.startsWith('[{') || content.startsWith('{'))) {
        try {
          const parsed = JSON.parse(content);
          content = parsed; // Use parsed version
          logger.info(`   ℹ️  Content was JSON string, parsed it`);
        } catch (e) {
          // Not valid JSON, use as-is
          contentStr = content;
          logger.info(`   ℹ️  Content is string (not JSON)`);
        }
      }
      
      if (typeof content === 'string' && contentStr) {
        // Already set above
      } else if (typeof content === 'string') {
        contentStr = content;
      } else if (Array.isArray(content)) {
        // Handle array of content blocks (Grok Responses API format)
        logger.info(`   ℹ️  Content is array with ${content.length} items`);
        
        // Log first item structure for debugging
        if (content.length > 0) {
          logger.info(`   🔍 First item type: ${content[0].type}, keys: ${Object.keys(content[0]).join(', ')}`);
        }
        
        // Try to find text in the array
        for (const item of content) {
          // Check for direct text fields
          if (item.type === 'output_text' && item.text) {
            contentStr = item.text;
            logger.info(`   ✅ Extracted text from output_text block`);
            break;
          } else if (item.type === 'text' && item.text) {
            contentStr = item.text;
            logger.info(`   ✅ Extracted text from text block`);
            break;
          } else if (item.type === 'message' && item.content) {
            // Handle message type with nested content
            if (Array.isArray(item.content)) {
              const textContent = item.content.find((c: any) => 
                (c.type === 'output_text' || c.type === 'text') && c.text
              );
              if (textContent) {
                contentStr = textContent.text;
                logger.info(`   ✅ Extracted text from message.content array`);
                break;
              }
            } else if (typeof item.content === 'string') {
              contentStr = item.content;
              logger.info(`   ✅ Extracted string from message.content`);
              break;
            }
          } else if (item.content && Array.isArray(item.content)) {
            // Nested content array (any type)
            const nestedText = item.content.find((c: any) => 
              (c.type === 'output_text' || c.type === 'text') && c.text
            );
            if (nestedText) {
              contentStr = nestedText.text;
              logger.info(`   ✅ Extracted text from nested content in array item`);
              break;
            }
          } else if (typeof item === 'string') {
            contentStr = item;
            logger.info(`   ✅ Found string in array`);
            break;
          }
        }
        
        // If still no text found, stringify the whole thing
        if (!contentStr) {
          logger.warn(`   ⚠️ Could not extract text from array`);
          logger.warn(`   💡 Array structure: ${JSON.stringify(content.slice(0, 1), null, 2)}`);
          contentStr = JSON.stringify(content);
        }
      } else if (typeof content === 'object') {
        // Handle object with nested content
        if (content.content && Array.isArray(content.content)) {
          // Recursive case: content has a content array
          logger.info(`   ℹ️  Content object has nested content array`);
          const nestedItem = content.content.find((item: any) => 
            (item.type === 'output_text' || item.type === 'text') && item.text
          );
          if (nestedItem) {
            contentStr = nestedItem.text;
            logger.info(`   ✅ Extracted text from nested content`);
          } else {
            contentStr = JSON.stringify(content);
            logger.warn(`   ⚠️ No text in nested content, stringifying`);
          }
        } else if (content.text) {
          contentStr = content.text;
          logger.info(`   ✅ Extracted from content.text`);
        } else {
          // Last resort: stringify
          contentStr = JSON.stringify(content);
          logger.info(`   ℹ️  Content was object, converted to JSON string`);
        }
      } else {
        // Convert any other type to string
        contentStr = String(content);
        logger.info(`   ℹ️  Content was ${typeof content}, converted to string`);
      }
      
      if (!contentStr || contentStr.trim().length === 0) {
        logger.error(`   ❌ Content is empty or null`);
        throw new Error("Grok returned empty response");
      }

      logger.info(`   ✅ Content length: ${contentStr.length} chars`);
      logger.info(`   Preview: ${contentStr.substring(0, 200)}...`);

      return contentStr;

    } catch (error) {
      logger.error(`\n❌ API Call Failed (Attempt ${attempt + 1}/${MAX_API_RETRIES}):`);
      
      if (axios.isAxiosError(error)) {
        logger.error(`   Error Type: Axios Error`);
        logger.error(`   Status: ${error.response?.status || 'N/A'}`);
        logger.error(`   Status Text: ${error.response?.statusText || 'N/A'}`);
        
        if (error.response?.data) {
          logger.error(`   Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
        }
        
        // Rate limit
        if (error.response?.status === 429 && attempt < MAX_API_RETRIES) {
          const waitTime = 60000 * (attempt + 1);
          logger.warn(`   ⏳ Rate limit hit, waiting ${waitTime / 1000}s...`);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }

        // Model not found
        if (error.response?.status === 404) {
          logger.error(`   ❌ Model '${requestBody.model}' not found!`);
          throw new Error(`Model '${requestBody.model}' not found. Try: grok-2-1212, grok-beta, or grok-2-latest`);
        }

        // Bad request
        if (error.response?.status === 400) {
          const errorData = JSON.stringify(error.response?.data);
          logger.error(`   ❌ Bad Request Details: ${errorData}`);
          throw new Error(`Bad Request: ${errorData}`);
        }
      } else {
        const err = error as Error;
        logger.error(`   Error Type: ${err.constructor.name}`);
        logger.error(`   Message: ${err.message}`);
        if (err.stack) {
          logger.error(`   Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`);
        }
      }

      if (attempt >= MAX_API_RETRIES) {
        logger.error(`\n🚫 MAX RETRIES EXCEEDED (${MAX_API_RETRIES})`);
        throw error;
      }

      logger.warn(`   ⏳ Waiting 5s before retry...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  throw new Error("Max retries exceeded");
}
// async function callGrokWithWebSearch(prompt: string): Promise<string> {
//   const GROK_API_KEY = process.env.GROK_API_KEY;
//   if (!GROK_API_KEY) {
//     throw new Error("GROK_API_KEY missing");
//   }
  
//   const response = await axios.post(
//     'https://api.x.ai/v1/chat/completions',
//     {
//       model: 'grok-3',  // ✅ מודל זמין
//       messages: [
//         {
//           role: 'user',
//           content: prompt
//         }
//       ],
//       temperature: 0.1,
//       max_tokens: 2000,
//       stream: false,
//       search_parameters: {  // ✅ פורמט נכון
//         mode: "auto",
//         return_citations: true,
//         max_search_results: 10
//       }
//     },
//     {
//       headers: {
//         'Authorization': `Bearer ${GROK_API_KEY}`,
//         'Content-Type': 'application/json'
//       },
//       timeout: 90000
//     }
//   );
  
//   return response.data.choices[0].message.content;
// }

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
    // const now = new Date();
    // const threeDaysAgo = new Date(now);
    // threeDaysAgo.setDate(threeDaysAgo.getDate());
    // const dateString = threeDaysAgo.toISOString().split("T")[0];
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
const dateObj = new Date();
  dateObj.setDate(dateObj.getDate()); 
  const now = dateObj.toISOString();
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

    stockLog.miniCheck(symbol, finalResult);
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
// PDF DISCOVERY SYSTEM (Serper.dev + Grok)
// ============================================



// async function searchEarningsPdf(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string[]> {
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   if (!SERPER_API_KEY) {
//     throw new Error("SERPER_API_KEY is not configured");
//   }

//   const reportDateTime = new Date(reportDate);
//   const reportMonth = reportDateTime.getMonth() + 1;
//   const reportYear = reportDateTime.getFullYear();

//   const cleanCompanyName = companyName
//     .replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC|Co\.?)$/i, '')
//     .trim();

//   // ============================================
//   // 🔍 BUILD COMPANY IDENTIFIERS FOR MATCHING
//   // ============================================
//   const companyIdentifiers = [
//     symbol.toLowerCase(),
//     cleanCompanyName.toLowerCase(),
//     // Also try first word of company name (e.g., "Abbott" from "Abbott Laboratories")
//     cleanCompanyName.split(' ')[0].toLowerCase(),
//   ].filter(id => id.length >= 2); // Avoid single-letter matches

//   logger.info(`🔍 Company identifiers: ${companyIdentifiers.join(', ')}`);

//   // ============================================
//   // 🔍 SEARCH QUERIES
//   // ============================================
//   const searchQueries = [
//     `"${cleanCompanyName}" Q${quarter} ${year} earnings "press release" filetype:pdf`,
//     `"${cleanCompanyName}" Q${quarter} ${year} earnings results filetype:pdf`,
//     `${symbol} Q${quarter} ${year} earnings filetype:pdf`,
//   ];

//   // ============================================
//   // ✅ VALID DOMAIN/PATH PATTERNS
//   // ============================================
//   const validDomainPatterns = [
//     'investor.',
//     'investors.',
//     'ir.',
//     'investor-relations.',
//     'investorrelations.',
      
    
//   ];

//   // ============================================
//   // ❌ WRONG QUARTERS - Must reject these!
//   // ============================================
//   const wrongQuarters = [1, 2, 3, 4].filter(q => q !== quarter);
//   const wrongQuarterPatterns = wrongQuarters.flatMap(q => [
//     `q${q}-`,    // q1-, q2-, q3-
//     `q${q}_`,    // q1_, q2_, q3_
//     `q${q}/`,    // q1/, q2/, q3/
//     `-q${q}`,    // -q1, -q2, -q3
//     `_q${q}`,    // _q1, _q2, _q3
//     `${q}q-`,    // 1q-, 2q-, 3q-
//     `${q}q_`,    // 1q_, 2q_, 3q_
//     `${q}q20`,   // 1q2025, 2q2025
//     `/q${q}/`,   // /q1/, /q2/, /q3/
//   ]);

//   // ============================================
//   // ✅ CORRECT QUARTER PATTERNS
//   // ============================================
//   const correctQuarterPatterns = [
//     `q${quarter}-`,
//     `q${quarter}_`,
//     `q${quarter}/`,
//     `-q${quarter}`,
//     `_q${quarter}`,
//     `${quarter}q-`,
//     `${quarter}q_`,
//     `${quarter}q20`,
//     `/q${quarter}/`,
//     `q${quarter}%20`,     // URL encoded space
//     `q${quarter} `,
//     `-${quarter}q-`,
//     `_${quarter}q_`,
//   ];

//   const urls: string[] = [];
//   const rejectedUrls: { url: string; reason: string }[] = [];

//   for (const query of searchQueries) {
//     if (urls.length >= 5) break;
    
//     logger.info(`🔍 Searching: ${query}`);

//     try {
//       const response = await axios.post(
//         'https://google.serper.dev/search',
//         { q: query, num: 20 },
//         {
//           headers: {
//             'X-API-KEY': SERPER_API_KEY,
//             'Content-Type': 'application/json'
//           },
//           timeout: 10000
//         }
//       );

//       if (!response.data.organic) continue;

//       for (const result of response.data.organic) {
//         if (!result.link) continue;
        
//         const url = result.link.toLowerCase();
//         const originalUrl = result.link;

//         // ============================================
//         // CHECK 1: Must be PDF
//         // ============================================
//         if (!url.endsWith('.pdf')) continue;

//         // ============================================
//         // CHECK 2: Must contain company identifier!
//         // ============================================
//         const hasCompanyId = companyIdentifiers.some(id => url.includes(id));
//         if (!hasCompanyId) {
//           rejectedUrls.push({ url: originalUrl, reason: `no company match (need: ${symbol})` });
//           continue;
//         }

//         // ============================================
//         // CHECK 3: Valid domain/path
//         // ============================================
//         const isValidSource = validDomainPatterns.some(pattern => url.includes(pattern));
//         if (!isValidSource) {
//           rejectedUrls.push({ url: originalUrl, reason: 'invalid domain/path' });
//           continue;
//         }

//         // ============================================
//         // CHECK 4: Must NOT have wrong quarter!
//         // ============================================
//         const hasWrongQuarter = wrongQuarterPatterns.some(p => url.includes(p));
//         if (hasWrongQuarter) {
//           rejectedUrls.push({ url: originalUrl, reason: `wrong quarter (not Q${quarter})` });
//           continue;
//         }

//         // ============================================
//         // CHECK 5: Contains relevant year
//         // ============================================
//         const fiscalYear = quarter === 4 ? year : year; // Q4 2025 reports in Jan 2026
//         const hasRelevantYear = url.includes(String(fiscalYear)) || 
//                                 url.includes(String(fiscalYear).slice(2));
        
//         if (!hasRelevantYear) {
//           rejectedUrls.push({ url: originalUrl, reason: `no year ${fiscalYear}` });
//           continue;
//         }

//         // ============================================
//         // CHECK 6: Exclude very old years
//         // ============================================
//         const oldYears = ['2018', '2019', '2020', '2021', '2022', '2023'];
//         const containsOnlyOldYear = oldYears.some(y => url.includes(y)) && 
//                                     !url.includes(String(fiscalYear));
//         if (containsOnlyOldYear) {
//           rejectedUrls.push({ url: originalUrl, reason: 'old year only' });
//           continue;
//         }

//         // ============================================
//         // CHECK 7: Exclude wrong document types
//         // ============================================
//         const excludePatterns = [
//           'slide', 'presentation', 'transcript', 'proxy', 
//           'annual-report', '10-k', '10-q', 'supplement', 'deck'
//         ];
//         const isExcluded = excludePatterns.some(p => url.includes(p));
//         if (isExcluded) {
//           rejectedUrls.push({ url: originalUrl, reason: 'wrong doc type' });
//           continue;
//         }

//         // ============================================
//         // ✅ PASSED ALL CHECKS!
//         // ============================================
//         if (!urls.includes(originalUrl)) {
//           urls.push(originalUrl);
//           logger.info(`   ✅ Accepted: ${originalUrl}`);
//         }
//       }
//     } catch (error: any) {
//       logger.warn(`   ⚠️ Search failed: ${error.message}`);
//     }
//   }

//   // ============================================
//   // LOG SUMMARY
//   // ============================================
//   logger.info(`\n📊 Filtering Results:`);
//   logger.info(`   ✅ Accepted: ${urls.length}`);
//   logger.info(`   ❌ Rejected: ${rejectedUrls.length}`);
  
//   if (urls.length === 0 && rejectedUrls.length > 0) {
//     logger.warn(`\n⚠️ All URLs rejected! Reasons:`);
//     rejectedUrls.slice(0, 10).forEach(({ url, reason }) => {
//       logger.warn(`   - ${url.substring(0, 60)}... → ${reason}`);
//     });
//   }

//   return urls;
// }


// async function searchEarningsPdf(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string[]> {
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY missing");

//   // ניקוי בסיסי של השם (כדי לא לבלבל את גוגל עם פסיקים מיותרים)
//   const cleanName = companyName.replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC)$/i, '').trim();
  
//   // בניית תאריך לחיפוש (למשל "January 22, 2026")
//   const dateStr = new Date(reportDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

//   // השאילתה המנצחת (שילוב של שם חברה, IR, תאריך מדויק ודרישה ל-PDF)
//   const query = `${cleanName} "Investor Relations" Q${quarter} ${year} earnings ${dateStr} pdf`;

//   logger.info(`🔍 Simple Search: "${query}"`);

//   try {
//     const response = await axios.post(
//       'https://google.serper.dev/search',
//       { 
//         q: query, 
//         num: 3,        // מבקשים 3 רק ליתר ביטחון, אבל ניקח את הראשון
//         tbs: "qdr:m"   // פילטר חובה: רק מהחודש האחרון (כדי לא לקבל דוחות משנה שעברה)
//       },
//       { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' } }
//     );

//     const results = response.data.organic || [];

//     if (results.length > 0) {
//       // 🎯 לוקחים את התוצאה הראשונה וזהו!
//       const topResult = results[0];
      
//       logger.info(`✅ Taking Top Result: ${topResult.link}`);
//       logger.info(`   Title: "${topResult.title}"`);
      
//       // מחזירים מערך עם התוצאה הזו בלבד
//       return [topResult.link];
//     }

//     logger.warn(`⚠️ Google returned no results for this query.`);
//     return [];

//   } catch (error: any) {
//     logger.error(`❌ Search failed: ${error.message}`);
//     return [];
//   }
// }


  //last versia IMPORTANT
// async function searchEarningsPdf(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string[]> {
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY missing");

//   const cleanName = companyName.replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC)$/i, '').trim();
  
//   // ═══════════════════════════════════════════════════════════════
//   // 1. בניית מזהים - רק שם החברה
//   // ═══════════════════════════════════════════════════════════════
//   const identifiers: string[] = [];
//   identifiers.push(cleanName.toLowerCase());
  
//   const firstName = cleanName.split(' ')[0].toLowerCase();
//   if (firstName.length > 3) {
//     identifiers.push(firstName);
//   }
  
//   logger.info(`\n🔍 Strict-Search for ${symbol} (${cleanName})...`);
//   logger.info(`📋 Identifiers: ${identifiers.join(', ')}`);
//   logger.info(`📅 Looking for: Q${quarter} ${year}`);

//   // ═══════════════════════════════════════════════════════════════
//   // 2. מפל שאילתות
//   // ═══════════════════════════════════════════════════════════════
//   const queries = [
//     `${cleanName} Investor Relations website`,
//     `${symbol} investor relations site`,  // ⬅️ נוסיף גם את הסימול!

 
//   ];

//   let allCandidates: Array<{
//     url: string;
//     title: string;
//     snippet: string;
//     score: number;
//     reasons: string[];
//   }> = [];

//   // ═══════════════════════════════════════════════════════════════
//   // 3. חיפוש ואיסוף מועמדים
//   // ═══════════════════════════════════════════════════════════════
//   for (const query of queries) {
//     logger.info(`\n👉 Query: '${query}'`);

//     try {
//       const response = await axios.post(
//         'https://google.serper.dev/search',
//         { 
//           q: query, 
//           num: 10, 
//           tbs: "qdr:m",
//           gl: "us",
//           hl: "en"
//         },
//         { 
//           headers: { 
//             'X-API-KEY': SERPER_API_KEY, 
//             'Content-Type': 'application/json' 
//           } 
//         }
//       );

//       const results = response.data.organic || [];
//       logger.info(`📊 Serper returned ${results.length} results`);

//       for (let i = 0; i < results.length; i++) {
//         const result = results[i];
//         const link = result.link.toLowerCase();
//         const title = result.title.toLowerCase();
//         const snippet = (result.snippet || "").toLowerCase();
//         const combinedText = link + " " + title + " " + snippet;

//         logger.info(`\n━━━ Result #${i + 1} ━━━`);
//         logger.info(`🔗 Link: ${result.link}`);
//         logger.info(`📰 Title: ${result.title}`);
//         logger.info(`📝 Snippet: ${(result.snippet || '').substring(0, 100)}...`);

//         let score = 0;
//         let reasons: string[] = [];
//         let rejected = false;
//         let rejectionReason = '';

//         // ════════════════════════════════════════════════════════════
//         // בדיקה 1: זיהוי חברה
//         // ════════════════════════════════════════════════════════════
//         const companyMatch = identifiers.some(id => {
//           return title.includes(id) || snippet.includes(id) || link.includes(id);
//         });

//         if (!companyMatch) {
//           rejected = true;
//           rejectionReason = 'No company name match';
//           logger.info(`   ❌ REJECTED: ${rejectionReason}`);
//           continue;
//         }

//         logger.info(`   ✅ Company Match: Found company name`);

//         // ════════════════════════════════════════════════════════════
//         // בדיקה 2: דחייה קשה - זבל וטרנסקריפטים
//         // ════════════════════════════════════════════════════════════
//         const hardRejectPatterns = [
//           { pattern: 'gov.nt.ca', reason: 'Government site (NWT)' },
//           { pattern: 'sec.gov/cgi-bin', reason: 'SEC search results' },
//           { pattern: 'list', reason: 'Generic list document' },
//           { pattern: 'checklist', reason: 'Checklist document' },
//           { pattern: 'transcript', reason: 'Earnings call transcript' },
//           { pattern: 'call transcript', reason: 'Call transcript' },
//           { pattern: 'call highlights', reason: 'Call highlights summary' },
//           { pattern: 'call summary', reason: 'Call summary' },
//           { pattern: 'conference call', reason: 'Conference call' },
//           { pattern: 'earnings preview', reason: 'Preview (not actual results)' },
//           { pattern: 'earnings outlook', reason: 'Outlook (not actual results)' },
//           { pattern: 'earnings expectations', reason: 'Expectations (not results)' }
//         ];

//         for (const { pattern, reason } of hardRejectPatterns) {
//           if (title.includes(pattern) || link.includes(pattern)) {
//             rejected = true;
//             rejectionReason = reason;
//             logger.info(`   ❌ REJECTED: ${rejectionReason}`);
//             break;
//           }
//         }

//         if (rejected) continue;

//         // ════════════════════════════════════════════════════════════
//         // בדיקה 3: דחייה קשה של דפי נחיתה כלליים
//         // ════════════════════════════════════════════════════════════
//         const genericLandingPages = [
//           '/news/default.aspx',
//           '/overview/default.aspx',
//           '/investor-relations$',
//           '/press-releases$'
//         ];

//         let isGenericLanding = false;
//         for (const pattern of genericLandingPages) {
//           const regex = new RegExp(pattern, 'i');
//           if (regex.test(link)) {
//             isGenericLanding = true;
//             break;
//           }
//         }

//         if (isGenericLanding) {
//           // חריגות: indicators של תוכן ספציפי
//           const specificIndicators = [
//             '/press-release/',
//             '/news-details/',
//             '/article/',
//             '.pdf',
//             reportDate,
//             reportDate.replace(/-/g, ''),
//             reportDate.replace(/-/g, '/')
//           ];
          
//           const hasSpecificIndicator = specificIndicators.some(indicator => 
//             link.includes(indicator.toLowerCase())
//           );
          
//           if (!hasSpecificIndicator) {
//             rejected = true;
//             rejectionReason = 'Generic landing page without specific content';
//             logger.info(`   ❌ REJECTED: ${rejectionReason}`);
//             continue;
//           } else {
//             logger.info(`   ✅ Landing page has specific indicator - allowed`);
//           }
//         }

//         // ════════════════════════════════════════════════════════════
//         // בדיקה 4: דפוסי URL בעייתיים (עונש רך)
//         // ════════════════════════════════════════════════════════════
//         const indexPagePatterns = [
//           '/sec-filings/',
//           '/earnings/',
//           'default.aspx',
//           'overview/default'
//         ];

//         for (const pattern of indexPagePatterns) {
//           if (link.includes(pattern)) {
//             const hasDate = link.includes(reportDate.replace(/-/g, '')) || 
//                           link.includes(reportDate) ||
//                           link.includes('.pdf');
            
//             if (!hasDate) {
//               logger.info(`   ⚠️ WARNING: Looks like index page (${pattern})`);
//               score -= 50;
//               reasons.push(`Index page penalty (-50)`);
//               break;
//             }
//           }
//         }

//         // ════════════════════════════════════════════════════════════
//         // בדיקה 5: רלוונטיות - חייב להיות על רווח
//         // ════════════════════════════════════════════════════════════
//         const relevanceTerms = [
//           'earnings', 
//           'results', 
//           'financial', 
//           'quarter', 
//           `q${quarter}`,
//           'release',
//           'announces',
//           'reports',
//           'statement'
//         ];

//         const matchedTerms = relevanceTerms.filter(term => 
//           title.includes(term) || snippet.includes(term)
//         );

//         if (matchedTerms.length === 0) {
//           rejected = true;
//           rejectionReason = 'No earnings-related terms found';
//           logger.info(`   ❌ REJECTED: ${rejectionReason}`);
//           continue;
//         }

//         logger.info(`   ✅ Relevance: ${matchedTerms.join(', ')}`);
//         score += matchedTerms.length * 5;
//         reasons.push(`Relevance terms: ${matchedTerms.join(', ')}`);

//         // ════════════════════════════════════════════════════════════
//         // ניקוד 1: איכות מקור - הכי חשוב!
//         // ════════════════════════════════════════════════════════════
//         const domain = link.split('/')[2] || '';
        
//         // מקורות מעולים - NEWSWIRES (תמיד תוכן מלא!)
//         if (domain.includes('businesswire') || 
//             domain.includes('globenewswire') || 
//             domain.includes('prnewswire') ||
//             domain.includes('accesswire')) {
//           score += 150;
//           reasons.push('Official newswire (+150) 🔥');
//           logger.info(`   ⭐⭐⭐ EXCELLENT: Official newswire - FULL CONTENT (+150)`);
//         }

//         else if (domain.includes('seekingalpha') && link.includes('/pr/')) {
//         score += 140;
//         reasons.push('SeekingAlpha PR (+140) 🔥');
//         logger.info(`   ⭐⭐⭐ EXCELLENT: SeekingAlpha Press Release (+140)`);
//       }
//         // אתר IR רשמי
//         else if (domain.includes(firstName) || domain.includes('ir.')) {
//           score += 120;
//           reasons.push('Official IR site (+120)');
//           logger.info(`   ⭐⭐ GREAT: Official IR site (+120)`);
//         }
//         // SEC Edgar + Fortune/Quartr SEC mirror
//         else if ((domain.includes('sec.gov') && link.includes('/archives/')) ||
//                  (domain.includes('fortune.com') && link.includes('/company-assets/')) ||
//                  (domain.includes('quartr.com'))) {
//           score += 100;
//           reasons.push('SEC filing source (+100)');
//           logger.info(`   ⭐ GOOD: SEC filing source (+100)`);
//         }
//         // צד שלישי של SEC (אינדקסים)
//         else if (domain.includes('stocktitan') || 
//                  domain.includes('secfilings')) {
//           score += 40;
//           reasons.push('SEC third-party (+40)');
//           logger.info(`   ⚠️ CAUTION: SEC third-party - may be index (+40)`);
//         }
//         // אתרי חדשות/ניתוח
//         else if (domain.includes('seekingalpha') || 
//                  domain.includes('zacks') ||
//                  domain.includes('marketbeat') ||
//                  domain.includes('investing.com') ||
//                  domain.includes('yahoo')) {
//           score += 10;
//           reasons.push('News/Analysis site (+10)');
//           logger.info(`   ⚠️ OK: News site (+10)`);
//         }
//         // לא מזוהה
//         else {
//           score += 30;
//           reasons.push('Unknown source (+30)');
//           logger.info(`   ❓ UNKNOWN: ${domain} (+30)`);
//         }

//         // ════════════════════════════════════════════════════════════
//         // ניקוד 2: מילות מפתח חיוביות
//         // ════════════════════════════════════════════════════════════
//         const positiveKeywords = [
//           { word: 'announces', points: 15 },
//           { word: 'reports', points: 15 },
//           { word: 'release', points: 12 },
//           { word: 'results', points: 10 },
//           { word: 'earnings', points: 8 },
//           { word: `q${quarter}`, points: 10 },
//           { word: year.toString(), points: 5 }
//         ];

//         for (const { word, points } of positiveKeywords) {
//           if (title.includes(word)) {
//             score += points;
//             reasons.push(`"${word}" in title (+${points})`);
//           }
//         }

//         // ════════════════════════════════════════════════════════════
//         // ניקוד 3: PDF = בונוס גדול!
//         // ════════════════════════════════════════════════════════════
//         if (link.includes('.pdf')) {
//           score += 30;
//           reasons.push('PDF file (+30)');
//           logger.info(`   📄 PDF detected - FULL CONTENT (+30)`);
//         }

//         // ════════════════════════════════════════════════════════════
//         // ניקוד 4: תאריך מדויק ב-URL
//         // ════════════════════════════════════════════════════════════
//         const exactDatePatterns = [
//           reportDate,
//           reportDate.replace(/-/g, '')
//         ];

//         let dateBonus = 0;
//         for (const pattern of exactDatePatterns) {
//           if (link.includes(pattern)) {
//             dateBonus = 40;
//             reasons.push('Exact date in URL (+40)');
//             logger.info(`   📅 EXACT date match in URL (+40)`);
//             break;
//           }
//         }

//         if (dateBonus === 0) {
//           const partialDatePattern = reportDate.replace(/-/g, '/');
//           if (link.includes(partialDatePattern)) {
//             dateBonus = 20;
//             reasons.push('Date in URL (+20)');
//             logger.info(`   📅 Date match in URL (+20)`);
//           }
//         }

//         score += dateBonus;

//         logger.info(`   🎯 TOTAL SCORE: ${score}`);
//         logger.info(`   📝 Reasons: ${reasons.join('; ')}`);

//         allCandidates.push({
//           url: result.link,
//           title: result.title,
//           snippet: result.snippet || '',
//           score,
//           reasons
//         });
//       }
      
//     } catch (e: any) {
//       logger.warn(`⚠️ Serper API Error: ${e.message}`);
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════
//   // 4. הסרת כפילויות + מיון
//   // ═══════════════════════════════════════════════════════════════
//   if (allCandidates.length === 0) {
//     logger.warn(`\n❌ No valid candidates found for ${symbol}`);
//     return [];
//   }

//   const uniqueCandidates = Array.from(
//     new Map(
//       allCandidates
//         .sort((a, b) => b.score - a.score)
//         .map(c => [c.url, c])
//     ).values()
//   );

//   logger.info(`\n🔄 Removed ${allCandidates.length - uniqueCandidates.length} duplicate URLs`);
//   logger.info(`📊 Unique candidates: ${uniqueCandidates.length}`);

//   uniqueCandidates.sort((a, b) => b.score - a.score);

//   logger.info(`\n╔════════════════════════════════════════════════════════════╗`);
//   logger.info(`║ 🏆 TOP CANDIDATES FOR ${symbol}`);
//   logger.info(`╚════════════════════════════════════════════════════════════╝`);

//   for (let i = 0; i < Math.min(5, uniqueCandidates.length); i++) {
//     const candidate = uniqueCandidates[i];
//     const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
//     logger.info(`\n${emoji} Rank ${i + 1}: Score ${candidate.score}`);
//     logger.info(`   URL: ${candidate.url}`);
//     logger.info(`   Title: ${candidate.title}`);
//     logger.info(`   Reasons: ${candidate.reasons.join('; ')}`);
//   }

//   const winner = uniqueCandidates[0];
  
//   if (winner.score < 100) {
//     logger.warn(`\n⚠️⚠️⚠️ WARNING: Best source has LOW score (${winner.score})`);
//     logger.warn(`   This may be a news summary or index page, not the actual earnings release!`);
//     logger.warn(`   Expected score for good sources: 150+ (newswire), 120+ (IR site), 100+ (SEC direct)`);
//   } else {
//     logger.info(`\n✅ HIGH CONFIDENCE: Winner has good score (${winner.score})`);
//   }

//   // ═══════════════════════════════════════════════════════════════
//   // 5. ולידציה - עד 3 מועמדים
//   // ═══════════════════════════════════════════════════════════════
//   const maxAttempts = Math.min(3, uniqueCandidates.length);
  
//   for (let i = 0; i < maxAttempts; i++) {
//     const candidate = uniqueCandidates[i];
//     const candidateName = i === 0 ? 'Winner' : `Candidate #${i + 1}`;
    
//     logger.info(`\n${'═'.repeat(60)}`);
//     logger.info(`🎯 Attempting ${candidateName}: ${candidate.url}`);
//     logger.info(`   Score: ${candidate.score}`);
//     logger.info(`${'═'.repeat(60)}`);
    
//     const isValid = await validateUrl(candidate.url, candidateName);
    
//     if (isValid) {
//       logger.info(`\n✅✅✅ FINAL SELECTION: ${candidate.url}`);
//       logger.info(`   Score: ${candidate.score}`);
//       logger.info(`   Title: ${candidate.title}`);
//       return [candidate.url];
//     }
    
//     if (i < maxAttempts - 1) {
//       logger.warn(`\n⏭️ Moving to next candidate...`);
//     }
//   }

//   logger.error(`\n❌❌❌ ALL CANDIDATES FAILED VALIDATION`);
//   logger.error(`   Tried ${maxAttempts} URLs - none are accessible`);
//   logger.error(`   This may indicate:`);
//   logger.error(`   - Report not published yet`);
//   logger.error(`   - Network/firewall issues`);
//   logger.error(`   - Company uses non-standard publishing method`);
  
//   return [];
// }
// async function searchEarningsPdf(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string[]> {
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY missing");

//   const cleanName = companyName.replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC)$/i, '').trim();
  
//   logger.info(`\n🔍 Two-Stage Search for ${symbol} (${cleanName})...`);
//   logger.info(`📅 Looking for: Q${quarter} ${year}`);

//   // ═══════════════════════════════════════════════════════════════
//   // שלב 1: מצא את אתר ה-IR הרשמי
//   // ═══════════════════════════════════════════════════════════════
//   const irQueries = [
//     `${symbol} investor relations website`,  // ⬅️ הסימבול יותר מדויק!
//     `${cleanName} investor relations official site`,
//   ];

//   let irWebsite: string | null = null;

//   for (const query of irQueries) {
//     logger.info(`\n🔍 Stage 1: Finding IR website - Query: '${query}'`);

//     try {
//       const response = await axios.post(
//         'https://google.serper.dev/search',
//         { 
//           q: query, 
//           num: 5,  // רק 5 תוצאות ראשונות
//           gl: "us",
//           hl: "en"
//         },
//         { 
//           headers: { 
//             'X-API-KEY': SERPER_API_KEY, 
//             'Content-Type': 'application/json' 
//           } 
//         }
//       );

//       const results = response.data.organic || [];
      
//       for (const result of results) {
//         const link = result.link.toLowerCase();
//         const title = result.title.toLowerCase();
        
//         // חפש אתר IR רשמי
//         const isIRSite = 
//           link.includes('/investor') || 
//           link.includes('/ir/') ||
//           link.includes('investor.') ||
//           link.includes('ir.') ||
//           title.includes('investor relations');

//         // ודא שזה באמת של החברה הנכונה
//         const companyMatch = 
//           link.includes(cleanName.toLowerCase().replace(/\s+/g, '')) ||
//           link.includes(symbol.toLowerCase()) ||
//           title.includes(cleanName.toLowerCase());

//         if (isIRSite && companyMatch) {
//           irWebsite = result.link;
//           logger.info(`\n✅ Found IR website: ${irWebsite}`);
//           break;
//         }
//       }

//       if (irWebsite) break;
      
//     } catch (e: any) {
//       logger.warn(`⚠️ Serper API Error: ${e.message}`);
//     }
//   }

//   if (!irWebsite) {
//     logger.warn(`\n❌ Could not find IR website for ${symbol}`);
//     return [];
//   }

//   // ═══════════════════════════════════════════════════════════════
//   // שלב 2: חפש PDF בתוך אתר ה-IR
//   // ═══════════════════════════════════════════════════════════════
//   const irDomain = new URL(irWebsite).hostname;
  
//   const pdfQueries = [
//     `site:${irDomain} Q${quarter} ${year} earnings report PDF`,
//     `site:${irDomain} ${reportDate} earnings release`,
//     `site:${irDomain} fourth quarter ${year} results`,
//   ];

//   logger.info(`\n🔍 Stage 2: Searching for PDF within ${irDomain}...`);

//   let allCandidates: Array<{
//     url: string;
//     title: string;
//     snippet: string;
//     score: number;
//     reasons: string[];
//   }> = [];

//   for (const query of pdfQueries) {
//     logger.info(`\n👉 PDF Query: '${query}'`);

//     try {
//       const response = await axios.post(
//         'https://google.serper.dev/search',
//         { 
//           q: query, 
//           num: 10,
//           tbs: "qdr:m",
//           gl: "us",
//           hl: "en"
//         },
//         { 
//           headers: { 
//             'X-API-KEY': SERPER_API_KEY, 
//             'Content-Type': 'application/json' 
//           } 
//         }
//       );

//       const results = response.data.organic || [];
//       logger.info(`📊 Found ${results.length} results`);

//       for (const result of results) {
//         const link = result.link.toLowerCase();
//         const title = result.title.toLowerCase();
//         const snippet = (result.snippet || "").toLowerCase();

//         // דחה טרנסקריפטים ודוחות לא רלוונטיים
//         if (link.includes('transcript') || 
//             title.includes('transcript') ||
//             title.includes('preview')) {
//           continue;
//         }

//         let score = 0;
//         let reasons: string[] = [];

//         // ניקוד לפי סוג המסמך
//         if (link.includes('.pdf')) {
//           score += 50;
//           reasons.push('PDF file (+50)');
//         }

//         // ניקוד לפי רלוונטיות
//         const relevanceTerms = ['earnings', 'results', `q${quarter}`, year.toString()];
//         const matches = relevanceTerms.filter(term => 
//           title.includes(term) || snippet.includes(term)
//         );
        
//         score += matches.length * 10;
//         reasons.push(`Relevance: ${matches.join(', ')}`);

//         // ניקוד לפי תאריך
//         if (link.includes(reportDate.replace(/-/g, ''))) {
//           score += 30;
//           reasons.push('Exact date (+30)');
//         }

//         allCandidates.push({
//           url: result.link,
//           title: result.title,
//           snippet: result.snippet || '',
//           score,
//           reasons
//         });
//       }

//       // אם מצאנו תוצאות טובות, תפסיק
//       if (allCandidates.some(c => c.score > 70)) break;
      
//     } catch (e: any) {
//       logger.warn(`⚠️ Serper API Error: ${e.message}`);
//     }
//   }

//   // מיון והחזרה
//   if (allCandidates.length === 0) {
//     logger.warn(`\n❌ No PDF found in ${irDomain}`);
//     return [];
//   }

//   allCandidates.sort((a, b) => b.score - a.score);

//   logger.info(`\n🏆 TOP CANDIDATES:`);
//   for (let i = 0; i < Math.min(3, allCandidates.length); i++) {
//     const c = allCandidates[i];
//     logger.info(`\n${i + 1}. Score: ${c.score}`);
//     logger.info(`   URL: ${c.url}`);
//     logger.info(`   Reasons: ${c.reasons.join('; ')}`);
//   }

//   // ולידציה
//   const winner = allCandidates[0];
//   const isValid = await validateUrl(winner.url, 'Winner');
  
//   if (isValid) {
//     logger.info(`\n✅ FINAL SELECTION: ${winner.url}`);
//     return [winner.url];
//   }

//   logger.error(`\n❌ Winner failed validation`);
//   return [];
// }

export async function findEarningsPdf(
  symbol: string,
  companyName: string,
  quarter: number,
  year: number,
  reportDate: string,
  cachedIRPortal?: IRPortal | null,
  onIRPortalFound?: (portal: IRPortal) => void
): Promise<string | null> {
  
  logger.info(`\n${'═'.repeat(70)}`);
  logger.info(`🎯 Two-Phase Earnings Discovery: ${symbol}`);
  logger.info(`${'═'.repeat(70)}`);
  
  let verifiedIR: IRPortal | null = null;
  
  // Phase 1: Cache or find IR portal
  if (cachedIRPortal) {
    logger.info(`\n💾 CACHE HIT: Using cached IR portal`);
    verifiedIR = cachedIRPortal;
  } else {
    logger.info(`\n🔍 CACHE MISS: Need to find and verify IR portal`);
    logger.info(`\n📍 PHASE 1: Finding IR Portal...`);
    
    const irCandidates = await findIRCandidates(symbol, companyName);
    
    if (irCandidates.length === 0) {
      logger.error(`❌ No IR candidates found`);
      return null;
    }
    
    verifiedIR = await grokVerifyIR(symbol, companyName, irCandidates);
    
    if (!verifiedIR) {
      logger.error(`❌ Could not verify IR portal`);
      return null;
    }
    
    verifiedIR.verifiedAt = new Date().toISOString();
    logger.info(`✅ Verified IR: ${verifiedIR.url}`);
    
    if (onIRPortalFound) {
      onIRPortalFound(verifiedIR);
    }
  }
  
  // Phase 2: Let Grok find the earnings document
  logger.info(`\n📍 PHASE 2: Finding Earnings Document...`);
  
  const earningsPdf = await phase2_grokFindEarnings(
    verifiedIR,
    symbol,
    companyName,
    quarter,
    year,
    reportDate
  );
  
  if (!earningsPdf) {
    logger.error(`❌ Grok could not find earnings document`);
    return null;
  }
  
if (earningsPdf) {
  stockLog.earningsDocFound(symbol, earningsPdf);
}
  return earningsPdf;
}
  async function phase1_findAndVerifyIR(
  symbol: string,
  companyName: string
): Promise<IRPortal | null> {
  
  // Step 1.1: Serper Search for IR Candidates
  logger.info(`\n📡 Step 1.1: Searching for IR portal candidates...`);
  
  const candidates = await findIRCandidates(symbol, companyName);
  
  if (candidates.length === 0) {
    logger.error(`❌ No IR candidates found via Serper`);
    return null;
  }
  
  logger.info(`✅ Found ${candidates.length} IR candidates:`);
  candidates.forEach((c, i) => {
    logger.info(`   ${i + 1}. ${c.url}`);
    logger.info(`      Title: ${c.title}`);
  });
  
  // Step 1.2: Grok Verification
  logger.info(`\n🤖 Step 1.2: Grok verification of IR portal...`);
  
  const verified = await grokVerifyIR(symbol, companyName, candidates);
  
  if (!verified) {
    logger.error(`❌ Grok could not verify any IR portal`);
    return null;
  }
  
  return verified;
}
async function findIRCandidates(
  symbol: string,
  companyName: string
): Promise<IRCandidate[]> {
  
  const SERPER_API_KEY = process.env.SERPER_API_KEY;
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY missing");
  }
  
  const cleanName = companyName.replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC)$/i, '').trim();
  
  const queries = [
    `${symbol} investor relations official site`,
    `"${cleanName}" investor relations website`,
    `${symbol} ${cleanName} IR site`,
    `${symbol} earnings investor relations`,
  ];
  
  const allCandidates: IRCandidate[] = [];
  
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
    'nasdaq.com',        // ✅ הוסף!
    'morningstar.com',   // ✅ הוסף!
    'annualreports.com', // ✅ הוסף!
    'public.com',        // ✅ הוסף!
    'financialmodelingprep.com', // ✅ הוסף!
    'youtube.com',       // ✅ הוסף!
  ];
  
  for (const query of queries) {
    logger.info(`   🔍 Query: "${query}"`);
    
    try {
      const response = await axios.post(
        'https://google.serper.dev/search',
        { 
          q: query, 
          num: 20,
          gl: "us",
          hl: "en"
        },
        { 
          headers: { 
            'X-API-KEY': SERPER_API_KEY, 
            'Content-Type': 'application/json' 
          } 
        }
      );
      
      const results = response.data.organic || [];
      logger.info(`   📊 Serper returned ${results.length} results`);
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const url = result.link.toLowerCase();
        const domain = new URL(result.link).hostname.toLowerCase();
        
     
   
        
        // בדיקה 1: צד שלישי?
        const isThirdParty = thirdPartyDomains.some(d => domain.includes(d));
        if (isThirdParty) {
         
          continue;
        }
        
        // ✅ בדיקה 2 - מתוקנת! בדוק גם את הדומיין!
        const isIRUrl = 
          // בדוק ב-URL:
          url.includes('/investor') || 
          url.includes('/ir/') ||
          url.includes('/ir-') ||
          // ✅ חדש! בדוק גם ב-DOMAIN:
          domain.startsWith('ir.') ||           // ir.company.com
          domain.startsWith('investor.') ||     // investor.company.com
          domain.startsWith('investors.') ||    // investors.company.com
          domain.includes('.ir.') ||            // www.ir.company.com
          domain.includes('.investor.') ||      // www.investor.company.com
          domain.includes('.investors.');       // www.investors.company.com
        
        if (!isIRUrl) {
          logger.info(`      ❌ REJECTED: Not an IR URL/domain pattern`);
          continue;
        }
        
        // ✅ עבר את כל הבדיקות!
        allCandidates.push({
          url: result.link,
          title: result.title,
          snippet: result.snippet || ''
        });
      }
      
    } catch (e: any) {
      logger.warn(`   ⚠️ Serper error: ${e.message}`);
    }
  }
  
  // Remove duplicates
  const uniqueCandidates = Array.from(
    new Map(allCandidates.map(c => [c.url.toLowerCase(), c])).values()
  );
  
  logger.info(`\n📊 SUMMARY:`);
  logger.info(`   Total results checked: ${allCandidates.length}`);
  logger.info(`   Unique candidates: ${uniqueCandidates.length}`);
  
  if (uniqueCandidates.length > 0) {
    logger.info(`\n   🎯 Final candidates:`);
    uniqueCandidates.forEach((c, i) => {
      logger.info(`   ${i + 1}. ${c.url}`);
    });
  } else {
    logger.warn(`   ⚠️ No IR candidates found after filtering`);
  }
  
  return uniqueCandidates.slice(0, 10);
}

async function grokVerifyIR(
  symbol: string,
  companyName: string,
  candidates: IRCandidate[]
): Promise<IRPortal | null> {
  logger.info(`\n🔍 Grok IR Verification Starting...`);
  logger.info(`   Company: ${companyName} (${symbol})`);
  logger.info(`   Candidates: ${candidates.length}`);
  
  const prompt = `
You are an expert at identifying official Investor Relations websites.

CRITICAL TASK: Verify which URL is the OFFICIAL IR portal for this specific company.

COMPANY INFORMATION:
- Ticker Symbol: ${symbol}
- Company Name: ${companyName}
- Exchange: US (NYSE/NASDAQ)

CANDIDATE URLs TO VERIFY:
${candidates.map((c, i) => `
${i + 1}. URL: ${c.url}
   Title: ${c.title}
   Snippet: ${c.snippet}
`).join('\n')}

VERIFICATION REQUIREMENTS:
You MUST verify each URL by checking:

1. ✅ Company Name Match
   - Does the page title or content mention "${companyName}"?
   - Are we talking about the SAME company?

2. ✅ Ticker Symbol Match
   - Does the page mention ticker "${symbol}"?
   - Is this the correct stock symbol?

3. ✅ Anti-Hallucination Check (CRITICAL!)
   - Is this the CORRECT company for ticker ${symbol}?
   - Example pitfalls:
     * "SLM" = SLM Corporation (student loans) NOT Sanlam (South African insurance)
     * "ALK" = Alaska Air Group NOT another regional airline
   - Verify the domain makes sense for the company
   - Verify the business description matches

4. ✅ Official vs Third-Party
   - Is this the company's OFFICIAL domain?
   - Or is it a third-party aggregator (like gcs-web.com, q4cdn.com)?
   - Prefer direct company domains

SCORING GUIDELINES:
- Perfect match (official domain, company name, ticker mentioned): 0.95-1.0
- Good match (third-party but verified content): 0.75-0.85
- Uncertain match: 0.5-0.7
- Wrong company or can't verify: 0.0-0.3

CRITICAL RULES:
- If you're not 100% sure it's the RIGHT company, mark confidence LOW
- Better to reject ALL candidates than pick the WRONG company
- Domain should make logical sense for the company name

OUTPUT FORMAT (JSON only, no other text):
{
  "verifiedUrl": "the best URL or null if none are good",
  "domain": "just the hostname (e.g., salliemae.com)",
  "confidence": 0.0-1.0,
  "reason": "brief explanation of why you chose this or why all failed",
  "rejectedUrls": ["url1", "url2"],
  "rejectionReasons": ["why url1 rejected", "why url2 rejected"]
}

If NONE of the URLs can be verified with confidence >= 0.7, return:
{
  "verifiedUrl": null,
  "domain": null,
  "confidence": 0.0,
  "reason": "explanation of why all candidates failed verification"
}

IMPORTANT: Output ONLY valid JSON, no markdown formatting, no code blocks.
`;

  logger.info(`   Sending ${candidates.length} candidates to Grok for verification...`);
  
  try {
    const grokResponse = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1,      // temperature
      1500,     // max tokens
      true      // enable web search
    );
    
    logger.info(`   📦 Raw Grok response received (${grokResponse.length} chars)`);
    logger.info(`   📝 First 200 chars: ${grokResponse.substring(0, 200)}`);
    
    // ═══════════════════════════════════════════════════════════════
    // 🔥 FIX: Handle Grok's web_search response format
    // ═══════════════════════════════════════════════════════════════
    let cleanResponse = grokResponse.trim();
    
    // Check if this is a tool call array (starts with [{)
    if (cleanResponse.startsWith('[{')) {
      logger.info(`   🔧 Detected tool call array format - extracting text response...`);
      
      try {
        const toolCalls = JSON.parse(cleanResponse);
        
        // Log all tool call types for debugging
        logger.info(`   📋 Tool calls found: ${toolCalls.map((t: any) => t.type).join(', ')}`);
        
        // Find the message/text response
        const messageResponse = toolCalls.find((call: any) => 
          call.type === 'message' || call.type === 'text'
        );
        
        if (messageResponse) {
          // Extract content from message object
          if (messageResponse.content) {
            cleanResponse = messageResponse.content;
            logger.info(`   ✅ Extracted from 'message' content (${cleanResponse.length} chars)`);
          } else if (messageResponse.text) {
            cleanResponse = messageResponse.text;
            logger.info(`   ✅ Extracted from 'text' field (${cleanResponse.length} chars)`);
          } else if (messageResponse.message) {
            cleanResponse = messageResponse.message;
            logger.info(`   ✅ Extracted from 'message' field (${cleanResponse.length} chars)`);
          } else {
            logger.error(`   ❌ Message object has no content field!`);
            logger.error(`   Message keys: ${Object.keys(messageResponse).join(', ')}`);
            logger.error(`   Full message: ${JSON.stringify(messageResponse, null, 2)}`);
            return null;
          }
          
          // Ensure it's a string
          if (typeof cleanResponse !== 'string') {
            // If it's an array, try to find text in it
            if (Array.isArray(cleanResponse)) {
              const arr = cleanResponse as any[];
              const textItem = arr.find((item: any) => 
                typeof item === 'string' || item.text || item.content
              );
              if (textItem) {
                cleanResponse = typeof textItem === 'string' ? textItem : (textItem.text || textItem.content);
                logger.info(`   ⚠️ Extracted text from array`);
              } else {
                cleanResponse = JSON.stringify(cleanResponse);
                logger.info(`   ⚠️ Converted array to JSON string`);
              }
            } else {
              cleanResponse = JSON.stringify(cleanResponse);
              logger.info(`   ⚠️ Converted object to JSON string`);
            }
          }
          
          logger.info(`   📝 Extracted preview: ${String(cleanResponse).substring(0, 150)}`);
        } else {
          logger.error(`   ❌ No 'message' or 'text' type found in tool calls!`);
          logger.error(`   Available types: ${toolCalls.map((t: any) => t.type).join(', ')}`);
          logger.error(`   Full response: ${JSON.stringify(toolCalls, null, 2)}`);
          return null;
        }
      } catch (parseError: any) {
        logger.error(`   ❌ Failed to parse tool call array: ${parseError.message}`);
        return null;
      }
    }
    
    // Clean markdown if present
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/```\n?/g, '');
    }
    
    cleanResponse = cleanResponse.trim();
    logger.info(`   📝 Clean response preview: ${cleanResponse.substring(0, 200)}`);

    // Parse JSON
    const result = JSON.parse(cleanResponse);
    
    logger.info(`\n🎯 Verification Result:`);
    logger.info(`   Verified URL: ${result.verifiedUrl || 'NONE'}`);
    logger.info(`   Confidence: ${result.confidence}`);
   
    
    if (result.rejectedUrls && result.rejectedUrls.length > 0) {
      logger.info(`\n   📋 Rejected URLs (${result.rejectedUrls.length}):`);
      result.rejectedUrls.forEach((url: string, i: number) => {
        logger.info(`     - ${url}`);
        logger.info(`       Reason: ${result.rejectionReasons[i]}`);
      });
    }
    
    // Check confidence threshold
    if (!result.verifiedUrl || result.confidence < 0.7) {
      logger.warn(`\n   ⚠️ Verification FAILED: Confidence too low (${result.confidence})`);
      return null;
    }
    
    logger.info(`   ✅ VERIFICATION SUCCESSFUL`);
    stockLog.irPortalSelected(symbol, result.verifiedUrl, result.confidence);

    return {
      url: result.verifiedUrl,
      domain: result.domain,
      confidence: result.confidence,
      reason: result.reason
    };
    
  } catch (e: any) {
    logger.error(`\n❌ Grok verification error:`);
    logger.error(`   Type: ${e.constructor.name}`);
    logger.error(`   Message: ${e.message}`);
    if (e.stack) {
      logger.error(`   Stack: ${e.stack.split('\n').slice(0, 5).join('\n')}`);
    }
    return null;
  }
}


// async function grokFindEarningsDocument(
//   irUrl: string,
//   irDomain: string,
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string | null> {
  
//   const prompt = `
// You are an expert at finding earnings documents on investor relations websites.

// TASK: Find the OFFICIAL earnings press release for Q${quarter} ${year}.

// COMPANY INFO:
// - Ticker: ${symbol}
// - Company Name: ${companyName}
// - Quarter: Q${quarter} ${year}
// - Expected Report Date: ${reportDate}

// VERIFIED IR WEBSITE:
// ${irUrl}
// Domain: ${irDomain}

// INSTRUCTIONS:
// 1. Use your web_search tool to search for the earnings document
// 2. Search ONLY within the domain: ${irDomain}
// 3. Look for:
//    - Earnings press release (preferred)
//    - Earnings presentation (PDF)
//    - 10-Q filing (backup)

// 4. The document MUST:
//    - Be from ${irDomain} (not third-party sites)
//    - Mention Q${quarter} or "fourth quarter" and ${year}
//    - Preferably mention ticker ${symbol}
//    - Have a publish date near ${reportDate}

// 5. AVOID:
//    - Transcripts (call transcripts)
//    - Earnings previews/outlooks
//    - Old quarters (Q3, Q2, etc.)

// SEARCH STRATEGY:
// - Try: "site:${irDomain} Q${quarter} ${year} earnings press release"
// - Try: "site:${irDomain} fourth quarter ${year} results"
// - Try: "${irDomain}/investors news earnings"

// OUTPUT:
// Return ONLY the direct URL to the earnings document.
// If you cannot find it, explain why.

// Example output:
// https://www.salliemae.com/investors/news/slm-reports-q4-2025-results.pdf
// `;

//   logger.info(`\n🤖 Calling Grok to search for earnings document...`);
  
//   const grokResponse = await callGrokWithWebSearch(prompt);
  
//   // Extract URL from response
//   const urlMatch = grokResponse.match(/https?:\/\/[^\s]+/);
  
//   if (!urlMatch) {
//     logger.warn(`⚠️ Grok did not return a URL`);
//     logger.info(`Grok response: ${grokResponse}`);
//     return null;
//   }
  
//   const url = urlMatch[0].replace(/[.,;]$/, ''); // Clean trailing punctuation
  
//   // Verify it's from the correct domain
//   if (!url.includes(irDomain)) {
//     logger.warn(`⚠️ URL not from verified domain: ${url}`);
//     return null;
//   }
  
//   logger.info(`✅ Grok found: ${url}`);
//   return url;
// }

async function phase2_grokFindEarnings(
  irPortal: IRPortal,
  symbol: string,
  companyName: string,
  quarter: number,
  year: number,
  reportDate: string
): Promise<string | null> {
  
  logger.info(`\n🤖 Instructing Grok to search for earnings document...`);
  logger.info(`   Verified IR: ${irPortal.url}`);
  
  const quarterName = quarter === 1 ? 'first' : 
                     quarter === 2 ? 'second' : 
                     quarter === 3 ? 'third' : 'fourth';
  
  const prompt = `
You are an expert at finding quarterly earnings documents on investor relations websites.

TASK: Find the OFFICIAL earnings press release or report for Q${quarter} ${year}.

COMPANY INFORMATION:
- Ticker Symbol: ${symbol}
- Company Name: ${companyName}
- Quarter: Q${quarter} ${year} (${quarterName} quarter)
- Expected Report Date: ${reportDate}

VERIFIED IR WEBSITE:
${irPortal.url}
Domain: ${irPortal.domain}

🔥 CRITICAL INSTRUCTIONS - READ CAREFULLY:

STEP 1: BROWSE THE IR WEBSITE DIRECTLY
Use web_search with "open_page" action to load: ${irPortal.url}
This will show you the actual page content!

Common IR website structures:
- ${irPortal.url}/news
- ${irPortal.url}/press-releases
- ${irPortal.url}/news-releases
- ${irPortal.url}/financial-information/quarterly-results
- ${irPortal.url}/investors/news
- ${irPortal.url}/newsroom

STEP 2: LOOK FOR RECENT NEWS/PRESS RELEASES SECTION
Once you see the page, look for:
- "News" or "Press Releases" link
- "Latest News" section
- "Recent Announcements"
- "Quarterly Results" section

STEP 3: FIND THE Q${quarter} ${year} EARNINGS RELEASE
Look for titles containing:
- "Reports ${quarterName} Quarter ${year} Results"
- "Announces Q${quarter} ${year} Earnings"
- "Q${quarter} ${year} Financial Results"
- Date around ${reportDate}

STEP 4: GET THE DIRECT URL
Once you find the earnings release:
- If it's an HTML page → return the full URL
- If it's a PDF link → return the full PDF URL
- Make sure it's from ${irPortal.domain}

🎯 SEARCH STRATEGY (try these in order):

1. Open the main IR page: ${irPortal.url}
2. If that doesn't work, try: ${irPortal.url}/news
3. If that doesn't work, search: "site:${irPortal.domain} Q${quarter} ${year} earnings"
4. If that doesn't work, search: "${symbol} Q${quarter} ${year} earnings press release"

⚠️ IMPORTANT:
- Use open_page to VIEW the actual website content
- Don't just rely on Google search results
- Look at the page structure to find where earnings are posted
- If you find a "News" or "Press Releases" page, browse it to see recent items

THE DOCUMENT MUST:
✅ Be from domain: ${irPortal.domain}
✅ Mention Q${quarter} or "${quarterName} quarter" AND year ${year}
✅ Be published around ${reportDate} (±7 days acceptable)

AVOID:
❌ Earnings call transcripts
❌ Previous quarters (Q${quarter-1}, Q${quarter-2}, etc.)
❌ Different years

OUTPUT FORMAT:
Return ONLY the direct URL to the earnings document.
Just the URL, nothing else.

If you cannot find it after thorough searching, return:
NOT_FOUND: [brief explanation of what you tried]

EXAMPLE GOOD OUTPUT:
https://investors.agnc.com/news/news-details/2026/AGNC-Reports-Fourth-Quarter-2025-Results/default.aspx

EXAMPLE BAD OUTPUT:
NOT_FOUND: Could only find pre-announcement, no actual report.
`;

  logger.info(`   Calling Grok with web_search capability...`);
  
  try {
    const grokResponse = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1,
      3000,  // ⬅️ More tokens for browsing
      true
    );
    
    logger.info(`\n📄 Grok Response:`);
    logger.info(`${grokResponse.substring(0, 500)}${grokResponse.length > 500 ? '...' : ''}`);
    
    if (grokResponse.includes('NOT_FOUND:')) {
      const reason = grokResponse.replace('NOT_FOUND:', '').trim();
      logger.warn(`   ⚠️ Grok could not find document:`);
      logger.warn(`   ${reason}`);
      return null;
    }
    
    const urlMatch = grokResponse.match(/https?:\/\/[^\s<>"]+/);
    
    if (!urlMatch) {
      logger.warn(`   ⚠️ No URL found in Grok response`);
      return null;
    }
    
    let url = urlMatch[0];
    url = url.replace(/[.,;)\]]+$/, '');
    
    logger.info(`\n✅ Grok found URL: ${url}`);
    
    const urlDomain = new URL(url).hostname.toLowerCase();
    const expectedDomain = irPortal.domain.toLowerCase();
    
    if (!urlDomain.includes(expectedDomain) && !expectedDomain.includes(urlDomain)) {
      logger.warn(`   ⚠️ URL domain mismatch!`);
      logger.warn(`   Expected: ${expectedDomain}`);
      logger.warn(`   Got: ${urlDomain}`);
      return null;
    }
    
    logger.info(`   ✅ Domain verified: ${urlDomain}`);
    
    return url;
    
  } catch (e: any) {
    logger.error(`   ❌ Grok search failed: ${e.message}`);
    return null;
  }
}
async function validateUrl(url: string): Promise<boolean> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/pdf,text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  logger.info(`   Testing URL accessibility...`);
  
  // Try HEAD request
  try {
    await axios.head(url, { 
      timeout: 8000,
      headers 
    });
    logger.info(`   ✅ HEAD request successful`);
    return true;
  } catch (e: any) {
    logger.info(`   ⚠️ HEAD failed, trying GET...`);
  }

  // Try partial GET
  try {
    const response = await axios.get(url, { 
      timeout: 12000,
      maxContentLength: 10 * 1024,
      headers,
      responseType: 'stream'
    });
    
    if (response.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }
    
    logger.info(`   ✅ GET request successful`);
    return true;
  } catch (e: any) {
    logger.error(`   ❌ URL not accessible: ${e.code || e.message}`);
    return false;
  }
}
// async function searchEarningsHtml(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string
// ): Promise<string | null> {
  
//   const SERPER_API_KEY = process.env.SERPER_API_KEY;
//   const cleanCompanyName = companyName.replace(/,?\s*(Inc\.?|Corp\.?|Corporation|Company|Ltd\.?|LLC|Co\.?)$/i, '').trim();

//   const searchQueries = [
//     `"${cleanCompanyName}" Q${quarter} ${year} earnings press release`,
//     `${symbol} Q${quarter} ${year} earnings results`,
//     `site:ir.${cleanCompanyName.toLowerCase().replace(/\s+/g, '')}.com earnings Q${quarter} ${year}`,
//   ];

//   for (const query of searchQueries) {
//     logger.info(`🔍 Searching HTML: ${query}`);

//     try {
//       const response = await axios.post(
//         'https://google.serper.dev/search',
//         { q: query, num: 10 },
//         {
//           headers: {
//             'X-API-KEY': SERPER_API_KEY,
//             'Content-Type': 'application/json'
//           },
//           timeout: 10000
//         }
//       );

//       if (!response.data.organic) continue;

//       for (const result of response.data.organic) {
//         const url = result.link?.toLowerCase() || '';
//         const title = result.title?.toLowerCase() || '';
        
//         // Must be from investor relations domain
//         if (!url.includes('ir.') && !url.includes('investor')) continue;
        
//         // Must contain earnings indicators
//         const hasEarnings = ['earnings', 'results', 'financial', 'press-release', 'news'].some(
//           keyword => url.includes(keyword) || title.includes(keyword)
//         );
//         if (!hasEarnings) continue;

//         // Must contain quarter
//         const hasQuarter = [`q${quarter}`, `${quarter}q`, 'fourth-quarter', 'fourth quarter'].some(
//           q => url.includes(q) || title.includes(q)
//         );
//         if (!hasQuarter) continue;

//         // Must contain year
//         if (!url.includes(String(year)) && !title.includes(String(year))) continue;

//         logger.info(`   ✅ Found HTML press release: ${result.link}`);
//         return result.link;
//       }
//     } catch (error: any) {
//       logger.warn(`   ⚠️ HTML search failed: ${error.message}`);
//     }
//   }

//   return null;
// }

// async function filterBestPdfWithGrok(
//   urls: string[],
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number
// ): Promise<string | null> {
//   if (urls.length === 0) return null;

//   // ============================================
//   // ⚙️ SETUP MATCHING PATTERNS
//   // ============================================
//   const simplifiedName = companyName.toLowerCase().split(' ')[0].replace(/[^a-z]/g, '');
//   const tickerLower = symbol.toLowerCase();
  
//   // הגדרת שנים רלוונטיות (השנה המבוקשת + שנה קדימה לדוחות ינואר)
//   const targetYear = year.toString();
//   const nextYear = (year + 1).toString();
  
//   // הגדרת הרבעון הנוכחי
//   const currentQPatterns = [`q${quarter}`, `${quarter}q`, 'fourth', 'year-end', 'full-year']; 
  
//   // הגדרת רבעונים שגויים (שאסור שיופיעו!)
//   const wrongQuarters = [1, 2, 3, 4].filter(q => q !== quarter);
//   const wrongQPatterns = wrongQuarters.map(q => `q${q}`); // e.g., ["q1", "q2", "q3"]

//   const highTrustDomains = ['q4cdn', 'shareholder', 'investor', 'ir.', 'cloudfront', 'amazonaws', 'sec.gov'];
//   const blacklist = ['.vn', '.be', '.cn', '.ru', 'seekingalpha', 'motleyfool', 'debtagency', 'zacks'];

//   logger.info(`🔍 Filtering logic: Must match Company AND Date (Year: ${targetYear}/${nextYear}, Quarter: Q${quarter})`);

//   const validCandidates = urls.filter(url => {
//     const lowerUrl = url.toLowerCase();

//     // 🛑 1. Blacklist Check
//     if (blacklist.some(bad => lowerUrl.includes(bad))) {
//       logger.info(`   🗑️ Rejected (Blacklist): ${url}`);
//       return false;
//     }

//     // 🛑 2. Company Identity Check
//     const hasNameMatch = lowerUrl.includes(simplifiedName);
//     const hasTickerMatch = (symbol.length >= 4) && lowerUrl.includes(tickerLower);
//     const isHighTrust = highTrustDomains.some(d => lowerUrl.includes(d));

//     // אם אין שם חברה ואין טיקר - זה מסוכן מדי, גם בשרת אמין
//     if (!hasNameMatch && !hasTickerMatch && !isHighTrust) {
//       logger.info(`   🗑️ Rejected (Identity mismatch): ${url}`);
//       return false;
//     }

//     // =========================================================
//     // 🛑 3. DATE & QUARTER VALIDATION (החלק שביקשת!)
//     // =========================================================
    
//     // א. בדיקת שנה: האם הלינק מכיל את 2025 או 2026?
//     // אם הלינק מכיל *רק* שנים ישנות (2023, 2024) - הוא נפסל
//     const hasTargetYear = lowerUrl.includes(targetYear) || lowerUrl.includes(nextYear);
//     const hasOldYearOnly = lowerUrl.includes((year - 1).toString()) && !hasTargetYear;
    
//     if (hasOldYearOnly) {
//       logger.info(`   🗑️ Rejected (Old year detected): ${url}`);
//       return false;
//     }

//     // ב. בדיקת רבעון שלילית ("Killer"): האם מופיע רבעון לא נכון?
//     // למשל: אנחנו מחפשים Q4, אבל בלינק כתוב "Q3-Results" -> לפח.
//     // אבל! צריך להיזהר ממצבים כמו "Q4-vs-Q3". לכן נבדוק בזהירות.
    
//     // נבדוק אם יש *במפורש* רבעון שגוי ואין את הרבעון הנכון
//     const hasWrongQ = wrongQPatterns.some(wq => lowerUrl.includes(wq) || lowerUrl.includes(wq.replace('q', '') + 'q')); // checks q3 and 3q
//     const hasCorrectQ = currentQPatterns.some(cq => lowerUrl.includes(cq));

//     if (hasWrongQ && !hasCorrectQ) {
//       logger.info(`   🗑️ Rejected (Wrong quarter): ${url}`);
//       return false;
//     }

//     // ג. בדיקת רבעון חיובית: האם מופיע הרבעון הנכון או השנה הנכונה?
//     if (!hasTargetYear && !hasCorrectQ) {
//        // אם אין שום זכר לשנה או לרבעון - זה חשוד (אלא אם זה דף ראשי כמו /latest-results)
//        // אבל ב-PDFים ישירים בדרך כלל התאריך בשם הקובץ.
//        // נהיה קשוחים: אם אין שנה ואין רבעון - נפסול.
//        logger.info(`   🗑️ Rejected (No date indicators): ${url}`);
//        return false;
//     }

//     return true;
//   });

//   if (validCandidates.length === 0) {
//     logger.warn(`   ⚠️ All URLs filtered out by Date/Company checks.`);
//     return null;
//   }

//   // ============================================
//   // שלב הבחירה (Grok) - נשאר זהה
//   // ============================================
//   if (validCandidates.length === 1) {
//     logger.info(`   ✅ Only 1 valid candidate remains: ${validCandidates[0]}`);
//     return validCandidates[0];
//   }

//   logger.info(`\n🤖 Asking Grok to choose from ${validCandidates.length} VALIDATED links...`);
  
//   const prompt = `
// You are a strict validator.
// TARGET: ${symbol} (${companyName})
// QUARTER: Q${quarter} ${year}

// VERIFIED CANDIDATES (Date & Name Checked):
// ${validCandidates.map((url, i) => `${i + 1}. ${url}`).join('\n')}

// INSTRUCTIONS:
// 1. Select the URL that is the **Official Earnings Press Release**.
// 2. Prefer domains like q4cdn.com, ir.${simplifiedName}.com.
// 3. The URL MUST be for the correct timeframe (Q${quarter} ${year}).

// OUTPUT:
// Return ONLY the chosen URL.
// `;

//   try {
//     const response = await callGrokAPI([{ role: "user", content: prompt }], 0.1, 250, false);
//     const selected = response.trim().replace(/['"]/g, '');
    
//     if (selected.includes("NONE") || !selected.startsWith('http')) return null;
//     if (!validCandidates.includes(selected)) return validCandidates[0];

//     logger.info(`   ✅ Grok selected: ${selected}`);
//     return selected;

//   } catch (error: any) {
//     logger.error(`❌ Grok filtering failed, using first safe candidate.`);
//     return validCandidates[0];
//   }
// }
/**
 * Step 3: Validate that a PDF URL is actually accessible
 */


/**
 * Step 4: Orchestrate the entire PDF discovery flow
 */



// async function findReliablePdfUrl(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string 
// ): Promise<string | null> {
//   // 1. קבל את התוצאה הראשונה מגוגל
//   const urls = await searchEarningsPdf(symbol, companyName, quarter, year, reportDate);

//   if (urls.length === 0) return null;

//   const bestUrl = urls[0]; // זה הלינק הראשון והיחיד

//   // 2. בדיקה טכנית קטנה (רק לוודא שהלינק חי ולא 404)
//   logger.info(`🔍 Checking if link is alive: ${bestUrl}`);
  
 
//   return bestUrl;
// }

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
  fiscalYear?: number,
  cachedIRPortal?: IRPortal | null ,
    onIRPortalFound?: (portal: IRPortal) => void  // ✅ הוסף את זה

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
  
const validatedPdfUrl = await findEarningsPdf(
    symbol,
    companyName,
    q,
    yr,
    reportDate,
    cachedIRPortal,
    onIRPortalFound  // ✅ העבר את ה-callback
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
  // STEP 3: AI SUPPLEMENT - NOW WITH VERIFIED PDF URL!
  // ============================================
  logger.info(`\n🤖 Step 3: AI Supplement Extraction from verified PDF...`);




// Replace ONLY the first few lines of supplementPrompt:


// const supplementPrompt = `
// You are a financial data analyst extracting information from official earnings reports.

// TARGET COMPANY: ${symbol} (${companyName})
// REPORT DATE: ${reportDate}
// QUARTER: Q${q} ${yr}

// 🎯 VERIFIED EARNINGS DOCUMENT: ${validatedPdfUrl}
// ⚠️ This document has been verified to exist. It may be an HTML page or a PDF!

// **IMPORTANT**: 
// - First, use web_search with "open_page" action to read the content from ${validatedPdfUrl}
// - This might be an HTML earnings release page or a PDF document
// - Extract data ONLY from this specific URL!

// ${hasFinnhubData ? `
// KNOWN DATA (Already extracted - DO NOT EXTRACT AGAIN):
// - EPS: ${epsActual} vs estimate ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
// - Revenue: ${(revenueActual! / 1e9).toFixed(2)}B vs estimate ${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)
// ` : `
// ⚠️ CRITICAL: EPS and Revenue NOT yet extracted - you MUST extract them from the document!
// `}

// 🎯 YOUR PRIMARY MISSION: Extract quarterly metrics from this document: ${validatedPdfUrl}

// CRITICAL INSTRUCTIONS:

// **STEP 1: Extract Quarterly Metrics from Document**

// // ... rest of the prompt stays EXACTLY the same ...

// 🔴 CRITICAL RULE: Extract ONLY QUARTERLY data!
// - Look for: "Q${q} ${yr}" and "Q${q} ${yr - 1}"
// - IGNORE: "Full Year ${yr}", "FY ${yr}", "TTM", "Year to Date"

// You MUST extract ALL of these metrics:

// ${!hasFinnhubData ? `
// 1. **EPS** (from document only!):
//    - Actual: Q${q} ${yr} diluted EPS
//    - Estimate: Wall Street consensus (might be mentioned in the release)
//    - Calculate beatPercent: ((actual - estimate) / |estimate|) * 100

// 2. **Revenue** (from document only!):
//    - Actual: Q${q} ${yr} total revenue (in dollars, NOT billions!)
//    - Estimate: Analyst consensus (might be mentioned)
//    - Calculate beatPercent: ((actual - estimate) / estimate) * 100
// ` : ''}

// 3. **Revenue YoY Growth** (MANDATORY - QUARTERLY ONLY!):
//    - Find: Q${q} ${yr} revenue vs Q${q} ${yr - 1} revenue
//    - Calculate: ((current - prior) / prior) * 100
//    - Return as number (e.g., 7.0 for +7%)

// 4. **Net Margin Q${q}** (MANDATORY):
//    - (Net Income / Revenue) * 100 for Q${q} ${yr}
//    - Return as number (e.g., 17.5 for 17.5%)

// 5. **Operating Margin OR Efficiency Ratio** (MANDATORY):
//    🏦 FOR BANKS: Extract "Efficiency Ratio" if mentioned
//    🏭 FOR NON-BANKS: Calculate (Operating Income / Revenue) * 100

// 6. **Cash from Operations Q${q}** (MANDATORY - QUARTERLY ONLY):
//    - Find: "Cash from operations" or "Operating cash flow" for Q${q} ${yr}
//    - Return in MILLIONS (e.g., 1500 for $1.5B)

// **STEP 3: Extract Qualitative Data**

// 7. **Guidance**:
//    - Status: "raised" | "lowered" | "maintained" | "unavailable"
//    - Details: One sentence in HEBREW explaining what changed

// 8. **Sentiment**:
//    - Overall: "positive" | "neutral" | "negative"  
//    - Reasoning: One sentence in HEBREW explaining why

// 9. **Highlights**: Exactly 2 bullet points (specific achievements from the report)

// 10. **Concerns**: Exactly 2 bullet points (specific risks/challenges mentioned)

// OUTPUT FORMAT - Return ONLY this JSON:
// {
//   "pdfUrl": "${validatedPdfUrl}",
//   ${!hasFinnhubData ? `
//   "eps": {
//     "actual": <number>,
//     "estimate": <number>,
//     "beatPercent": <number>
//   },
//   "revenue": {
//     "actual": <number in dollars>,
//     "estimate": <number in dollars>,
//     "beatPercent": <number>
//   },
//   ` : ''}
//   "guidance": {
//     "status": "raised" | "lowered" | "maintained" | "unavailable",
//     "details": "משפט בעברית" | null
//   },
//   "sentiment": {
//     "overall": "positive" | "neutral" | "negative",
//     "reasoning": "משפט בעברית" | null
//   },
//   "highlights": ["Achievement 1", "Achievement 2"],
//   "concerns": ["Risk 1", "Risk 2"],
//   "pdfMetrics": {
//     "revenueYoY": 7.0 | null,
//     "netMargin": 17.5 | null,
//     "marginMetric": {
//       "type": "efficiency_ratio" | "operating_margin",
//       "value": 62.5,
//       "source": "document section",
//       "verified": true
//     } | null,
//     "cashFromOperations": 1500 | null
//   }
// }

// ⚠️ CRITICAL RULES:
// 1. MUST use web_search to read ${validatedPdfUrl} first!
// 2. Extract ONLY quarterly metrics (not TTM, not annual)
// 3. If you cannot find a metric → return null
// 4. Return ONLY valid JSON - NO markdown, NO explanations

// Return ONLY valid JSON.
// `;

// CLAUDE
// const supplementPrompt = `
// You are a professional financial data analyst extracting QUARTERLY earnings data from official reports.

// ════════════════════════════════════════════════════════════════
// 📊 EXTRACTION MISSION
// ════════════════════════════════════════════════════════════════

// TARGET COMPANY: ${symbol} (${companyName})
// REPORT DATE: ${reportDate}
// QUARTER: Q${q} ${yr}

// 🎯 VERIFIED EARNINGS DOCUMENT: ${validatedPdfUrl}

// 🚨🚨🚨 ABSOLUTE CRITICAL RULE - READ FIRST 🚨🚨🚨

// THIS EXTRACTION IS FOR **QUARTERLY DATA ONLY** - Q${q} ${yr}

// ❌ NEVER USE:
// - Annual data (Full Year, FY, Fiscal Year)
// - TTM (Trailing Twelve Months)
// - Year-to-Date (YTD)
// - Twelve months / Cumulative
// - Any period other than Q${q} ${yr}

// ✅ ONLY USE:
// - Data explicitly labeled "Q${q} ${yr}" or "Fourth Quarter ${yr}"
// - Data from quarterly comparison tables showing Q${q} ${yr} vs Q${q} ${yr-1}
// - Data from section clearly titled "Three months ended [date]"

// If you cannot find QUARTERLY data → return null
// DO NOT convert annual to quarterly
// DO NOT use TTM as substitute
// DO NOT estimate from other periods

// ════════════════════════════════════════════════════════════════
// 🔴 FORBIDDEN KEYWORDS - AUTOMATIC DISQUALIFICATION
// ════════════════════════════════════════════════════════════════

// If ANY of these appear near a number you're extracting → DISQUALIFY IT:

// ❌ FORBIDDEN PHRASES:
// - "full year"
// - "fiscal year"
// - "FY"
// - "trailing twelve months"
// - "TTM"
// - "year-to-date"
// - "YTD"
// - "twelve months"
// - "cumulative"
// - "annual"
// - "annualized" (EXCEPT for spreads/ratios where explicitly allowed)

// Example:
// Document: "Full year 2025 net interest income: $850M"
// → Contains "full year" → REJECT, return null

// Document: "Fourth quarter net interest income: $206M"
// → No forbidden keywords → ACCEPT

// ════════════════════════════════════════════════════════════════
// 🔴 DATA SOURCE RULES & PRIORITIES
// ════════════════════════════════════════════════════════════════

// **STEP 0: READ THE DOCUMENT**
// - Use web_search with "open_page" action to read: ${validatedPdfUrl}
// - This is an HTML earnings release or PDF document

// **PRIORITY ORDER FOR FINDING DATA:**

// 1️⃣ **TABLES** (HIGHEST PRIORITY)
//    - Look for tables with headers containing "Q${q} ${yr}"
//    - Look for tables with "Three months ended [date in ${yr}]"
//    - Tables are most reliable - prefer over narrative text

// 2️⃣ **HIGHLIGHTED FINANCIAL RESULTS SECTION**
//    - Usually at top of document
//    - "Financial Highlights" or "Summary Results"

// 3️⃣ **FIRST PARAGRAPH**
//    - Opening paragraph often has key metrics
//    - Must mention "fourth quarter" or "Q${q}"

// 4️⃣ **MD&A / MANAGEMENT DISCUSSION** (LOWEST PRIORITY)
//    - Only if clearly labeled as quarterly
//    - Verify period carefully

// **CONFLICT RESOLUTION:**
// If there is a conflict between narrative text and a numbered table:
// → ALWAYS prefer the table (especially if headers explicitly show quarter)

// **🚨 DATA SOURCE RULES:**

// ✅ ALLOWED:
// - Extract data directly from ${validatedPdfUrl}
// - Quote exact numbers from the document
// - Calculate ratios from numbers in the document (if both are quarterly)
// - Search within same domain if estimate not in document
// - Last resort: Search "${symbol} Q${q} ${yr} consensus estimate" via web_search

// ❌ STRICTLY FORBIDDEN:
// - Use your training data or knowledge base
// - Estimate or guess any numbers
// - Use approximate values ("around", "approximately")
// - Interpolate missing data
// - Use annual data when quarterly is missing
// - Use TTM data when quarterly is missing
// - Fill in estimates with actual values
// - Assume anything not explicitly stated
// - Use data from different quarters/years
// - Convert annual to quarterly by dividing by 4
// - Use TTM and claim it's quarterly

// **🔒 IF QUARTERLY DATA NOT FOUND:**
// - Set value to null immediately
// - DO NOT fabricate, estimate, or guess
// - DO NOT use placeholder values
// - DO NOT use data from different periods
// - DO NOT use annual/TTM as substitute

// ════════════════════════════════════════════════════════════════
// ⚖️ CHAIN OF VERIFICATION
// ════════════════════════════════════════════════════════════════

// For EVERY number you extract, follow this process:

// **BEFORE EXTRACTING:**
// 1. Scan entire document for mentions of "Q${q} ${yr}", "three months ended", "fourth quarter"
// 2. List all locations where quarter is mentioned (table headers, section titles, paragraphs)
// 3. Identify which location has the metric you need
// 4. Verify no forbidden keywords appear near the number

// **DURING EXTRACTION:**
// 5. Quote the exact sentence/cell with the number
// 6. Verify the period label is explicitly present
// 7. Check units (millions, billions, dollars)
// 8. Verify number is reasonable for the metric

// **AFTER EXTRACTION:**
// 9. Ask: "Is this number explicitly labeled Q${q} ${yr}?"
// 10. Ask: "Did I avoid using annual/TTM/YTD?"
// 11. Ask: "Can I quote the exact source with period label?"
// 12. Ask: "Is this from a table or verified quarterly section?"

// If ANY answer is NO → return null

// ════════════════════════════════════════════════════════════════
// 🔢 UNIT DETECTION RULES
// ════════════════════════════════════════════════════════════════

// **CRITICAL: Always verify and convert units correctly!**

// **UNIT DETECTION:**
// - "million", "M", "mil", "MM" → multiply by 1,000,000
// - "billion", "B", "bil", "bn" → multiply by 1,000,000,000
// - "thousand", "K" → multiply by 1,000

// **CONTEXT CLUES:**
// - If table header says "($ in millions)" → all numbers are millions
// - If text says "amounts in millions" → multiply by 1,000,000
// - If no unit but number seems small (e.g. revenue 500) → check context

// **VALIDATION:**
// - Revenue typically: $10M - $50B per quarter
// - EPS typically: $0.05 - $20.00
// - Cash flow typically: -$5B to +$10B
// - If outside these ranges → verify unit conversion

// **SAFETY CHECK:**
// If number looks unrealistically small/large → suspect wrong unit:
// - Revenue of 500 (should be 500M = 500,000,000)
// - EPS of 50 (should be $0.50)
// → If uncertain about unit → return null

// ════════════════════════════════════════════════════════════════
// 🏢 STEP 1: IDENTIFY COMPANY TYPE
// ════════════════════════════════════════════════════════════════

// Before extracting data, determine the company type:

// 🏦 **REITs (Real Estate Investment Trusts):**
// - Company name includes "REIT"
// - Business: Real estate, mortgages, MBS (Mortgage-Backed Securities)
// - Examples: AGNC, NLY, STWD, O, SPG
// - Key indicator: Main revenue is "Net interest income" not "Revenue"

// 🏦 **BANKS/FINANCIAL INSTITUTIONS:**
// - Business: Banking, lending, financial services
// - Examples: JPM, BAC, WFC, C
// - Key indicator: Reports "Net interest income" and "Efficiency ratio"

// 🏭 **REGULAR COMPANIES:**
// - Any other company (tech, retail, manufacturing, etc.)
// - Key indicator: Reports "Total revenue" or "Net revenues"

// ════════════════════════════════════════════════════════════════
// 📋 STEP 2: EXTRACT QUARTERLY DATA ONLY
// ════════════════════════════════════════════════════════════════

// ${!hasFinnhubData ? `
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1️⃣ EPS - QUARTERLY Q${q} ${yr} ONLY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **CHAIN OF VERIFICATION - BEFORE EXTRACTING:**
// 1. Scan document for "Q${q} ${yr}" or "fourth quarter ${yr}" mentions
// 2. Check tables first - look for table headers with quarter labels
// 3. Identify section with EPS data
// 4. Verify no forbidden keywords (full year, TTM, annual)

// **PRIORITY SEARCH:**
// 1️⃣ Table with "Q${q} ${yr}" column header
// 2️⃣ "Financial Highlights" section
// 3️⃣ First paragraph with quarter mention
// 4️⃣ Income statement with period label

// **WHAT TO EXTRACT:**

// A) EPS ACTUAL - QUARTERLY Q${q} ${yr}:

// 🏦 **FOR REITs:**
// Look for (MUST say Q${q} ${yr}):
// - "Fourth quarter diluted earnings per share"
// - "Q${q} ${yr} core earnings per share"
// - "Q${q} ${yr} net spread & dollar roll income per share"
// - "Earnings per common share for Q${q} ${yr}"

// Example (REIT):
// ✅ "Net spread & dollar roll income of $0.35 per common share for the fourth quarter"
//    → actual: 0.35

// ❌ "Full year earnings per share of $1.50" → Contains "full year" → REJECT
// ❌ "Diluted EPS of $0.83" without quarter → verify from table header or context

// 🏦 **FOR BANKS:**
// 🏭 **FOR REGULAR COMPANIES:**
// Look for (MUST say Q${q} ${yr}):
// - "Fourth quarter diluted earnings per share"
// - "Q${q} ${yr} diluted EPS"

// **TABLE PRIORITY:**
// If EPS appears in both text and table → use table value (more reliable)

// 🔒 MUST QUOTE: Copy exact sentence including period reference.

// Example:
// ✅ Table:
//    | Period | Diluted EPS |
//    |Q4 2025 | $0.83      |
//    → actual: 0.83, source: "Table - Q4 2025 column"

// 🚨 VALIDATION:
// - MUST explicitly mention Q${q}, "fourth quarter", or "three months ended"
// - Check for forbidden keywords nearby
// - Verify unit (should be dollars per share, typically $0.05-$20)
// - If no quarter label → check table headers
// - If still unclear → return null

// B) EPS ESTIMATE (Consensus):

// Look for phrases near the actual:
// - "compared to consensus estimate of $X.XX"
// - "vs. analyst expectations of $X.XX"
// - "beat estimates of $X.XX"

// ⚠️ IF ESTIMATE NOT IN DOCUMENT:
// 1. Search within document thoroughly
// 2. Search: "site:${validatedPdfUrl.split('/')[2]} ${symbol} Q${q} ${yr} EPS estimate consensus"
// 3. Last resort: "${symbol} Q${q} ${yr} diluted EPS consensus estimate"
// 4. If not found → estimate: null

// C) CALCULATE BEAT PERCENT:

// ONLY if you have both actual AND estimate:
// beatPercent = ((actual - estimate) / |estimate|) * 100

// If estimate is null → beatPercent: null

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2️⃣ REVENUE - QUARTERLY Q${q} ${yr} ONLY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **CHAIN OF VERIFICATION - BEFORE EXTRACTING:**
// 1. Scan for revenue metric tables
// 2. Identify correct revenue type for company (NII vs Total Revenue)
// 3. Locate Q${q} ${yr} column/row
// 4. Verify units and period label

// **PRIORITY SEARCH:**
// 1️⃣ Income statement table with Q${q} ${yr} column
// 2️⃣ Financial highlights section
// 3️⃣ First paragraph with quarterly revenue
// 4️⃣ Comparative table showing current vs prior quarter

// **CRITICAL: Revenue definition depends on company type!**

// A) REVENUE ACTUAL - QUARTERLY Q${q} ${yr}:

// 🏦 **FOR REITs:**

// USE "Net interest income" for Q${q} ${yr} ONLY

// Look for in TABLES FIRST:
// - Table row: "Net interest income" + column "Q${q} ${yr}"
// - Table header: "($ in millions)" or "($ in thousands)"

// Then in text (MUST say Q${q} ${yr}):
// - "Fourth quarter net interest income: $XXX million"
// - "Q${q} ${yr} net interest income of $XXX million"

// Example (REIT):
// ✅ Table showing:
//    | Metric | Q4 2025 |
//    |Net Interest Income | $206M |
//    → actual: 206000000 (convert to dollars!)

// ❌ "Full year net interest income: $850M" → Contains "full year" → REJECT
// ❌ "TTM net interest income: $800M" → Contains "TTM" → REJECT

// ⚠️ DO NOT USE for REITs:
// - "Total comprehensive income" (includes unrealized gains)
// - "Total revenue" (includes non-operating items)
// - Any amount with "annual", "full year", "TTM"

// **UNIT CONVERSION:**
// Check table header or text context:
// - "($ in millions)" → multiply by 1,000,000
// - "($ in thousands)" → multiply by 1,000
// - "$206 million" → 206000000
// - "$0.206 billion" → 206000000

// 🏦 **FOR BANKS:**
// USE "Net interest income" for Q${q} ${yr}

// 🏭 **FOR REGULAR COMPANIES:**
// USE "Total revenue" or "Net revenues" for Q${q} ${yr}

// Look in TABLES FIRST for:
// - Row: "Total revenues" or "Net revenues"
// - Column: "Q${q} ${yr}" or "Three months ended [date]"

// 🔒 MUST QUOTE: Exact source with period.

// 🚨 VALIDATION:
// - MUST be quarterly (check forbidden keywords!)
// - MUST have correct unit conversion
// - Revenue range check:
//   * REITs NII: typically $50M-$1B per quarter
//   * Banks NII: typically $1B-$20B per quarter
//   * Regular companies: typically $100M-$200B per quarter
// - If outside range → verify unit conversion
// - If still wrong → return null

// B) REVENUE ESTIMATE (Consensus):

// Look near actual for:
// - "compared to consensus [metric] of $XXX million"
// - "beat estimates of $XXX million"

// ⚠️ Search if not found:
// - REITs/Banks: "${symbol} Q${q} ${yr} net interest income estimate consensus"
// - Regular: "${symbol} Q${q} ${yr} revenue estimate consensus"

// Convert to same unit as actual!

// If not found → estimate: null

// C) CALCULATE BEAT PERCENT:

// ONLY if both exist:
// beatPercent = ((actual - estimate) / estimate) * 100

// If estimate is null → beatPercent: null

// ` : `
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ✅ EPS & REVENUE ALREADY PROVIDED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Known Data (from Finnhub):
// - EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
// - Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)

// Skip EPS & Revenue extraction, proceed to other metrics.
// `}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3️⃣ REVENUE YoY GROWTH - QUARTERLY COMPARISON ONLY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 🚨🚨🚨 MOST CRITICAL METRIC - READ CAREFULLY 🚨🚨🚨

// **CHAIN OF VERIFICATION - BEFORE EXTRACTING:**
// 1. Scan for comparative tables showing Q${q} ${yr} vs Q${q} ${yr-1}
// 2. Verify BOTH quarters are explicitly labeled
// 3. Check for forbidden keywords (full year, annual, TTM)
// 4. Confirm using correct revenue metric for company type

// **PRIORITY SEARCH:**
// 1️⃣ Year-over-year comparison table with Q${q} columns
// 2️⃣ "Comparative Results" section
// 3️⃣ Text explicitly comparing two quarters
// 4️⃣ If not found in any of above → return null immediately

// **WHAT TO EXTRACT:**

// You MUST find BOTH values with EXPLICIT quarterly labels:

// 🏦 **FOR REITs/BANKS:**

// MUST find BOTH in table or text:
// - Q${q} ${yr} net interest income: $XXX million
// - Q${q} ${yr - 1} net interest income: $XXX million

// **Examples of CORRECT sources:**

// ✅ TABLE (BEST):
//    | Period  | Net Interest Income |
//    |---------|-------------------|
//    | Q4 2025 | $206M            |
//    | Q4 2024 | $222M            |
//    → Q4 2025: 206, Q4 2024: 222

// ✅ TEXT WITH EXPLICIT LABELS:
//    "Fourth quarter 2025 net interest income was $206M compared to $222M in the fourth quarter of 2024"
//    → Q4 2025: 206, Q4 2024: 222

// ✅ SECTION WITH CLEAR HEADERS:
//    "Q4 2025 Results: NII $206M"
//    "Q4 2024 Results: NII $222M"
//    → Q4 2025: 206, Q4 2024: 222

// **Examples of WRONG sources - REJECT IMMEDIATELY:**

// ❌ "Full-year 2025 net interest income: $1.5B vs $1.4B in 2024"
//    → Contains "full-year" → REJECT

// ❌ "TTM net interest income: $800M vs prior TTM $850M"
//    → Contains "TTM" → REJECT

// ❌ "Annual net interest income increased 7% year-over-year"
//    → Contains "annual" → REJECT

// ❌ "Net interest income for 2025: $1.5B"
//    → No quarter label → REJECT

// ❌ Table showing only one period or mixing annual with quarterly
//    → REJECT

// 🏭 **FOR REGULAR COMPANIES:**

// MUST find BOTH (explicitly quarterly):
// - Q${q} ${yr} total revenue: $XXX million
// - Q${q} ${yr - 1} total revenue: $XXX million

// Same validation rules!

// 🔒 MUST QUOTE EXACT SOURCE:
// "Source: [Table name/Text location] showing Q${q} ${yr}: $XXX, Q${q} ${yr - 1}: $XXX"

// **CALCULATION:**
// ((current - prior) / prior) * 100

// Example:
// ✅ Q4 2025 NII: $206M, Q4 2024 NII: $222M
//    → ((206 - 222) / 222) * 100 = -7.21%
//    → revenueYoY: -7.21

// 🚨 ULTRA-CRITICAL VALIDATION:

// BEFORE returning a value, answer these:
// 1. ✅ Do BOTH numbers explicitly say Q${q} or "fourth quarter"?
// 2. ✅ Are they in a comparison table with quarter column headers?
// 3. ✅ Did I check for "full year", "annual", "FY", "TTM", "YTD" near numbers?
// 4. ✅ Am I comparing same quarter (Q${q} ${yr} vs Q${q} ${yr-1})?
// 5. ✅ Am I using correct metric (NII for REITs/Banks, Revenue for Regular)?
// 6. ✅ Is result reasonable (-50% to +50%)?
// 7. ✅ Did I verify units match for both numbers?

// If ANY answer is NO → return null IMMEDIATELY

// ⚠️ COMMON MISTAKES - DO NOT MAKE THESE:

// ❌ MISTAKE 1: Using full-year data
//    "2025: $1.5B, 2024: $1.4B → +7.1%"
//    → This is ANNUAL not quarterly → REJECT

// ❌ MISTAKE 2: Using TTM
//    "TTM: $800M vs prior TTM: $850M → -5.9%"
//    → This is TTM not quarterly → REJECT

// ❌ MISTAKE 3: Estimating from annual
//    "No quarterly data, so annual $1.2B / 4 = $300M per quarter"
//    → Never estimate → REJECT, return null

// ❌ MISTAKE 4: Missing quarter label
//    "Current period: $206M, Prior period: $222M"
//    → No explicit Q${q} label → REJECT, return null

// ❌ MISTAKE 5: Mixing periods
//    "Q4 2025: $206M vs Full Year 2024: $850M"
//    → Different period types → REJECT

// ⚠️ IF QUARTERLY COMPARISON NOT FOUND:
// - DO NOT calculate from annual
// - DO NOT use TTM
// - DO NOT divide annual by 4
// - DO NOT estimate or guess
// - Return: null

// **This is CRITICAL - better null than wrong data!**

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4️⃣ NET MARGIN - QUARTERLY Q${q} ${yr} ONLY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **CHAIN OF VERIFICATION:**
// 1. Find quarterly income statement table
// 2. Locate Q${q} ${yr} column
// 3. Find Net Income row
// 4. Find Revenue row (use appropriate metric for company type)
// 5. Verify BOTH are from same period
// 6. Check units match

// **WHAT TO EXTRACT:**

// Find for Q${q} ${yr} ONLY (both must be from same period):
// - Net Income: $XXX million (Q${q} ${yr})
// - Revenue: $XXX million (Q${q} ${yr})

// 🏦 **FOR REITs/BANKS:**
// Calculate: (Q${q} ${yr} Net Income / Q${q} ${yr} Net Interest Income) * 100

// ⚠️ NOTE: REITs can have >100% margins!
// This is NORMAL due to:
// - Unrealized gains on investments
// - Mark-to-market accounting
// - Comprehensive income including non-cash items

// Acceptable range for REITs: -50% to 1000%

// Example (REIT - Table):
// | Metric | Q4 2025 |
// |Net Income/Comprehensive Income | $955M |
// |Net Interest Income | $206M |
// → netMargin: (955 / 206) * 100 = 463.6%
// This is HIGH but NORMAL for REITs!

// 🏭 **FOR REGULAR COMPANIES:**
// Calculate: (Q${q} ${yr} Net Income / Q${q} ${yr} Total Revenue) * 100

// Acceptable range: -20% to 50%

// 🔒 MUST QUOTE: "Q${q} ${yr} Net Income: $XXX, [Revenue metric]: $XXX, Source: [Table/Section name]"

// 🚨 VALIDATION:
// - BOTH numbers from Q${q} ${yr}
// - NOT from annual/TTM
// - Units converted correctly
// - Result within acceptable range for company type
// - If using comprehensive income (REITs) → >100% is OK

// ⚠️ IF QUARTERLY DATA NOT FOUND:
// - DO NOT use annual divided by 4
// - DO NOT mix periods
// - Return: null

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5️⃣ OPERATING METRIC - QUARTERLY/ANNUALIZED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **DEPENDS ON COMPANY TYPE:**

// 🏦 **FOR BANKS/FINANCIAL INSTITUTIONS:**

// Look for "Efficiency Ratio" (may be quarterly or annualized):
// - Check tables first for Q${q} ${yr} column
// - Check financial highlights section
// - Look for "efficiency ratio" or "adjusted efficiency ratio"

// 🔒 MUST QUOTE with period if available:
// "Fourth quarter efficiency ratio: XX.X%" or "Efficiency ratio: XX.X%"

// If found → Return:
// {
//   "type": "efficiency_ratio",
//   "value": XX.X,
//   "source": "[exact quote]",
//   "verified": true
// }

// Typical range: 45%-80% (lower is better)

// 🏦 **FOR REITs:**

// Look for "Net Interest Spread" (usually annualized rate):
// - "Net interest spread: X.XX%"
// - "Annualized net interest spread for Q${q}: X.XX%"
// - "Economic return on tangible equity: XX.X%"

// ⚠️ Net interest spread is typically ANNUALIZED - this is OK!
// It's a rate/percentage, not an absolute amount.

// Example (REIT):
// ✅ "Annualized net interest spread of 1.81% for the fourth quarter"
//    → type: "net_interest_spread", value: 1.81

// If found → Return:
// {
//   "type": "net_interest_spread",
//   "value": X.XX,
//   "source": "[exact quote]",
//   "verified": true
// }

// Typical range: 0.5%-3.5%

// 🏭 **FOR REGULAR COMPANIES:**

// Calculate Operating Margin from Q${q} ${yr} quarterly data:
// - Find in table: Q${q} ${yr} Operating Income
// - Find in table: Q${q} ${yr} Revenue
// - Calculate: (Operating Income / Revenue) * 100

// BOTH must be from Q${q} ${yr}!

// 🔒 MUST QUOTE: "Q${q} ${yr} Operating Income: $XXX, Revenue: $XXX"

// Return:
// {
//   "type": "operating_margin",
//   "value": XX.X,
//   "source": "Calculated from Q${q} ${yr} quarterly data",
//   "verified": true
// }

// Typical range: -10% to 45%

// ⚠️ IF DATA NOT FOUND:
// - Return: null

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6️⃣ CASH FROM OPERATIONS - QUARTERLY Q${q} ${yr} ONLY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **CHAIN OF VERIFICATION:**
// 1. Look for cash flow statement
// 2. Find Q${q} ${yr} column/section
// 3. Locate "Operating Activities" section
// 4. Find cash from operations line
// 5. Verify it's quarterly (not annual)
// 6. Check units

// **WHAT TO EXTRACT:**

// 🏦 **FOR REITs:**

// ⚠️ REITs often do NOT report traditional "Cash from Operations"

// Instead, look for REIT-specific metrics (if quarterly):
// - "Q${q} ${yr} Distributable Earnings"
// - "Q${q} ${yr} Core Earnings"
// - "Q${q} ${yr} FFO" (Funds From Operations)
// - "Q${q} ${yr} Adjusted Distributable Earnings"

// If cash flow statement exists with quarterly data:
// - "Q${q} ${yr} cash from operating activities"
// - "Net cash provided by operating activities for the three months ended [date]"

// Example:
// ✅ "Fourth quarter distributable earnings: $604 million"
// ✅ "Q4 2025 FFO: $604 million"

// ❌ "Liquidity: $7.6B" → This is NOT cash flow!
// ❌ "Capital raise: $356M" → This is financing, not operations!
// ❌ "Annual FFO: $2.4B" → This is annual!

// 🏦 **FOR BANKS:**
// 🏭 **FOR REGULAR COMPANIES:**

// Look in cash flow statement for Q${q} ${yr}:
// - Table row: "Cash from operations" or "Net cash from operating activities"
// - Column: "Q${q} ${yr}" or "Three months ended [date]"

// 🔒 MUST QUOTE with period: "Q${q} ${yr} cash from operations: $XXX million, Source: Cash Flow Statement"

// Return in MILLIONS:
// - "$604 million" → 604
// - "$0.604 billion" → 604

// 🚨 VALIDATION:
// - MUST be quarterly (Q${q} ${yr})
// - MUST be from "operating activities" section
// - NOT liquidity, NOT capital raise, NOT financing activities
// - Units converted correctly
// - Typical range: -$5,000M to +$10,000M per quarter

// ⚠️ IF QUARTERLY DATA NOT FOUND:
// - DO NOT use annual / 4
// - DO NOT use liquidity as substitute
// - DO NOT use financing activities
// - Return: null

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7️⃣ GUIDANCE - Future Outlook
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **WHERE TO FIND:**
// - "Outlook" section
// - "2026 Guidance" or "Full Year 2026 Guidance"
// - CEO/CFO commentary about future expectations

// **WHAT TO EXTRACT:**

// Look for phrases indicating guidance change:

// **RAISED:**
// - "raised guidance"
// - "increased outlook"
// - "upgraded forecast"
// - "raising expectations"
// → status: "raised"

// **LOWERED:**
// - "lowered guidance"
// - "reduced outlook"
// - "revised downward"
// - "cutting expectations"
// → status: "lowered"

// **MAINTAINED:**
// - "reaffirmed guidance"
// - "maintaining outlook"
// - "reiterating guidance"
// - "unchanged expectations"
// → status: "maintained"

// **UNAVAILABLE:**
// - No guidance section
// - "not providing guidance"
// - "suspending guidance"
// → status: "unavailable"

// 🔒 MUST QUOTE: Exact sentence mentioning guidance.

// **Details in HEBREW - Rules:**
// - Maximum 1 sentence
// - Natural Hebrew (not Google Translate style)
// - Include key numbers/dates if mentioned
// - Be specific and concise

// Example:
// Document: "Company raised full-year 2026 revenue guidance from $3.8 billion to $4.1 billion due to strong customer demand"

// → {
//   "status": "raised",
//   "details": "החברה העלתה את תחזית ההכנסות לשנת 2026 מ-3.8 ל-4.1 מיליארד דולר בשל ביקוש חזק"
// }

// ⚠️ Guidelines for Hebrew text:
// ✅ "החברה העלתה תחזית מ-X ל-Y"
// ✅ "תחזית ההכנסות הועלתה ב-15%"
// ✅ "ההנהלה הורידה את התחזית ל-2026"

// ❌ "החברה אמרה שהיא מעלה את ההשקפה שלה" (too literal translation)
// ❌ Long explanations (keep to 1 sentence!)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8️⃣ SENTIMENT - Management Tone
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// **WHERE TO FIND:**
// - CEO/CFO quotes in press release
// - "Management Commentary" section
// - Opening or closing statements

// **WHAT TO ANALYZE:**

// 🔒 MUST QUOTE: 1-2 key sentences from management.

// **POSITIVE INDICATORS:**
// Words: "strong", "excellent", "robust", "optimistic", "excited", "confident", "pleased", "exceptional", "outstanding", "solid", "record"
// → sentiment: "positive"

// **NEGATIVE INDICATORS:**
// Words: "challenging", "difficult", "weakness", "concerns", "headwinds", "pressure", "disappointing", "uncertain", "soft", "volatile"
// → sentiment: "negative"

// **NEUTRAL INDICATORS:**
// Words: "stable", "in line", "as expected", "mixed", "balanced", "consistent", "steady"
// → sentiment: "neutral"

// **Reasoning in HEBREW - Rules:**
// - Maximum 2 sentences
// - Natural Hebrew language
// - Based directly on quoted management statements
// - Include key themes mentioned
// - Be specific, not generic

// Example:
// Document quotes:
// "We delivered exceptional results this quarter and remain optimistic about continued growth in 2026. Market conditions are favorable."

// → {
//   "overall": "positive",
//   "reasoning": "ההנהלה מציינת תוצאות יוצאות דופן ומביעה אופטימיות לגבי המשך צמיחה ב-2026, תוך ציון תנאי שוק נוחים"
// }

// ⚠️ Guidelines for Hebrew reasoning:
// ✅ Natural flow in Hebrew
// ✅ Specific to actual quotes
// ✅ Concise (max 2 sentences)
// ✅ Include key themes/numbers if mentioned

// ❌ Generic statements not tied to quotes
// ❌ Long explanations
// ❌ Literal word-by-word translations

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9️⃣ HIGHLIGHTS - Key Achievements (2 items)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Extract EXACTLY 2 achievements MENTIONED IN DOCUMENT:

// **Look for:**
// - Product launches
// - Market share gains
// - Cost reductions/efficiency improvements
// - Record revenues/profits
// - Successful acquisitions/partnerships
// - Geographic expansion
// - New customer wins
// - Operational milestones
// - Technology achievements

// Be SPECIFIC with numbers when available!

// 🔒 MUST REFERENCE: Each highlight must cite something in document.

// **In HEBREW:**
// ✅ "השיקה מוצר חדש שהניב 50 מיליון דולר הכנסות ברבעון"
// ✅ "הגדילה נתח שוק ב-15% בשוק האירופי"
// ✅ "השלימה רכישה של חברת X ב-200 מיליון דולר"

// ❌ DO NOT invent!
// If only 1 highlight found → ["highlight", null]
// If no highlights found → ["לא צוינו הישגים ספציפיים", null]

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔟 CONCERNS - Key Risks (2 items)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Extract EXACTLY 2 risks/challenges MENTIONED IN DOCUMENT:

// **Look for:**
// - Margin pressure
// - Increased competition
// - Regulatory challenges
// - Supply chain issues
// - Market headwinds
// - Rising costs (materials, labor)
// - Currency headwinds
// - Demand weakness
// - Operational challenges
// - Legal/compliance issues

// Be SPECIFIC!

// 🔒 MUST REFERENCE: Each concern must cite something in document.

// **In HEBREW:**
// ✅ "לחץ על שולי הרווח עקב עלייה של 12% במחירי חומרי גלם"
// ✅ "תחרות מוגברת מיצרנים זרים בשוק האמריקאי"
// ✅ "אי ודאות רגולטורית בשווקים מתעוררים"

// ❌ DO NOT invent!
// If only 1 concern found → ["concern", null]
// If no concerns found → ["לא צוינו סיכונים ספציפיים", null]

// ════════════════════════════════════════════════════════════════
// 📤 OUTPUT FORMAT
// ════════════════════════════════════════════════════════════════

// Return ONLY this JSON structure:

// {
//   "pdfUrl": "${validatedPdfUrl}",
//   "companyType": "REIT" | "Bank" | "Regular",
//   ${!hasFinnhubData ? `
//   "eps": {
//     "actual": <number> | null,
//     "estimate": <number> | null,
//     "beatPercent": <number> | null
//   },
//   "revenue": {
//     "actual": <number in dollars> | null,
//     "estimate": <number in dollars> | null,
//     "beatPercent": <number> | null,
//     "revenueType": "net_interest_income" | "total_revenue"
//   },
//   ` : ''}
//   "guidance": {
//     "status": "raised" | "lowered" | "maintained" | "unavailable",
//     "details": "משפט תמציתי בעברית" | null
//   },
//   "sentiment": {
//     "overall": "positive" | "neutral" | "negative",
//     "reasoning": "1-2 משפטים בעברית טבעית"
//   },
//   "highlights": [
//     "הישג ספציפי ראשון בעברית (או null)",
//     "הישג ספציפי שני בעברית (או null)"
//   ],
//   "concerns": [
//     "סיכון ספציפי ראשון בעברית (או null)",
//     "סיכון ספציפי שני בעברית (או null)"
//   ],
//   "pdfMetrics": {
//     "revenueYoY": <number> | null,
//     "netMargin": <number> | null,
//     "marginMetric": {
//       "type": "efficiency_ratio" | "net_interest_spread" | "operating_margin",
//       "value": <number>,
//       "source": "ציטוט מדויק או תיאור חישוב",
//       "verified": true
//     } | null,
//     "cashFromOperations": <number in millions> | null
//   }
// }

// ════════════════════════════════════════════════════════════════
// 🚨 FINAL VALIDATION CHECKLIST
// ════════════════════════════════════════════════════════════════

// **BEFORE RETURNING JSON - CHECK EVERYTHING:**

// **META-CHECK:**
// ❓ Did I follow the Chain of Verification for each metric?
// ❓ Did I prioritize tables over narrative text?
// ❓ Did I check for forbidden keywords near every number?
// ❓ Did I verify unit conversions?
// ❓ Did I check for conflicts (table vs text) and prefer table?

// **COMPANY TYPE:**
// ❓ Did I correctly identify company type (REIT/Bank/Regular)?
// ❓ Did I use correct revenue metric for this type?

// ${!hasFinnhubData ? `
// **EPS:**
// ❓ Explicitly labeled Q${q} ${yr}?
// ❓ Can quote source with period?
// ❓ No forbidden keywords nearby?
// ❓ Reasonable value ($0.05-$20)?
// ❓ If estimate = actual exactly → verified it's true?

// **REVENUE:**
// ❓ Used correct metric (NII for REITs/Banks, Total Revenue for Regular)?
// ❓ Explicitly labeled Q${q} ${yr}?
// ❓ Converted to DOLLARS (not millions)?
// ❓ Value has 7-10 digits (e.g. 206000000)?
// ❓ Can quote source with period?
// ❓ No forbidden keywords?
// ` : ''}

// **YoY REVENUE (MOST CRITICAL):**
// ❓ Found comparison table with BOTH Q${q} ${yr} and Q${q} ${yr-1}?
// ❓ BOTH periods explicitly labeled with quarter?
// ❓ NO "full year", "annual", "TTM", "FY" near numbers?
// ❓ Used correct metric (NII vs Total Revenue)?
// ❓ Result is reasonable (-50% to +50%)?
// ❓ If no quarterly comparison found → returned null?
// ❓ Did NOT use annual data?
// ❓ Did NOT estimate or divide by 4?

// **NET MARGIN:**
// ❓ BOTH numerator and denominator from Q${q} ${yr}?
// ❓ Can quote source for each?
// ❓ Used correct revenue metric?
// ❓ Result reasonable for company type?
// ❓ If REIT with >100% → accepted as normal?

// **OPERATING METRIC:**
// ❓ Identified correct type for company?
// ❓ Quoted source?
// ❓ Value reasonable for metric type?

// **CASH FROM OPERATIONS:**
// ❓ Quarterly value for Q${q} ${yr}?
// ❓ From "operating activities" section?
// ❓ NOT liquidity/capital raise?
// ❓ For REITs: used appropriate metric (FFO/distributable)?
// ❓ Value in MILLIONS?

// **QUALITATIVE:**
// ❓ Guidance: Quoted exact source?
// ❓ Guidance details: Natural Hebrew, max 1 sentence, includes numbers/dates?
// ❓ Sentiment: Quoted 1-2 management statements?
// ❓ Sentiment reasoning: Natural Hebrew, max 2 sentences, specific to quotes?
// ❓ Highlights: Both referenced in document? Natural Hebrew? Specific?
// ❓ Concerns: Both referenced in document? Natural Hebrew? Specific?

// **HEBREW TEXT QUALITY:**
// ❓ All Hebrew text is natural (not Google Translate style)?
// ❓ Concise (within sentence limits)?
// ❓ Includes specific numbers/details when available?
// ❓ No generic statements?

// **SAFETY CHECKS:**
// ❓ All null values are intentional (data truly not found)?
// ❓ No fabricated or estimated data?
// ❓ No use of TTM/Annual when quarterly needed?
// ❓ All unit conversions correct?
// ❓ All numbers are reasonable ranges?

// **ULTRA-CRITICAL - IF YOU USED ANY OF THESE, GO BACK AND FIX:**
// 🚨 Full year / Annual data for quarterly metrics
// 🚨 TTM (Trailing Twelve Months) for quarterly metrics
// 🚨 YTD (Year to Date) for quarterly metrics
// 🚨 Annual divided by 4 to estimate quarterly
// 🚨 Estimates or guesses for missing data
// 🚨 Data without period labels
// 🚨 Wrong revenue metric for company type
// 🚨 Liquidity instead of cash from operations

// ════════════════════════════════════════════════════════════════

// Return ONLY valid JSON. No markdown, no explanations, no extra text.
// `;


const supplementPrompt = `
You are a professional financial data analyst extracting QUARTERLY earnings data from official reports.

════════════════════════════════════════════════════════════════
📊 EXTRACTION MISSION
════════════════════════════════════════════════════════════════

TARGET COMPANY: ${symbol} (${companyName})
REPORT DATE: ${reportDate}
QUARTER: Q${q} ${yr}

🎯 VERIFIED EARNINGS DOCUMENT: ${validatedPdfUrl}

🚨🚨🚨 ABSOLUTE CRITICAL RULE - READ FIRST 🚨🚨🚨

THIS EXTRACTION IS FOR **QUARTERLY DATA ONLY** - Q${q} ${yr}

❌ NEVER USE:
- Annual data (Full Year, FY, Fiscal Year)
- TTM (Trailing Twelve Months)
- Year-to-Date (YTD)
- Twelve months / Cumulative
- Any period other than Q${q} ${yr}

✅ ONLY USE:
- Data explicitly labeled "Q${q} ${yr}" or "Fourth Quarter ${yr}"
- Data from quarterly comparison tables showing Q${q} ${yr} vs Q${q} ${yr-1}
- Data from section clearly titled "Three months ended [date]"

If you cannot find QUARTERLY data → return null.

════════════════════════════════════════════════════════════════
🔴 FORBIDDEN KEYWORDS - AUTOMATIC DISQUALIFICATION
════════════════════════════════════════════════════════════════

If ANY of these appear near a number you're extracting → DISQUALIFY IT:

❌ FORBIDDEN PHRASES:
- "full year", "fiscal year", "FY"
- "trailing twelve months", "TTM"
- "year-to-date", "YTD"
- "twelve months", "cumulative", "annual"

Example:
Document: "Full year 2025 net interest income: $850M" → REJECT
Document: "Fourth quarter net interest income: $206M" → ACCEPT

════════════════════════════════════════════════════════════════
🏢 STEP 1: IDENTIFY COMPANY TYPE
════════════════════════════════════════════════════════════════

Determine the company type to select the right metrics:

🏦 **REITs (e.g., AGNC, NLY):**
- Key Indicator: "Net spread", "Net interest income", "Book Value".
- **CRITICAL:** For REITs, "Total Revenue" (GAAP) is often meaningless/negative. Use "Net Interest Income".

🏦 **BANKS:**
- Key Indicator: "Efficiency ratio", "Provision for credit losses".

🏭 **REGULAR:**
- Key Indicator: "Total Revenue", "Gross Margin".

════════════════════════════════════════════════════════════════
📋 STEP 2: EXTRACT QUARTERLY DATA
════════════════════════════════════════════════════════════════

${!hasFinnhubData ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ EPS (QUARTERLY Q${q} ${yr})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A) ACTUAL:
- **REITs:** Look for **"Net Spread and Dollar Roll Income per share"** OR **"Core Earnings per share"**. (Do NOT use GAAP EPS if it reflects unrealized losses).
- **Others:** Look for "Diluted EPS".
- Quote the exact source.

B) ESTIMATE:
- Consensus estimate matching the metric above.

C) BEAT PERCENT:
- ((actual - estimate) / |estimate|) * 100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2️⃣ REVENUE (QUARTERLY Q${q} ${yr})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A) ACTUAL:
- **REITs:** Extract **"Net Interest Income"** ($ Value) OR **"Net Spread and Dollar Roll Income"** ($ Value).
  * ⚠️ WARNING: If GAAP "Total Revenue" is negative due to mark-to-market, IGNORE IT. Find the positive operating figure.
- **Banks:** "Net Interest Income".
- **Regular:** "Total Revenue".

⚠️ CONVERT TO DOLLARS (e.g., "206 million" → 206000000).

B) ESTIMATE:
- Consensus estimate matching the metric above.
` : `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ EPS & REVENUE ALREADY PROVIDED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Known Data:
- EPS: ${epsActual} vs ${epsEstimate} (${epsBeatPercent.toFixed(2)}%)
- Revenue: $${(revenueActual! / 1e9).toFixed(2)}B vs $${(revenueEstimate! / 1e9).toFixed(2)}B (${revBeatPercent.toFixed(2)}%)
`}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3️⃣ REVENUE YoY GROWTH (QUARTERLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Compare Q${q} ${yr} vs Q${q} ${yr - 1}.
- **REITs:** Compare "Net Interest Income" (or the metric used in section 2).
- **Regular:** Compare "Total Revenue".
- Calculate: ((Current - Prior) / Prior) * 100.
- If explicit prior quarter data not found in text → return null.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4️⃣ NET MARGIN (QUARTERLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Calculate: (Net Income / Revenue) * 100.
- **🔥 REIT EXCEPTION:** If the result is > 100% or < -100% (due to unrealized gains/losses), this is "Noise".
  * **ACTION:** Look for **"Economic Return on Tangible Equity"** (often 2%-25%).
  * If found, extract that value instead of the broken margin calculation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5️⃣ OPERATING METRIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- **Banks:** "Efficiency Ratio".
- **REITs:** "Net Interest Spread" (e.g. 2.15%).
- **Regular:** (Operating Income / Revenue) * 100.

Return object: { "type": "...", "value": number, "source": "...", "verified": true }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6️⃣ CASH FROM OPERATIONS (QUARTERLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "Net cash provided by operating activities" (Cash Flow Statement).
- **REITs:** If not available, look for "Distributable Earnings" or "FFO".
- Return in MILLIONS.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7️⃣ GUIDANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Status: "raised" | "lowered" | "maintained" | "unavailable"
- Details: Hebrew sentence.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8️⃣ SENTIMENT & LOGIC (🔥 CRITICAL FIX)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Analyze Management Tone:**

**🔥 THE "BOOK VALUE" RULE (FOR REITs like AGNC):**
- Check **"Tangible Book Value per Share" (TBV)**.
- **IF TBV INCREASED:** Sentiment is **POSITIVE**, even if EPS/Revenue missed.
  * *Reasoning:* "למרות הפספוס ברווח, החברה הציגה עלייה בשווי הנכסי (Book Value), המעידה על יצירת ערך למשקיעים."
- **IF TBV DECREASED:** Sentiment is **NEGATIVE**.

**For Regular Companies:**
- "Strong/Record/Growth" → Positive.
- "Challenging/Headwinds" → Negative.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9️⃣ HIGHLIGHTS (2 items in HEBREW)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Specific achievements (e.g. "Dividends declared: $0.36").
- **REITs:** Must mention Book Value change if found.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔟 CONCERNS (2 items in HEBREW)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Specific risks (e.g. "Interest rate volatility", "Spread widening").

════════════════════════════════════════════════════════════════
📤 OUTPUT FORMAT (STRICT JSON)
════════════════════════════════════════════════════════════════

Return ONLY this JSON structure:

{
  "pdfUrl": "${validatedPdfUrl}",
  "companyType": "REIT" | "Bank" | "Regular",
  ${!hasFinnhubData ? `
  "eps": {
    "actual": <number> | null,
    "estimate": <number> | null,
    "beatPercent": <number> | null
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
    "details": "משפט בעברית" | null
  },
  "sentiment": {
    "overall": "positive" | "neutral" | "negative",
    "reasoning": "משפט בעברית (חובה להתייחס ל-Book Value אם רלוונטי)"
  },
  "highlights": [
    "הישג 1",
    "הישג 2"
  ],
  "concerns": [
    "חשש 1",
    "חשש 2"
  ],
  "pdfMetrics": {
    "revenueYoY": <number> | null,
    "netMargin": <number> | null,
    "marginMetric": {
      "type": "efficiency_ratio" | "net_interest_spread" | "operating_margin",
      "value": <number>,
      "source": "string",
      "verified": true
    } | null,
    "cashFromOperations": <number in millions> | null
  }
}
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
            content: `You are a financial data extraction API. The PDF URL has been verified to exist: ${validatedPdfUrl}. Extract data ONLY from this PDF. Return ONLY valid JSON with no markdown.`
          },
          {
            role: "user",
            content: supplementPrompt
          }
        ],
        0.05, // Very low temperature for factual extraction
        3000,
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
      now.setDate(now.getDate()); // הורדת יומיים
      const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const currentHour = nyTime.getHours();
      const currentMinute = nyTime.getMinutes();
      
      const [windowHour, windowMinute] = windowStart.split(':').map(Number);
      
      // המר לדקות מחצות
      const currentMinutesFromMidnight = currentHour * 60 + currentMinute;
      const windowMinutesFromMidnight = windowHour * 60 + windowMinute;
      
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
        logger.info(`🚀 FINNHUB CONFIRMED: ${stock.symbol}`);
        reportConfirmed = true;
      } else {
        logger.info(`🔍 Running AI mini-check...`);
        const miniCheckResult = await miniCheck(
          stock.symbol, 
          stock.companyName, 
          stock.quarter, 
          stock.fiscalYear
        );
        
        if (miniCheckResult.result === "YES") {
          logger.info(`🤖 AI CONFIRMED: ${stock.symbol}`);
          reportConfirmed = true;
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
           (irPortal) => {
    stock.cachedIRPortal = irPortal;
    
    // ✅ עדכן את קובץ ה-JSON
    const filePath = path.join(__dirname, "../data/stocksReportingToday.json");
    
    try {
      const currentState = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const stockIndex = currentState.stocks.findIndex((s: any) => s.symbol === stock.symbol);
      
      if (stockIndex !== -1) {
        currentState.stocks[stockIndex].cachedIRPortal = irPortal;
        fs.writeFileSync(filePath, JSON.stringify(currentState, null, 2));
        logger.info(`💾 [${stock.symbol}] Cached IR portal: ${irPortal.url}`);
      }
    } catch (e: any) {
      logger.error(`❌ [${stock.symbol}] Failed to save IR cache: ${e.message}`);
    }
  }
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