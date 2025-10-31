import axios from "axios";
import fs from "fs/promises";
import path from "path";
import logger from "../utils/logger";
import dotenv from "dotenv";

// טען .env מהשורש של הפרויקט
dotenv.config({ path: path.join(__dirname, "../../.env") });

const API_KEY = process.env.FMP_API_KEY;

// וידוא שיש API key
if (!API_KEY) {
  throw new Error("FMP_API_KEY not found in .env file!");
}

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
export async function fetchAndCacheUSStocks(): Promise<void> {
  try {
    logger.info("📥 Fetching all US stocks from FMP API...");

    // שליפה מכל 3 הבורסות האמריקאיות
    const [nyse, nasdaq, amex] = await Promise.all([
      axios.get(
        `https://financialmodelingprep.com/api/v3/symbol/NYSE?apikey=${API_KEY}`
      ),
      axios.get(
        `https://financialmodelingprep.com/api/v3/symbol/NASDAQ?apikey=${API_KEY}`
      ),
      axios.get(
        `https://financialmodelingprep.com/api/v3/symbol/AMEX?apikey=${API_KEY}`
      ),
    ]);

    // איחוד כל הנתונים
    const allStocks: StockSymbol[] = [
      ...nyse.data,
      ...nasdaq.data,
      ...amex.data,
    ];

    logger.info(`📊 Total symbols fetched: ${allStocks.length}`);
    logger.info(`   Breaking down by type...`);

    // בדיקה: כמה מכל סוג?
    const types = allStocks.reduce((acc: any, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {});
    
    logger.info(`   Types found: ${JSON.stringify(types)}`);

    // ✅ שמור הכל - לא רק stocks!
    // הסיבה: גם ETFs, ADRs, Trusts וכו' הם חלק מהשוק האמריקאי
    const validSymbols = allStocks.filter((s) => {
      // סנן רק דברים ממש לא רלוונטיים
      if (!s.symbol || !s.name) return false;
      if (s.symbol.length > 5) return false; // סימולים ארוכים מדי
      return true;
    });

    logger.info(`✅ Keeping ${validSymbols.length} valid symbols (all types)`);

    // שמירה לקובץ JSON עם timestamp
    const cacheData = {
      lastUpdated: new Date().toISOString(),
      count: validSymbols.length,
      stocks: validSymbols,
    };

    // וודא שהתיקייה קיימת
    const dir = path.dirname(JSON_FILE);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(JSON_FILE, JSON.stringify(cacheData, null, 2));

    logger.info(
      `✅ Cached ${validSymbols.length} US symbols to ${JSON_FILE}`
    );
    logger.info(
      `   NYSE: ${nyse.data.length} | NASDAQ: ${nasdaq.data.length} | AMEX: ${amex.data.length}`
    );
  } catch (error: any) {
    logger.error("❌ Error fetching US stocks:", error.message);
    throw error;
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

    // יצירת Set למהירות
    const usStocksSet = new Set(
      cache.stocks.map((s: StockSymbol) => s.symbol)
    );

    // סינון
    const filtered = symbols.filter((symbol) => usStocksSet.has(symbol));

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