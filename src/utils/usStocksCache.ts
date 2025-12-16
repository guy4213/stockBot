import fs from "fs/promises";
import path from "path";
import logger from "../utils/logger";
import dotenv from "dotenv";

// טען .env מהשורש של הפרויקט
dotenv.config({ path: path.join(__dirname, "../../.env") });

const JSON_FILE = path.join(__dirname, "../data/us_stocks_cache.json");

interface StockSymbol {
  symbol: string;
  name: string;
  price: number;
  exchange: string;
  exchangeShortName: string;
  type: string;
}

// 🔹 שלב 1: שליפת כל המניות האמריקאיות ושמירה ל-JSON
// ⚠️ פונקציה זו לא נדרשת יותר - השתמש בקובץ us_stocks_cache.json הקיים!
// אם אתה צריך לעדכן את הקובץ, עשה זאת ידנית או השתמש בסקריפט חיצוני
export async function fetchAndCacheUSStocks(): Promise<void> {
  logger.warn("⚠️ fetchAndCacheUSStocks is deprecated!");
  logger.warn("   Please use the existing us_stocks_cache.json file.");
  logger.warn("   FMP API is no longer required.");

  // בדיקה אם הקובץ קיים
  try {
    await fs.access(JSON_FILE);
    const data = await fs.readFile(JSON_FILE, "utf8");
    const cache = JSON.parse(data);

    logger.info(`✅ Cache file exists with ${cache.count} stocks`);
    logger.info(`   Last updated: ${cache.lastUpdated}`);
    logger.info("   No need to fetch from API.");
  } catch (error) {
    logger.error("❌ Cache file not found!");
    logger.error("   Please ensure us_stocks_cache.json exists in src/data/");
    throw new Error("Cache file is required. FMP API is no longer used.");
  }
}

// 🔹 שלב 2: בדיקה אם סימול הוא מניה אמריקאית (מהיר מאוד!)
export async function isUSStock(symbol: string): Promise<boolean> {
  try {
    // קריאת הקובץ
    const data = await fs.readFile(JSON_FILE, "utf8");
    const cache = JSON.parse(data);

    // בדיקה פשוטה: האם הסימול קיים ברשימה?
    const exists = cache.stocks.some(
      (s: StockSymbol) => s.symbol === symbol
    );

    return exists;
  } catch (error: any) {
    // אם הקובץ לא קיים, נחזיר true (fallback)
    logger.warn(
      `⚠️  Cache file not found. Run fetchAndCacheUSStocks() first.`
    );
    return true; // fallback - לא נסנן כלום
  }
}

// 🔹 שלב 3: סינון מספר סימולים בבת אחת
export async function filterUSStocks(symbols: string[]): Promise<string[]> {
  try {
    const data = await fs.readFile(JSON_FILE, "utf8");
    const cache = JSON.parse(data);

    // יצירת Set למהירות (case-insensitive!)
    const usStocksSet = new Set(
      cache.stocks.map((s: StockSymbol) => s.symbol.toUpperCase())
    );

    // Debug: הצג את הסימבולים הראשונים שמגיעים
    if (symbols.length > 0) {
      logger.info(`📋 Debug: First 5 symbols to check: ${symbols.slice(0, 5).join(", ")}`);
      logger.info(`📋 Debug: Sample cache symbols: ${Array.from(usStocksSet).slice(0, 5).join(", ")}`);
    }

    // סינון (case-insensitive)
    const notFoundSymbols: string[] = [];
    const filtered = symbols.filter((symbol) => {
      const upperSymbol = symbol.toUpperCase().trim();
      const exists = usStocksSet.has(upperSymbol);

      // אסוף סימבולים שלא נמצאו
      if (!exists && notFoundSymbols.length < 10) {
        notFoundSymbols.push(symbol);
      }

      return exists;
    });

    // Debug: הצג סימבולים שלא נמצאו
    if (notFoundSymbols.length > 0) {
      logger.warn(`   ⚠️ ${notFoundSymbols.length} symbols not found in cache. Examples:`);
      notFoundSymbols.slice(0, 5).forEach(sym => {
        logger.warn(`      - "${sym}"`);
      });
    }

    logger.info(
      `🇺🇸 Filtered: ${filtered.length}/${symbols.length} are US stocks`
    );

    return filtered;
  } catch (error: any) {
    logger.warn(`⚠️  Cache error: ${error.message}. Returning all symbols.`);
    return symbols; // fallback
  }
}

// 🔹 שלב 4: בדיקה אם ה-cache צריך רענון (ישן מעל 7 ימים)
export async function shouldRefreshCache(): Promise<boolean> {
  try {
    const data = await fs.readFile(JSON_FILE, "utf8");
    const cache = JSON.parse(data);

    const lastUpdated = new Date(cache.lastUpdated);
    const now = new Date();
    const daysSinceUpdate =
      (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceUpdate > 7; // רענון כל 7 ימים
  } catch (error) {
    // אם הקובץ לא קיים - צריך רענון
    return true;
  }
}

// 🔹 שלב 5: רענון אוטומטי אם צריך
export async function ensureCacheIsUpdated(): Promise<void> {
  const needsRefresh = await shouldRefreshCache();

  if (needsRefresh) {
    logger.info("🔄 Cache is outdated or missing. Refreshing...");
    await fetchAndCacheUSStocks();
  } else {
    logger.info("✅ Cache is up to date.");
  }
}

// 🔹 שלב 6: קבלת מידע על סימול ספציפי
export async function getStockInfo(
  symbol: string
): Promise<StockSymbol | null> {
  try {
    const data = await fs.readFile(JSON_FILE, "utf8");
    const cache = JSON.parse(data);

    const stock = cache.stocks.find(
      (s: StockSymbol) => s.symbol === symbol
    );

    return stock || null;
  } catch (error) {
    return null;
  }
}

// 🧪 דוגמאות שימוש
/*
// בהפעלה ראשונה (או כל 7 ימים):
await fetchAndCacheUSStocks();

// בדיקה מהירה של סימול בודד:
const isUS = await isUSStock('AAPL');  // true
const isUS2 = await isUSStock('TSCO.L');  // false

// סינון רשימת סימולים:
const symbols = ['AAPL', 'TSCO.L', 'NKE', 'YASKF'];
const usOnly = await filterUSStocks(symbols);  // ['AAPL', 'NKE']

// רענון אוטומטי:
await ensureCacheIsUpdated();  // יבדוק ויעדכן אם צריך
*/