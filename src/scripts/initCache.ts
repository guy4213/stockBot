/**
 * 🚀 סקריפט אתחול פשוט - אימות cache של מניות אמריקאיות
 *
 * הערה: FMP API לא נדרש יותר! משתמש בקובץ us_stocks_cache.json הקיים.
 *
 * הרץ מתיקיית src:
 *   cd src
 *   npx ts-node scripts/initCache.ts
 *
 * או מהשורש:
 *   npx ts-node src/scripts/initCache.ts
 */

import "../utils/logger"; // טען logger
import { getStockInfo } from "../utils/usStocksCache";
import logger from "../utils/logger";
import fs from "fs/promises";
import path from "path";

async function main() {
  try {
    logger.info("╔════════════════════════════════════════════════════╗");
    logger.info("║   🇺🇸 US Stocks Cache Validation                ║");
    logger.info("╚════════════════════════════════════════════════════╝");
    logger.info("");
    logger.info("ℹ️  Note: FMP API is no longer required!");
    logger.info("ℹ️  Using existing us_stocks_cache.json file.");
    logger.info("");

    const startTime = Date.now();

    // שלב 1: בדיקה שהקובץ קיים
    logger.info("📥 Step 1/3: Checking cache file...");
    const cacheFile = path.join(__dirname, "../data/us_stocks_cache.json");

    try {
      await fs.access(cacheFile);
      const data = await fs.readFile(cacheFile, "utf8");
      const cache = JSON.parse(data);

      logger.info(`✅ Cache file found!`);
      logger.info(`   File: ${cacheFile}`);
      logger.info(`   Total stocks: ${cache.count}`);
      logger.info(`   Last updated: ${cache.lastUpdated}`);

      // ספירת מניות לפי בורסה
      const nyseCount = cache.stocks.filter((s: any) => s.exchangeShortName === "NYSE").length;
      const nasdaqCount = cache.stocks.filter((s: any) => s.exchangeShortName === "NASDAQ").length;
      const amexCount = cache.stocks.filter((s: any) => s.exchangeShortName === "AMEX").length;

      logger.info(`   NYSE: ${nyseCount} | NASDAQ: ${nasdaqCount} | AMEX: ${amexCount}`);
    } catch (error) {
      logger.error("❌ Cache file not found!");
      logger.error(`   Expected location: ${cacheFile}`);
      logger.error("   Please ensure the file exists before running.");
      process.exit(1);
    }

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
    logger.info("║   ✅ Cache Validation Complete                   ║");
    logger.info("╚════════════════════════════════════════════════════╝");
    logger.info("");
    logger.info(`⏱️  Duration: ${duration}s`);
    logger.info("📁 Cache file: src/data/us_stocks_cache.json");
    logger.info("ℹ️  FMP API: Not required (using cached data)");
    logger.info("");
    logger.info("Next steps:");
    logger.info("  1. Start your application: npm run dev");
    logger.info("  2. The app will filter only US stocks automatically");
    logger.info("");

    process.exit(0);
  } catch (error: any) {
    logger.error("");
    logger.error("╔════════════════════════════════════════════════════╗");
    logger.error("║   ❌ Cache Validation Failed                     ║");
    logger.error("╚════════════════════════════════════════════════════╝");
    logger.error("");
    logger.error("Error:", error.message);
    logger.error("");
    logger.error("Possible causes:");
    logger.error("  1. Cache file (us_stocks_cache.json) is missing");
    logger.error("  2. Cache file is corrupted or invalid JSON");
    logger.error("  3. File permissions issue");
    logger.error("");
    logger.error("Debug info:");
    logger.error(`  Current dir: ${process.cwd()}`);
    logger.error(`  Expected file: src/data/us_stocks_cache.json`);
    logger.error("");

    process.exit(1);
  }
}

main();