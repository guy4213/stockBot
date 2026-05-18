import axios from 'axios';
import { GrokMessage } from '../types/grok.types';
import logger, { stockLog } from '../utils/structureLogger';
import { findIRCandidates, FinnhubEarningsEntry, GROK_API_KEY, IRPortal, MAX_API_RETRIES, verifyIRWithFlash } from './openRouterService';
import { getHistoricalPrices, calcRunUp } from "./stockService";
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const TRUSTED_CDN_DOMAINS = [
  'q4cdn.com',
  'cloudfront.net',
  'amazonaws.com',
  'sec.gov',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'accesswire.com',
  'newsfilecorp.com',
  'sedarplus.ca',
  'sedar.com',
  'seekingalpha.com',
  'finance.yahoo.com'
];
function isJsonComplete(str: string): boolean {
  try {
    const clean = str.replace(/```json|```/g, '').trim();
    JSON.parse(clean);
    return true;
  } catch {
    return false;
  }
}
function mergeJsonContinuation(partial: string, continuation: string): string {
  // מנסה לאחד שני חלקי JSON שנקטע באמצע
  const trimmed = partial.trimEnd();
  const cont = continuation.replace(/```json|```/g, '').trim();
  // אם ה-partial נגמר בתוך מערך — מוסיף את המשך
  if (trimmed.endsWith(',') || trimmed.endsWith('[')) {
    return trimmed + cont;
  }
  return trimmed + cont;
}



// ─── Helper: parse time text → BMO | AMC ──────────────────────────────────
function parseYahooTime(rawTime: string): "BMO" | "AMC" {
  const t = (rawTime || '').toLowerCase().trim();
  if (t.includes('before') || t === 'bmo' || t === 'pre market') return "BMO";
  return "AMC";
}

// ─── Helper: derive quarter + fiscalYear from report date ─────────────────
export function deriveFiscalPeriod(date: string): { quarter: number; fiscalYear: number } {
  const d     = new Date(date + 'T12:00:00Z');
  const month = d.getMonth() + 1;
  const year  = d.getFullYear();
  if (month <= 3) return { quarter: 4, fiscalYear: year - 1 };
  if (month <= 6) return { quarter: 1, fiscalYear: year };
  if (month <= 9) return { quarter: 2, fiscalYear: year };
  return             { quarter: 3, fiscalYear: year };
}




// ─── Fallback: HTML ישיר — 25 בלבד ───────────────────────────────────────
async function scrapeYahooEarningsHTML(
  date: string
): Promise<Array<{ ticker: string; name: string; time: "BMO" | "AMC" }>> {

  logger.info(`  📄 Yahoo HTML fallback for ${date}...`);
  const results: Array<{ ticker: string; name: string; time: "BMO" | "AMC" }> = [];
  const seenTickers = new Set<string>();

  const url = `https://finance.yahoo.com/calendar/earnings?day=${date}&offset=0&size=100`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);

  let timeColIndex = 2;
  $('table thead tr th').each((i, el) => {
    const h = $(el).text().toLowerCase().trim();
    if (h.includes('time') || h.includes('call')) timeColIndex = i;
  });

  $('table tbody tr').each((_, element) => {
    const cols    = $(element).find('td');
    if (cols.length < 3) return;
    const ticker  = $(cols[0]).text().trim().toUpperCase();
    const name    = $(cols[1]).text().trim();
    const rawTime = $(cols[timeColIndex]).text().trim();
    if (!ticker || ticker === 'SYMBOL' || seenTickers.has(ticker)) return;
    seenTickers.add(ticker);
    results.push({ ticker, name, time: parseYahooTime(rawTime) });
  });

  logger.info(`  ✅ HTML fallback: ${results.length} stocks (max 25).`);
  return results;
}

