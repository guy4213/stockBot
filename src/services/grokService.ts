import axios from 'axios';
import { GrokMessage } from '../types/grok.types';
import logger, { stockLog } from '../utils/structureLogger';
import { findIRCandidates, GROK_API_KEY, IRPortal, MAX_API_RETRIES, verifyIRWithFlash } from './openRouterService';

const TRUSTED_CDN_DOMAINS = [
  'q4cdn.com',
  'cloudfront.net',
  'amazonaws.com',
  'sec.gov',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
];

export async function callGrokAPI(
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
    
    // verifiedIR = await grokVerifyIR(symbol, companyName, irCandidates);
    verifiedIR = await verifyIRWithFlash(symbol, companyName, irCandidates);
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
- The PDF may be hosted on a CDN like q4cdn.com or cloudfront.net — that is acceptable

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
✅ Be the official Q${quarter} ${year} earnings release for ${companyName}
✅ Mention Q${quarter} or "${quarterName} quarter" AND year ${year}
✅ Be published around ${reportDate} (±7 days acceptable)
✅ PDFs hosted on CDN domains (q4cdn.com, cloudfront.net, etc.) are valid

AVOID:
❌ Earnings call transcripts
❌ Previous quarters (Q${quarter - 1}, Q${quarter - 2}, etc.)
❌ Different years

OUTPUT FORMAT:
Return ONLY the direct URL to the earnings document.
Just the URL, nothing else.

If you cannot find it after thorough searching, return:
NOT_FOUND: [brief explanation of what you tried]

EXAMPLE GOOD OUTPUTS:
https://investors.agnc.com/news/news-details/2026/AGNC-Reports-Fourth-Quarter-2025-Results/default.aspx
https://s2.q4cdn.com/510812146/files/doc_financials/2025/q4/2026-02-23-DE-IR-4Q25-Earnings-Release-Kit-vTC1.pdf

EXAMPLE BAD OUTPUT:
NOT_FOUND: Could only find pre-announcement, no actual report.
`;

  logger.info(`   Calling Grok with web_search capability...`);

  try {
    const grokResponse = await callGrokAPI(
      [{ role: 'user', content: prompt }],
      0.1,
      3000,
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

    const isDomainMatch = urlDomain.includes(expectedDomain) || expectedDomain.includes(urlDomain);
    const isTrustedCDN = TRUSTED_CDN_DOMAINS.some(cdn => urlDomain.includes(cdn));

    if (!isDomainMatch && !isTrustedCDN) {
      logger.warn(`   ⚠️ URL domain mismatch!`);
      logger.warn(`   Expected: ${expectedDomain}`);
      logger.warn(`   Got: ${urlDomain}`);
      logger.warn(`   Not a trusted CDN either — rejecting`);
      return null;
    }

    if (isTrustedCDN && !isDomainMatch) {
      logger.info(`   ✅ Trusted CDN domain accepted: ${urlDomain}`);
    } else {
      logger.info(`   ✅ Domain verified: ${urlDomain}`);
    }

    return url;

  } catch (e: any) {
    logger.error(`   ❌ Grok search failed: ${e.message}`);
    return null;
  }
}