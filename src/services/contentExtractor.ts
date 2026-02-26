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
export async function fetchContentWithJina(url: string): Promise<string> {
  const jinaUrl = `${JINA_BASE_URL}${url}`;

  logger.info(`\n📥 Jina Reader: Fetching content...`);
  logger.info(`   URL: ${jinaUrl}`);

  const response = await axios.get(jinaUrl, {
    timeout: 30000,
    headers: {
      "Accept": "text/plain",
      "X-No-Cache": "true",      // תמיד תוכן עדכני
    }
  });

  const content: string = response.data;

  logger.info(`   ✅ Raw content length: ${content.length} chars`);

  // ולידציה - האם קיבלנו מספיק תוכן?
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error(
      `Jina returned insufficient content (${content.length} chars < ${MIN_CONTENT_LENGTH} minimum)`
    );
  }

  // חיתוך כדי לא להציף את ה-context של Gemini
  const trimmed = content.substring(0, MAX_CONTENT_LENGTH);

  logger.info(`   ✅ Content ready for AI: ${trimmed.length} chars`);

  return trimmed;
}