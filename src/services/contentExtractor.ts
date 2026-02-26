import axios from "axios";
import logger from '../utils/structureLogger';

const JINA_BASE_URL = "https://r.jina.ai/";
const MIN_CONTENT_LENGTH = 2000;   // פחות מזה = תוכן חלקי
const MAX_CONTENT_LENGTH = 30000;  // חותכים כדי לא להציף את Gemini

/**
 * מקבלת URL מאומת של דוח רווח
 * שולחת אותו ל-Jina Reader
 * מחזירה טקסט מלא ונקי לשליחה ל-AI
 */
export async function fetchContentWithJina(url: string): Promise<string | null> {
  const jinaUrl = `${JINA_BASE_URL}${url}`;
  console.log(`jinaURL is: ${jinaUrl}`);
  const response = await axios.get(jinaUrl, {
    timeout: 30000,
    headers: {
      "Accept": "text/plain",
      "X-No-Cache": "true",
    }
  });

  const content: string = response.data;
  logger.info(`   Raw content length: ${content.length} chars`);

  const validation = validateJinaContent(content, url);
  
  if (!validation.valid) {
    logger.warn(`   ⚠️ Content validation failed: ${validation.reason}`);
    return null; // ← קריטי: null = תנסה שוב
  }

  const trimmed = content.substring(0, MAX_CONTENT_LENGTH);
  logger.info(`   ✅ Content ready: ${trimmed.length} chars`);
  return trimmed;
}

function validateJinaContent(content: string, url: string): { 
  valid: boolean; 
  reason?: string 
} {
  // 1. אורך מינימלי
  if (content.length < MIN_CONTENT_LENGTH) {
    return { valid: false, reason: `Too short: ${content.length} chars` };
  }

  // 2. הודעות חסימה/שגיאה שJina מחזיר כ-200 OK
  const BLOCK_PATTERNS = [
    /access denied/i,
    /403 forbidden/i,
    /rate limit/i,
    /too many requests/i,
    /captcha/i,
    /cloudflare/i,
    /please enable javascript/i,
    /this page requires javascript/i,
    /robot or human/i,
  ];

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(content.substring(0, 2000))) { // בדוק רק בהתחלה
      return { valid: false, reason: `Blocked: matched "${pattern}"` };
    }
  }

  // 3. תוכן "ריק" שמכיל בעיקר whitespace/newlines
  const meaningfulChars = content.replace(/\s+/g, '').length;
  if (meaningfulChars < MIN_CONTENT_LENGTH * 0.3) {
    return { valid: false, reason: `Content is mostly whitespace` };
  }

  // 4. ספציפי ל-PDF פיננסי - האם יש מספרים/תאריכים?
  const hasNumbers = /\d{4}|\$[\d,]+|[\d,]+\.\d{2}/.test(content);
  if (!hasNumbers) {
    return { valid: false, reason: `No financial data detected` };
  }

  return { valid: true };
}