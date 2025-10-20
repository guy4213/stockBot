import express from "express";
import cron from "node-cron";

import healthCheckRoutes from "./routes/healthCheckRoutes";
import mainRoutes from "./routes/mainRoutes";
import { errorHandler, requestLogger } from "./middleware/errorHandler";
import logger from "./utils/logger";
import { getEarningsCalendar } from "./services/stockService";
import { mainFlow } from "./controllers/mainController";
import { readFile, saveFile } from "./utils/file";

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

  // 🔹 טען tracking
  const allProcessedReports = readFile("previouslySentReports.json") as any;
  
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
  let deletedDates = 0;
  let deletedSymbolsCount = 0;
  
  logger.info(`🧹 Starting cleanup process...`);
  logger.info(`   Cutoff date: ${cutoffStr} (keeping ${RETENTION_DAYS} days)`);
  
  for (const [date, symbols] of Object.entries(allProcessedReports)) {
    if (date >= cutoffStr) {
      cleanedTracking[date] = symbols;
      logger.info(`   ✅ Keeping: ${date} (${Object.keys(symbols as any).length} symbols)`);
    } else {
      deletedDates++;
      const symbolsCount = Object.keys(symbols as any).length;
      deletedSymbolsCount += symbolsCount;
      logger.info(`   🗑️  Deleting: ${date} (${symbolsCount} symbols) - older than ${RETENTION_DAYS} days`);
    }
  }
  
  if (deletedDates > 0) {
    logger.info(`\n♻️  Cleanup Summary: Deleted ${deletedDates} dates with ${deletedSymbolsCount} symbols\n`);
  } else {
    logger.info(`\n✨ No old data to clean\n`);
  }
  
  // 🔹 אתחל היום אם צריך
  if (!cleanedTracking[todayStr]) {
    cleanedTracking[todayStr] = {};
    logger.info(`📝 Initialized new date: ${todayStr}`);
  }

  // 🆕 הדפסת המצב אחרי הניקוי
  logger.info(`\n${"=".repeat(60)}`);
  logger.info(`📋 HISTORY AFTER CLEANUP`);
  logger.info(`${"=".repeat(60)}`);
  
  const datesAfterCleanup = Object.keys(cleanedTracking).sort().reverse();
  let totalSymbolsAfterCleanup = 0;
  
  for (const date of datesAfterCleanup) {
    const symbols = cleanedTracking[date];
    const symbolsList = Object.keys(symbols);
    totalSymbolsAfterCleanup += symbolsList.length;
    
    logger.info(`\n   📅 ${date} (${symbolsList.length} symbols):`);
    if (symbolsList.length > 0) {
      logger.info(`      ${symbolsList.join(', ')}`);
    } else {
      logger.info(`      (empty - today's reports will be added here)`);
    }
  }
  
  logger.info(`\n   📊 Total: ${datesAfterCleanup.length} dates, ${totalSymbolsAfterCleanup} symbols`);
  logger.info(`${"=".repeat(60)}\n`);

  // 🔹 עבד כל דוח חדש
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  logger.info(`🔍 Starting to process ${actuallyReported.length} reported companies...\n`);

  for (const company of actuallyReported) {
    const symbol: string = company.symbol;

    try {
      // בדוק אם כבר עיבדנו את המניה הזו (בכל התאריכים של ה-7 ימים!)
      let alreadyProcessed = false;
      let processedDate = null;
      
      for (const [date, symbols] of Object.entries(cleanedTracking)) {
        if ((symbols as any)[symbol]) {
          processedDate = date;
          alreadyProcessed = true;
          break;
        }
      }
      
      if (alreadyProcessed) {
        skippedCount++;
        logger.info(`⏭️  [${skippedCount}/${actuallyReported.length}] Skipping ${symbol} - already processed on ${processedDate}`);
        continue;
      }

      logger.info(`\n${"─".repeat(60)}`);
      logger.info(`🔍 [${processedCount + skippedCount + errorCount + 1}/${actuallyReported.length}] Processing ${symbol}...`);
      logger.info(`   📊 Company: ${symbol}`);
      logger.info(`   💰 EPS: ${company.epsActual} vs ${company.epsEstimated} (${company.epsActual && company.epsEstimated ? ((company.epsActual - company.epsEstimated) / company.epsEstimated * 100).toFixed(1) + '%' : 'N/A'})`);
      logger.info(`   💵 Revenue: $${(company.revenueActual / 1_000_000).toFixed(0)}M vs $${(company.revenueEstimated / 1_000_000).toFixed(0)}M`);
      logger.info(`   ⏰ Time: ${company.time?.toUpperCase() || 'Unknown'}`);

      // 🔹 הרץ ניתוח מלא
      await mainFlow(symbol);

      // 🔹 סמן כמעובד
      cleanedTracking[todayStr][symbol] = {
        processed: true,
        timestamp: new Date().toISOString(),
        epsActual: company.epsActual,
        epsEstimated: company.epsEstimated,
        revenueActual: company.revenueActual,
        revenueEstimated: company.revenueEstimated,
        reportTime: company.time
      };

      // 🔹 שמור מיד (למקרה של crash)
      saveFile("previouslySentReports.json", cleanedTracking);
      
      processedCount++;
      logger.info(`✅ ${symbol} processed and saved successfully`);
      logger.info(`${"─".repeat(60)}`);

    } catch (error: any) {
      errorCount++;
      logger.error(`\n❌ [${processedCount + skippedCount + errorCount}/${actuallyReported.length}] Error processing ${symbol}:`);
      logger.error(`   Error: ${error.message}`);
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
  logger.info(`   📊 Total Handled: ${processedCount + skippedCount + errorCount}/${actuallyReported.length}`);
  logger.info(`${"═".repeat(60)}\n`);
};

// 🔹 הרצה מיידית בהפעלה (אופציונלי - להסרת ההערה לבדיקה)
// runMainFlow();

// 🔹 Schedule: כל 30 דקות
cron.schedule("*/30 * * * *", async () => {
  await runMainFlow();
});

// 🔹 Schedule: בזמנים קריטיים
// cron.schedule("0 9 * * *", async () => {
//   logger.info("\n⏰ === SCHEDULED CHECK: 9:00 AM (BMO Reports) ===\n");
//   await runMainFlow();
// });

// cron.schedule("0 18 * * *", async () => {
//   logger.info("\n⏰ === SCHEDULED CHECK: 6:00 PM (AMC Reports) ===\n");
//   await runMainFlow();
// });

// cron.schedule("0 21 * * *", async () => {
//   logger.info("\n⏰ === SCHEDULED CHECK: 9:00 PM (Final Check) ===\n");
//   await runMainFlow();
// });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);
app.use("/api/healthCheck", healthCheckRoutes);
app.use("/api/main", mainRoutes);
app.use(errorHandler);

export default app;