// ─── Primary: Playwright — JS rendering + pagination אמיתי ───────────────
async function scrapeYahooEarningsPlaywright(
  date: string
): Promise<Array<{ ticker: string; name: string; time: "BMO" | "AMC" }>> {

  logger.info(`  🌐 Playwright scraping Yahoo for ${date}...`);

  const results: Array<{ ticker: string; name: string; time: "BMO" | "AMC" }> = [];
  const seenTickers = new Set<string>();
  const PAGE_SIZE = 25;
  const MAX_PAGES = 4;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=128',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    // ✅ viewport קטן — פחות RAM
    viewport: { width: 800, height: 600 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const page = await context.newPage();

  // ✅ חסום תמונות, CSS, fonts — הכי משמעותי לחיסכון ב-RAM
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    for (let p = 0; p < MAX_PAGES; p++) {
      const offset = p * PAGE_SIZE;
      const url = `https://finance.yahoo.com/calendar/earnings?day=${date}&offset=${offset}&size=${PAGE_SIZE}`;

      logger.info(`  📄 Page ${p + 1} (offset=${offset})...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // ✅ סגור consent popup אם קיים
      try {
        const consentBtn = await page.waitForSelector(
          'button[name="agree"], button.accept-all, #consent-page button, [id*="consent"] button',
          { timeout: 5000 }
        );
        if (consentBtn) {
          await consentBtn.click();
          logger.info(`  🍪 Closed consent popup`);
          await page.waitForTimeout(1000);
        }
      } catch {
        // אין popup — בסדר
      }

      // מחכה לטבלה
      const tableExists = await page.waitForSelector('table tbody tr', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);

      if (!tableExists) {
        logger.warn(`  ⚠️ Page ${p + 1}: No table found — stopping.`);
        break;
      }

      const pageRows = await page.evaluate(() => {
        const rows: Array<{ ticker: string; name: string; rawTime: string }> = [];
        let timeCol = 2;
        document.querySelectorAll('table thead tr th').forEach((th, i) => {
          const h = (th.textContent || '').toLowerCase();
          if (h.includes('time') || h.includes('call')) timeCol = i;
        });
        document.querySelectorAll('table tbody tr').forEach(row => {
          const cols = row.querySelectorAll('td');
          if (cols.length < 3) return;
          const ticker  = (cols[0].textContent || '').trim().toUpperCase();
          const name    = (cols[1].textContent || '').trim();
          const rawTime = (cols[timeCol].textContent || '').trim();
          if (ticker && ticker !== 'SYMBOL') rows.push({ ticker, name, rawTime });
        });
        return rows;
      });

      let newOnPage = 0;
      for (const row of pageRows) {
        if (!row.ticker || !/^[A-Z]{1,6}$/.test(row.ticker)) continue;
        if (seenTickers.has(row.ticker)) continue;
        seenTickers.add(row.ticker);
        results.push({ ticker: row.ticker, name: row.name, time: parseYahooTime(row.rawTime) });
        newOnPage++;
      }

      logger.info(`  📄 Page ${p + 1}: ${newOnPage} new stocks (total: ${results.length})`);

      // ✅ הדף האחרון — סגור page מיד לשחרור RAM
      if (pageRows.length < PAGE_SIZE) {
        logger.info(`  ✅ Done. ${results.length} total across ${p + 1} page(s).`);
        await page.close();
        break;
      }

      // ✅ נקה memory בין דפים
      await page.evaluate(() => { (window as any).gc && (window as any).gc(); });
      await page.waitForTimeout(600);
    }

  } catch (err: any) {
    logger.error(`  ❌ Playwright failed: ${err.message}`);
    await browser.close();
    return await scrapeYahooEarningsHTML(date);

  } finally {
    await browser.close();
  }

  logger.info(`  ✅ Playwright complete: ${results.length} stocks.`);
  return results;
}

// ─── Main scraper entry point ──────────────────────────────────────────────
async function scrapeYahooEarnings(
  date: string
): Promise<Array<{ ticker: string; name: string; time: "BMO" | "AMC" }>> {

  // ניסיון 1: Playwright
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      logger.info(`  🌐 Playwright attempt ${attempt}/2...`);
      const results = await scrapeYahooEarningsPlaywright(date);
      if (results.length > 0) return results;
      logger.warn(`  ⚠️ Playwright returned 0 — retrying...`);
    } catch (err: any) {
      logger.error(`  ❌ Playwright attempt ${attempt} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ניסיון 2: HTML fallback (תמיד עובד, 25 בלבד)
  logger.warn(`  🔄 Playwright failed twice — HTML fallback (25 stocks only)`);
  try {
    return await scrapeYahooEarningsHTML(date);
  } catch (err: any) {
    logger.error(`  ❌ HTML fallback also failed: ${err.message}`);
    return [];
  }
}
// ─── Finnhub: מחזיר quarter + fiscalYear לטיקר בודד ──────────────────────
export async function getFinnhubQuarter(
  symbol: string
): Promise<{ quarter: number; fiscalYear: number } | null> {
  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
  if (!FINNHUB_API_KEY) return null;

  try {
    const response = await axios.get<{ earningsCalendar: FinnhubEarningsEntry[] }>(
      `https://finnhub.io/api/v1/calendar/earnings`,
      { params: { symbol, token: FINNHUB_API_KEY }, timeout: 8000 }
    );

    const calendar = response.data?.earningsCalendar ?? [];
    if (calendar.length === 0) return null;

    const entry = calendar[0];
    if (!entry?.quarter || !entry?.year) return null;

    // ✅ וידוא שהטיקר שחזר תואם בדיוק
    if (entry.symbol?.toUpperCase() !== symbol.toUpperCase()) {
      logger.warn(`⚠️ getFinnhubQuarter [${symbol}]: got "${entry.symbol}" — mismatch`);
      return null;
    }

    logger.info(`📅 Finnhub [${symbol}]: Q${entry.quarter} FY${entry.year}`);
    return { quarter: entry.quarter, fiscalYear: entry.year };

  } catch (err: any) {
    logger.warn(`⚠️ getFinnhubQuarter failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ─── Grok fallback: מחזיר quarter + fiscalYear לרשימת טיקרים בקריאה אחת ──
export async function grokGetQuarters(
  tickers: string[],
  date: string
): Promise<Record<string, { quarter: number; fiscalYear: number }>> {
  if (tickers.length === 0) return {};

  logger.info(`🤖 [GrokQuarter] Fallback for ${tickers.length} tickers: ${tickers.join(', ')}`);

  try {
    const content = await callGrokAPI(
      [
        {
          role: 'user',
          content: `The following US-listed stocks are reporting earnings on ${date}:
${tickers.join(', ')}

For each stock, return the fiscal quarter number (1-4) and fiscal year they are reporting.
Return ONLY valid JSON, no explanation, no markdown:
{
  "SLI": { "quarter": 2, "fiscalYear": 2026 },
  "XYZ": { "quarter": 1, "fiscalYear": 2026 }
}`
        }
      ],
      0.1,
      300,
      false
    );

    const clean = content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    logger.info(`✅ [GrokQuarter] Returned: ${Object.keys(parsed).join(', ')}`);
    return parsed;

  } catch (err: any) {
    logger.warn(`⚠️ [GrokQuarter] Failed: ${err.message}`);
    return {};
  }
}
// ─── Main export: grokScanEarningsToday ───────────────────────────────────
export async function grokScanEarningsToday(date: string): Promise<Array<{
  ticker: string;
  name: string;
  time: "BMO" | "AMC";
  source: string;
}>> {
  logger.info(`\n🔍 [GrokScan] Fetching Yahoo Earnings for ${date}...`);

  let scraped: Array<{ ticker: string; name: string; time: "BMO" | "AMC" }> = [];

  try {
    scraped = await scrapeYahooEarnings(date);
  } catch (err: any) {
    logger.error(`❌ [GrokScan] Scraping failed: ${err.message}`);
    return [];
  }

  if (scraped.length === 0) {
    logger.warn(`  ⚠️ No stocks found for ${date}.`);
    return [];
  }

  logger.info(`  ✅ ${scraped.length} unique stocks scraped from Yahoo.`);

  return scraped.map(s => ({
    ticker: s.ticker,
    name:   s.name,
    time:   s.time,
    source: 'Yahoo Finance',
  }));
}

export async function callGrokAPI(
  messages: GrokMessage[],
  temperature: number = 0.3,
  maxTokens: number = 4000,
  enableWebSearch: boolean = false
): Promise<string> {
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY missing");

  const GROK_API_URL = "https://api.x.ai/v1/responses";
  
  const requestBody: any = {
    model: "grok-4.3",
    input: messages,
    temperature,
    max_output_tokens: maxTokens,
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
      
      let contentStr: string | null = null;

      if (typeof content === 'string') {
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
// export async function findEarningsPdf(
//   symbol: string,
//   companyName: string,
//   quarter: number,
//   year: number,
//   reportDate: string,
//   cachedIRPortal?: IRPortal | null,
//   onIRPortalFound?: (portal: IRPortal) => void
// ): Promise<string | null> {
  
//   logger.info(`\n${'═'.repeat(70)}`);
//   logger.info(`🎯 Two-Phase Earnings Discovery: ${symbol}`);
//   logger.info(`${'═'.repeat(70)}`);
  
//   let verifiedIR: IRPortal | null = null;
  
//   // Phase 1: Cache or find IR portal
//   if (cachedIRPortal) {
//     logger.info(`\n💾 CACHE HIT: Using cached IR portal`);
//     verifiedIR = cachedIRPortal;
//   } else {
//     logger.info(`\n🔍 CACHE MISS: Need to find and verify IR portal`);
//     logger.info(`\n📍 PHASE 1: Finding IR Portal...`);
    
//     const irCandidates = await findIRCandidates(symbol, companyName);
    
//     if (irCandidates.length === 0) {
//       logger.error(`❌ No IR candidates found`);
//       return null;
//     }
    
//     // verifiedIR = await grokVerifyIR(symbol, companyName, irCandidates);
//     verifiedIR = await verifyIRWithFlash(symbol, companyName, irCandidates);
//     if (!verifiedIR) {
//       logger.error(`❌ Could not verify IR portal`);
//       return null;
//     }
    
//     verifiedIR.verifiedAt = new Date().toISOString();
//     logger.info(`✅ Verified IR: ${verifiedIR.url}`);
    
//     if (onIRPortalFound) {
//       onIRPortalFound(verifiedIR);
//     }
//   }
  
//   // Phase 2: Let Grok find the earnings document
//   logger.info(`\n📍 PHASE 2: Finding Earnings Document...`);
  
//   const earningsPdf = await phase2_grokFindEarnings(
//     verifiedIR,
//     symbol,
//     companyName,
//     quarter,
//     year,
//     reportDate
//   );
  
//   if (!earningsPdf) {
//     logger.error(`❌ Grok could not find earnings document`);
//     return null;
//   }
  
// if (earningsPdf) {
//   stockLog.earningsDocFound(symbol, earningsPdf);
// }
//   return earningsPdf;
// }

export async function findEarningsPdfCandidates(   // ← שם חדש + return type
  symbol: string,
  companyName: string,
  quarter: number,
  year: number,
  reportDate: string,
  cachedIRPortal?: IRPortal | null,
  onIRPortalFound?: (portal: IRPortal) => void
): Promise<string[]> {   // ← מחזיר מערך

  logger.info(`\n${'═'.repeat(70)}`);
  logger.info(`🎯 Two-Phase Earnings Discovery: ${symbol}`);
  logger.info(`${'═'.repeat(70)}`);

  let verifiedIR: IRPortal | null = null;

  if (cachedIRPortal) {
    logger.info(`\n💾 CACHE HIT: Using cached IR portal`);
    verifiedIR = cachedIRPortal;
  } else {
    logger.info(`\n🔍 CACHE MISS: Finding IR portal...`);
    const irCandidates = await findIRCandidates(symbol, companyName);
    if (irCandidates.length === 0) {
      logger.error(`❌ No IR candidates found`);
      return [];
    }
    verifiedIR = await verifyIRWithFlash(symbol, companyName, irCandidates);
    if (!verifiedIR) {
      logger.error(`❌ Could not verify IR portal`);
      return [];
    }
    verifiedIR.verifiedAt = new Date().toISOString();
    logger.info(`✅ Verified IR: ${verifiedIR.url}`);
    if (onIRPortalFound) onIRPortalFound(verifiedIR);
  }

  const urls = await phase2_grokFindEarnings(
    verifiedIR, symbol, companyName, quarter, year, reportDate
  );

  if (urls.length > 0) {
    stockLog.earningsDocFound(symbol, urls[0]);
  }

  return urls;
}

// שמור את findEarningsPdf הישן לתאימות לאחור
export async function findEarningsPdf(
  symbol: string, companyName: string, quarter: number, year: number,
  reportDate: string, cachedIRPortal?: IRPortal | null,
  onIRPortalFound?: (portal: IRPortal) => void
): Promise<string | null> {
  const candidates = await findEarningsPdfCandidates(
    symbol, companyName, quarter, year, reportDate, cachedIRPortal, onIRPortalFound
  );
  return candidates[0] ?? null;
}

async function phase2_grokFindEarnings(
  irPortal: IRPortal,
  symbol: string,
  companyName: string,
  quarter: number,
  year: number,
  reportDate: string
): Promise<string[]> {

  logger.info(`\n🤖 Instructing Grok to search for earnings documents (up to 3)...`);

  // 1. טיפול חכם ברבעון 4 לעומת דוח שנתי (Full Year)
  const quarterText = quarter === 4 
    ? `Q4 ${year} OR Full Year / FY ${year}` 
    : `Q${quarter} ${year}`;

  // 2. הזרקת התאריך של היום כדי שהמודל יבין מתי זה "עכשיו"
  const todayStr = new Date().toISOString().split('T')[0];

  const prompt = `
You are an expert financial researcher with live web search capabilities.
TODAY'S DATE: ${todayStr}

TASK: Search the web to find up to 3 VALID URLs for the ${quarterText} earnings report of ${companyName} (${symbol}).
You MUST use your web search tool to find the most recent press releases.

VERIFIED IR WEBSITE: ${irPortal.url}
Domain: ${irPortal.domain}

SEARCH STRATEGY:
1. Search recent news for: "${companyName} ${symbol} ${quarterText} earnings press release"
2. Check the IR website's press releases section.
3. Look for the official release on these trusted sources:
  - prnewswire.com
  - businesswire.com
  - globenewswire.com
  - accesswire.com
  - newsfilecorp.com
  - sec.gov / edgar
  - sedarplus.ca / sedar.com
  - seekingalpha.com
  - finance.yahoo.com
  - q4cdn.com / cloudfront.net

REQUIREMENTS for each URL:
✅ Must be the official ${quarterText} earnings release for ${companyName}.
✅ Published around ${reportDate} (±7 days from this target date).
✅ Contains actual financial results (revenue, net income, etc.), NOT a date announcement or estimate.
❌ NOT earnings call transcripts.
❌ NOT from previous quarters.

OUTPUT FORMAT — return ONLY this JSON, nothing else:
{
  "urls": [
    "https://first-url-here",
    "https://second-url-here",
    "https://third-url-here"
  ]
}

If you find fewer than 3, return only what you found.
If you find nothing, return: { "urls": [] }
`;

  try {
    const grokResponse = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1, // טמפרטורה נמוכה כדי לשמור על דיוק
      3000,
      true // הנחתי שזה הפרמטר שמפעיל את החיפוש ברשת (Web Search)
    );

    logger.info(`📄 Grok response preview: ${grokResponse.substring(0, 300)}`);

    const cleanJson = grokResponse.replace(/```json|```/g, '').trim();
    
    // מנסה לפרסר JSON
    let urls: string[] = [];
    try {
      const parsed = JSON.parse(cleanJson);
      urls = (parsed.urls || []).filter((u: any) => typeof u === 'string' && u.startsWith('http'));
    } catch {
      // fallback: מחפש כל URL בתגובה
      const urlMatches = grokResponse.match(/https?:\/\/[^\s<>"',}\]]+/g) || [];
      urls = urlMatches.map(u => u.replace(/[.,;)\]]+$/, '')).slice(0, 3);
    }

    // הדפסה לדיבוג - עוזר מאוד להבין אם המודל מצא משהו שהקוד פסל
    logger.info(`🔍 URLs found by Grok before validation: ${JSON.stringify(urls)}`);

    // וולידציה של כל URL
    const validUrls: string[] = [];
    for (const url of urls) {
      try {
        const urlDomain = new URL(url).hostname.toLowerCase();
        const expectedDomain = irPortal.domain.toLowerCase();
        
        const isDomainMatch = urlDomain.includes(expectedDomain) || expectedDomain.includes(urlDomain);
        const isTrustedCDN = TRUSTED_CDN_DOMAINS.some(cdn => urlDomain.includes(cdn));

        if (isDomainMatch || isTrustedCDN) {
          validUrls.push(url);
          logger.info(`  ✅ Valid URL [${validUrls.length}]: ${url}`);
        } else {
          logger.warn(`  ⚠️ Rejected (domain mismatch): ${url}`);
        }
      } catch {
        logger.warn(`  ⚠️ Invalid URL skipped: ${url}`);
      }
    }

    logger.info(`  📋 Found ${validUrls.length} valid document URLs`);
    return validUrls;

  } catch (e: any) {
    logger.error(`  ❌ Grok search failed: ${e.message}`);
    return [];
  }
}


export function buildPreFilterSignals(
  runUp30d: number | null,
  ahChangePercent: number | null,
  volumeRatio: number | null,
  epsBeatPercent: number | null,
  pricedInClassification: "Fully" | "Partially" | "Not" | null,
  runUp60d: number | null
): string[] {
  const signals: string[] = [];

  // ─── Run-Up 30 יום ────────────────────────────────────────
  if (runUp30d !== null) {
    if (runUp30d > 25) signals.push(`🔴 Run-Up גבוה מאוד: +${runUp30d.toFixed(1)}% ב-30 יום`);
    else if (runUp30d > 15) signals.push(`🟡 Run-Up משמעותי: +${runUp30d.toFixed(1)}% ב-30 יום`);
    else if (runUp30d < -10) signals.push(`🟢 ירידה לפני דוח: ${runUp30d.toFixed(1)}% ב-30 יום (לא Priced-In)`);
    else signals.push(`⚪ Run-Up נמוך: ${runUp30d.toFixed(1)}% ב-30 יום`);
  }

  // ─── Beat קטן אחרי Run-Up גדול ───────────────────────────
  if (runUp30d !== null && runUp30d > 15 && epsBeatPercent !== null) {
    if (epsBeatPercent < 0) {
      signals.push(`🚨 EPS Miss מהותי: ${epsBeatPercent.toFixed(1)}% אחרי Run-Up של +${runUp30d.toFixed(1)}% - סיכון גבוה מאוד`);
    } else if (epsBeatPercent < 5) {
      signals.push(`🚨 אזהרה: Beat קטן (+${epsBeatPercent.toFixed(1)}%) אחרי Run-Up גדול - סיכון Sell-The-News`);
    }
  }

  // ─── AH ──────────────────────────────────────────────────
  if (ahChangePercent !== null) {
    if (ahChangePercent >= 4)       signals.push(`🟢 AH חיובי חזק: +${ahChangePercent.toFixed(1)}%`);
    else if (ahChangePercent > 0)   signals.push(`🟢 AH חיובי: +${ahChangePercent.toFixed(1)}%`);
    else if (ahChangePercent === 0)  signals.push(`⚪ AH ניטרלי: 0.0%`);
    else if (ahChangePercent <= -4) signals.push(`🔴 AH שלילי חזק: ${ahChangePercent.toFixed(1)}% - Market Negative Signal`);
    else                            signals.push(`🟡 AH שלילי קל: ${ahChangePercent.toFixed(1)}%`);
  } else {
    signals.push(`⚪ AH: לא זמין`);
  }

  // ─── Volume ───────────────────────────────────────────────
  if (volumeRatio !== null) {
    if (volumeRatio >= 3)        signals.push(`🟢 נפח חריג: ×${volumeRatio.toFixed(1)} מהממוצע`);
    else if (volumeRatio >= 1.5) signals.push(`🟢 נפח מאשר: ×${volumeRatio.toFixed(1)} מהממוצע`);
    else                         signals.push(`🟡 נפח חלש: ×${volumeRatio.toFixed(1)} מהממוצע - חוסר אישור`);
  }

  // ─── Priced-In (חדש) ─────────────────────────────────────
  if (pricedInClassification !== null && runUp60d !== null) {
    if (pricedInClassification === "Fully")
      signals.push(`🔴 Priced-In: מתומחר במלואו — Run-Up 60d: +${runUp60d.toFixed(1)}%`);
    else if (pricedInClassification === "Partially")
      signals.push(`🟡 Priced-In: מתומחר חלקית — Run-Up 60d: +${runUp60d.toFixed(1)}%`);
    else
      signals.push(`🟢 Priced-In: לא מתומחר — Run-Up 60d: ${runUp60d.toFixed(1)}%`);
  }

  return signals;
}
