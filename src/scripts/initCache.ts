/**
 * 🚀 סקריפט אתחול פשוט - יצירת cache של מניות אמריקאיות
 * 
 * הרץ מתיקיית src:
 *   cd src
 *   npx ts-node scripts/initCache.ts
 * 
 * או מהשורש:
 *   npx ts-node src/scripts/initCache.ts
 */

import "../utils/logger"; // טען logger
import { fetchAndCacheUSStocks, getStockInfo } from "../utils/usStocksCache";
import logger from "../utils/logger";

async function main() {
  try {
    // בדיקת API key
    if (!process.env.FMP_API_KEY) {
      console.error("\n❌ ERROR: FMP_API_KEY not found in environment!\n");
      console.error("Solutions:");
      console.error("  1. Check your .env file exists");
      console.error("  2. Verify it contains: FMP_API_KEY=your_key_here");
      console.error("  3. Make sure you're running from the project root\n");
      console.error("Current directory:", process.cwd());
      console.error("FMP_API_KEY value:", process.env.FMP_API_KEY || "undefined");
      process.exit(1);
    }

    logger.info("╔════════════════════════════════════════════════════╗");
    logger.info("║   🇺🇸 US Stocks Cache Initialization            ║");
    logger.info("╚════════════════════════════════════════════════════╝");
    logger.info("");
    logger.info(`API Key: ${process.env.FMP_API_KEY?.substring(0, 10)}...`);
    logger.info("");

    const startTime = Date.now();

    // שלב 1: שליפה ושמירה
    logger.info("📥 Step 1/3: Fetching all US stocks from FMP API...");
    await fetchAndCacheUSStocks();

    // שלב 2: אימות
    logger.info("✅ Step 2/3: Validating cache...");
    const testSymbols = ["AAPL", "MSFT", "TSLA", "GOOGL", "AMZN"];
    let validCount = 0;

    for (const symbol of testSymbols) {
      const info = await getStockInfo(symbol);
      if (info) {
        logger.info(`   ✓ ${symbol}: ${info.name} (${info.exchangeShortName})`);
        validCount++;
      } else {
        logger.warn(`   ✗ ${symbol}: Not found in cache!`);
      }
    }

    if (validCount === testSymbols.length) {
      logger.info(`✅ Validation passed: ${validCount}/${testSymbols.length} stocks found`);
    } else {
      logger.warn(`⚠️  Validation warning: Only ${validCount}/${testSymbols.length} stocks found`);
    }

    // שלב 3: סיכום
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    logger.info("");
    logger.info("╔════════════════════════════════════════════════════╗");
    logger.info("║   ✅ Cache Initialization Complete               ║");
    logger.info("╚════════════════════════════════════════════════════╝");
    logger.info("");
    logger.info(`⏱️  Duration: ${duration}s`);
    logger.info("📁 Cache file: src/data/us_stocks_cache.json");
    logger.info("🔄 Auto-refresh: Every night at 3:00 AM");
    logger.info("");
    logger.info("Next steps:");
    logger.info("  1. Start your application: npm run dev");
    logger.info("  2. The app will now filter only US stocks automatically");
    logger.info("");

    process.exit(0);
  } catch (error: any) {
    logger.error("");
    logger.error("╔════════════════════════════════════════════════════╗");
    logger.error("║   ❌ Cache Initialization Failed                 ║");
    logger.error("╚════════════════════════════════════════════════════╝");
    logger.error("");
    logger.error("Error:", error.message);
    logger.error("");
    logger.error("Possible causes:");
    logger.error("  1. Invalid FMP_API_KEY in .env");
    logger.error("  2. Network connection issues");
    logger.error("  3. FMP API rate limit exceeded (wait 1 minute)");
    logger.error("");
    logger.error("Debug info:");
    logger.error(`  Current dir: ${process.cwd()}`);
    logger.error(`  API Key: ${process.env.FMP_API_KEY?.substring(0, 10) || "undefined"}...`);
    logger.error("");

    process.exit(1);
  }
}

main();