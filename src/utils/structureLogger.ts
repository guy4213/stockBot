import winston from 'winston';
import path from 'path';

const logDir = path.join(__dirname, '../logs');

// ✅ Winston logger עם קבצים + console
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // ✅ קובץ לכל הלוגים
    new winston.transports.File({ 
      filename: path.join(logDir, 'app.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // ✅ קובץ רק לשגיאות
    new winston.transports.File({ 
      filename: path.join(logDir, 'errors.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3
    }),
    // ✅ Console עם צבעים
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// ✅ פונקציות נוחות למעקב אחר מניות
export const stockLog = {
  miniCheck: (symbol: string, result: 'YES' | 'NO' | 'UNSURE') => {
    const emoji = result === 'YES' ? '✅' : result === 'NO' ? '⏳' : '❓';
    logger.info(`${emoji} [${symbol}] Mini-check: ${result}`);
  },

  irPortalSelected: (symbol: string, url: string, confidence: number) => {
    logger.info(`🌐 [${symbol}] IR Portal: ${url} (confidence: ${confidence})`);
  },

  earningsDocFound: (symbol: string, url: string) => {
    logger.info(`📄 [${symbol}] Earnings doc: ${url}`);
  },

  extractionData: (symbol: string, data: any) => {
    logger.info(`📊 [${symbol}] Extraction results:`, JSON.stringify(data, null, 2));
  },

  sent: (symbol: string) => {
    logger.info(`📤 [${symbol}] Sent to Telegram`);
  },

  error: (symbol: string, error: string, stage: string) => {
    logger.error(`❌ [${symbol}] Error at ${stage}: ${error}`);
  }
};

export default logger;