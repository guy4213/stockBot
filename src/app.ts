import express from "express";
import cron from "node-cron";

import healthCheckRoutes from "./routes/healthCheckRoutes";
import mainRoutes from "./routes/mainRoutes";
import { errorHandler, requestLogger } from "./middleware/errorHandler";
import logger from "./utils/logger";
import { getEarningsCalendar } from "./services/stockService";
import { mainFlow } from "./controllers/mainController";
import { readFile, saveFile } from "./utils/file";
import { ensureCacheIsUpdated, filterUSStocks, fetchAndCacheUSStocks } from "./utils/usStocksCache";

const app = express();

const RETENTION_DAYS = 7; // שמירה רק לשבוע

const runMainFlow = async () => {
  logger.info("🔄 Running scheduled earnings check...");
  
  const todayStr = new Date().toISOString().slice(0, 10);
  logger.info(`📅 Checking earnings for: ${todayStr}`);

  // 🔹 שלוף רק את דוחות היום
  const companiesReportingToday = await getEarningsCalendar(todayStr, todayStr);

  if (!companiesReportingToday || companiesReportingToday.length === 0) {
    logger.info(`📭 No earnings reports scheduled for ${todayStr}`);
    return;
  }

  logger.info(`📊 Total companies on calendar: ${companiesReportingToday.length}`);

  // 🔹 סנן רק מניות שכבר דיווחו (epsActual !== null)
  const actuallyReported = companiesReportingToday.filter(
    (company: any) => 
      company.epsActual !== null && 
      company.revenueActual !== null
  );

  logger.info(`✅ Already reported: ${actuallyReported.length}`);
  logger.info(`⏳ Still pending: ${companiesReportingToday.length - actuallyReported.length}`);

  if (actuallyReported.length === 0) {
    logger.info(`⏳ No completed reports yet for ${todayStr}. Will check again in 30 minutes.`);
    return;
  }

  // 🆕 סינון מניות אמריקאיות בלבד (מהיר מאוד!)
  const allSymbols = actuallyReported.map((c: any) => c.symbol);
  const usSymbolsOnly = await filterUSStocks(allSymbols);
  
  const usStocksActuallyReported = actuallyReported.filter((company: any) =>
    usSymbolsOnly.includes(company.symbol)
  );

  logger.info(`🇺🇸 US stocks only: ${usStocksActuallyReported.length}`);
  logger.info(`🚫 Foreign stocks filtered: ${actuallyReported.length - usStocksActuallyReported.length}`);

  if (usStocksActuallyReported.length === 0) {
    logger.info(`📭 No US stocks reported today.`);
    return;
  }

  // 🔹 טען tracking
  const allProcessedReports = readFile("./previouslySentReports.json") as any;
  
  // 🆕 הדפסת כל המניות שקיימות ב-JSON לפני הניקוי
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`📋 CURRENT HISTORY IN JSON (Before Cleanup)`);
  logger.info(`${"=".repeat(60)}`);
  
  const datesBeforeCleanup = Object.keys(allProcessedReports).sort().reverse();
  let totalSymbolsBeforeCleanup = 0;
  
  if (datesBeforeCleanup.length === 0) {
    logger.info(`   📭 Empty - No history yet`);
  } else {
    for (const date of datesBeforeCleanup) {
      const symbols = allProcessedReports[date];
      const symbolsList = Object.keys(symbols);
      totalSymbolsBeforeCleanup += symbolsList.length;
      
      logger.info(`\n   📅 ${date} (${symbolsList.length} symbols):`);
      logger.info(`      ${symbolsList.join(', ')}`);
    }
  }
  
  logger.info(`\n   📊 Total: ${datesBeforeCleanup.length} dates, ${totalSymbolsBeforeCleanup} symbols`);
  logger.info(`${"=".repeat(60)}\n`);
  
  // 🔹 ניקוי: שמור רק 7 ימים אחרונים
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);
  
  const cleanedTracking: any = {};
  for (const [date, data] of Object.entries(allProcessedReports)) {
    if (date >= cutoffStr) {
      cleanedTracking[date] = data;
    }
  }
  
  logger.info(`🧹 Cleaned old data. Keeping dates from ${cutoffStr} onwards.`);
  
  // 🔹 וודא שהתאריך של היום קיים
  if (!cleanedTracking[todayStr]) {
    cleanedTracking[todayStr] = {};
  }

  // 🔹 לולאה על מניות שדיווחו היום (רק מניות אמריקאיות!)
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const company of usStocksActuallyReported) {
    const symbol = company.symbol;
    
    // בדיקה: האם כבר עיבדנו את המניה הזו היום?
    if (cleanedTracking[todayStr][symbol]?.processed === true) {
      logger.info(`⏭️  ${symbol} - Already processed today, skipping...`);
      skippedCount++;
      continue;
    }

    logger.info(`\n${"─".repeat(50)}`);
    logger.info(`🔄 Processing: ${symbol}`);
    logger.info(`${"─".repeat(50)}`);

    try {
      await mainFlow(symbol);
      
      // סמן כמעובד
      cleanedTracking[todayStr][symbol] = {
        processed: true,
        timestamp: new Date().toISOString()
      };
      saveFile("previouslySentReports.json", cleanedTracking);
      
      processedCount++;
      logger.info(`✅ ${symbol} - Successfully processed and marked as done`);
      
    } catch (error: any) {
      errorCount++;
      logger.error(`❌ Error processing ${symbol}:`);
      logger.error(`   Message: ${error.message}`);
      logger.error(`   Stack: ${error.stack}`);
      
      // סמן כשגיאה (כדי שלא ננסה שוב ושוב)
      cleanedTracking[todayStr][symbol] = {
        processed: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      saveFile("previouslySentReports.json", cleanedTracking);
    }
  }

  // 🆕 הדפסת המצב הסופי
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`📋 FINAL STATE IN JSON (After Processing)`);
  logger.info(`${"=".repeat(60)}`);
  
  const finalDates = Object.keys(cleanedTracking).sort().reverse();
  let finalTotalSymbols = 0;
  
  for (const date of finalDates) {
    const symbols = cleanedTracking[date];
    const symbolsList = Object.keys(symbols);
    finalTotalSymbols += symbolsList.length;
    
    logger.info(`\n   📅 ${date} (${symbolsList.length} symbols):`);
    logger.info(`      ${symbolsList.join(', ')}`);
  }
  
  logger.info(`\n   📊 Total: ${finalDates.length} dates, ${finalTotalSymbols} symbols`);
  logger.info(`${"=".repeat(60)}\n`);

  // 🔹 סיכום סופי
  logger.info(`\n${"═".repeat(60)}`);
  logger.info(`✅ EARNINGS CHECK COMPLETED FOR ${todayStr}`);
  logger.info(`${"═".repeat(60)}`);
  logger.info(`   ✅ Successfully Processed: ${processedCount}`);
  logger.info(`   ⏭️  Skipped (already done): ${skippedCount}`);
  logger.info(`   ❌ Errors: ${errorCount}`);
  logger.info(`   📊 Total Handled: ${processedCount + skippedCount + errorCount}/${usStocksActuallyReported.length}`);
  logger.info(`${"═".repeat(60)}\n`);
};

// 🆕 רענון cache של מניות אמריקאיות (פעם בשבוע)
const refreshUSStocksCache = async () => {
  logger.info("\n🔄 Checking if US stocks cache needs refresh...");
  await ensureCacheIsUpdated();
};

// 🔹 הרצה מיידית בהפעלה
(async () => {
  try {
    // 1. וודא שה-cache מעודכן
    await refreshUSStocksCache();
    
    // 2. הרץ את תהליך העיבוד
    await runMainFlow();
  } catch (error) {
    logger.error("Error in initial run:", error);
  }
})();

// 🔹 Schedule: כל 30 דקות - בדיקת דוחות
cron.schedule("*/30 * * * *", async () => {
  await runMainFlow();
});

// 🔹 Schedule: כל יום ב-3 בבוקר - רענון cache
cron.schedule("0 3 * * *", async () => {
  await refreshUSStocksCache();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);
app.use("/api/healthCheck", healthCheckRoutes);
app.use("/api/main", mainRoutes);
app.use(errorHandler);

export default app;