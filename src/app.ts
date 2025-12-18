// import express from "express";
// import cron from "node-cron";

// import healthCheckRoutes from "./routes/healthCheckRoutes";
// import mainRoutes from "./routes/mainRoutes";
// import { errorHandler, requestLogger } from "./middleware/errorHandler";
// import logger from "./utils/logger";
// import { morningIntelligence, miniCheck } from "./services/grokService";
// import { mainFlow } from "./controllers/mainController";
// import { readFile, saveFile } from "./utils/file";
// import { ensureCacheIsUpdated } from "./utils/usStocksCache";

// const app = express();

// const RETENTION_DAYS = 7; // שמירה רק לשבוע

// // ============================================
// // 1. MORNING INTELLIGENCE - רק בבוקר!
// // ============================================
// const runMorningIntelligence = async () => {
//   const todayStr = new Date().toISOString().slice(0, 10);

//   logger.info("\n╔════════════════════════════════════════════════════╗");
//   logger.info("║   🌅 MORNING INTELLIGENCE - Fetching Today's Stocks   ║");
//   logger.info("╚════════════════════════════════════════════════════╝");
//   logger.info(`📅 Date: ${todayStr}\n`);

//   try {
//     const morningData = await morningIntelligence(todayStr);

//     logger.info(`✅ Grok found ${morningData.stocks.length} US stocks reporting today`);

//     if (morningData.stocks.length > 0) {
//       logger.info(`\n📋 Stocks Reporting Today:`);
//       morningData.stocks.forEach((stock, index) => {
//         logger.info(
//           `   ${index + 1}. ${stock.symbol} (${stock.companyName}) - ${stock.reportType} ${stock.windowStart}-${stock.windowEnd} | MCap: $${(stock.marketCap / 1e9).toFixed(2)}B`
//         );
//       });
//     }

//     // שמירה לקובץ נפרד של מניות שמדווחות היום
//     const stocksReportingFile = {
//       date: todayStr,
//       lastUpdated: new Date().toISOString(),
//       count: morningData.stocks.length,
//       stocks: morningData.stocks,
//     };

//     saveFile("stocksReportingToday.json", stocksReportingFile);
//     logger.info(`\n✅ Saved to stocksReportingToday.json`);
//     logger.info(`${"═".repeat(60)}\n`);

//     return morningData.stocks;
//   } catch (error: any) {
//     logger.error(`❌ Morning Intelligence failed: ${error.message}`);
//     throw error;
//   }
// };

// // ============================================
// // 2. CHECK AND PROCESS - בודק ומעבד מניות
// // ============================================
// const runCheckAndProcess = async () => {
//   const todayStr = new Date().toISOString().slice(0, 10);

//   logger.info("\n🔄 Running periodic earnings check...");
//   logger.info(`📅 Checking for: ${todayStr}\n`);

//   // טען את רשימת המניות שמדווחות היום
//   const stocksReportingData = readFile("stocksReportingToday.json") as any;

//   if (!stocksReportingData || stocksReportingData.date !== todayStr) {
//     logger.info(`⚠️ No stocks reporting data for today. Run morning intelligence first.`);
//     return;
//   }

//   const stocksReporting = stocksReportingData.stocks || [];

//   if (stocksReporting.length === 0) {
//     logger.info(`📭 No stocks scheduled to report today.`);
//     return;
//   }

//   logger.info(`📊 Total stocks reporting today: ${stocksReporting.length}`);

//   // טען tracking של מניות שכבר נשלחו
//   const sentReports = readFile("previouslySentReports.json") as any;

//   // ניקוי: שמור רק 7 ימים אחרונים
//   const cutoffDate = new Date();
//   cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
//   const cutoffStr = cutoffDate.toISOString().slice(0, 10);

//   const cleanedSentReports: any = {};
//   for (const [date, data] of Object.entries(sentReports)) {
//     if (date >= cutoffStr) {
//       cleanedSentReports[date] = data;
//     }
//   }

//   // וודא שהתאריך של היום קיים
//   if (!cleanedSentReports[todayStr]) {
//     cleanedSentReports[todayStr] = {};
//   }

//   let processedCount = 0;
//   let skippedCount = 0;
//   let pendingCount = 0;
//   let errorCount = 0;

//   // לולאה על כל מניה שמדווחת היום
//   for (const stock of stocksReporting) {
//     const symbol = stock.symbol;

//     // בדיקה: האם כבר נשלחה לטלגרם?
//     if (cleanedSentReports[todayStr][symbol]?.sent === true) {
//       logger.info(`✅ ${symbol} - Already sent to Telegram, skipping...`);
//       skippedCount++;
//       continue;
//     }

//     logger.info(`\n${"─".repeat(50)}`);
//     logger.info(`🔍 Checking: ${symbol} (${stock.companyName})`);
//     logger.info(`${"─".repeat(50)}`);

//     try {
//       // 🔹 מיני-צ'ק: האם הדוח כבר פורסם?
//       const miniCheckResult = await miniCheck(symbol, stock.companyName);

//       if (miniCheckResult.result === "YES") {
//         logger.info(`✅ ${symbol} - Report published! Processing...`);

//         // 🔹 עיבוד מלא: משיכת דוח + ניתוח + שליחה לטלגרם
//         await mainFlow(symbol);

//         // ✅ רק אחרי שליחה מוצלחת - סמן כנשלח
//         cleanedSentReports[todayStr][symbol] = {
//           sent: true,
//           timestamp: new Date().toISOString(),
//           companyName: stock.companyName,
//         };
//         saveFile("previouslySentReports.json", cleanedSentReports);

//         processedCount++;
//         logger.info(`✅ ${symbol} - Successfully processed and sent to Telegram`);
//       } else if (miniCheckResult.result === "NO") {
//         logger.info(`⏳ ${symbol} - Report not published yet, will check again later`);
//         pendingCount++;
//       } else {
//         logger.info(`❓ ${symbol} - Status unclear, will check again later`);
//         pendingCount++;
//       }
//     } catch (error: any) {
//       errorCount++;
//       logger.error(`❌ Error processing ${symbol}:`);
//       logger.error(`   Message: ${error.message}`);

//       // סמן כשגיאה (כדי שננסה שוב בסיבוב הבא)
//       cleanedSentReports[todayStr][symbol] = {
//         sent: false,
//         error: error.message,
//         timestamp: new Date().toISOString(),
//       };
//       saveFile("previouslySentReports.json", cleanedSentReports);
//     }

//     // המתנה קצרה בין מניות (למנוע rate limits)
//     await new Promise((resolve) => setTimeout(resolve, 2000));
//   }

//   // סיכום
//   logger.info(`\n${"═".repeat(60)}`);
//   logger.info(`✅ CHECK COMPLETED FOR ${todayStr}`);
//   logger.info(`${"═".repeat(60)}`);
//   logger.info(`   ✅ Successfully Sent: ${processedCount}`);
//   logger.info(`   ✅ Already Sent: ${skippedCount}`);
//   logger.info(`   ⏳ Pending: ${pendingCount}`);
//   logger.info(`   ❌ Errors: ${errorCount}`);
//   logger.info(`   📊 Total: ${stocksReporting.length}`);
//   logger.info(`${"═".repeat(60)}\n`);
// };

// // ============================================
// // 3. REFRESH US STOCKS CACHE
// // ============================================
// const refreshUSStocksCache = async () => {
//   logger.info("\n🔄 Checking if US stocks cache needs refresh...");
//   await ensureCacheIsUpdated();
// };

// // ============================================
// // 4. STARTUP & SCHEDULING
// // ============================================

// // הרצה מיידית בהפעלה
// (async () => {
//   try {
//     // 1. רענן cache של מניות אמריקאיות
//     await refreshUSStocksCache();

//     // 2. בדוק אם צריך להריץ Morning Intelligence
//     const todayStr = new Date().toISOString().slice(0, 10);
//     let needsMorningIntelligence = false;

//     try {
//       const stocksReportingData = readFile("stocksReportingToday.json") as any;

//       // אם הקובץ לא קיים או שהוא מתאריך אחר - צריך לרוץ שוב
//       if (!stocksReportingData || stocksReportingData.date !== todayStr) {
//         needsMorningIntelligence = true;
//         logger.info(`ℹ️  Stock list for ${todayStr} not found. Running Morning Intelligence...`);
//       }
//     } catch (error) {
//       // אם הקובץ לא קיים בכלל
//       needsMorningIntelligence = true;
//       logger.info(`ℹ️  stocksReportingToday.json not found. Running Morning Intelligence...`);
//     }

//     // הרץ Morning Intelligence אם צריך (או אם זה בוקר)
//     const currentHour = new Date().getHours();
//     if (needsMorningIntelligence || (currentHour >= 6 && currentHour < 10)) {
//       await runMorningIntelligence();
//     }

//     // 3. בדוק אם יש מניות לעבד
//     await runCheckAndProcess();
//   } catch (error) {
//     logger.error("Error in initial run:", error);
//   }
// })();

// // ============================================
// // CRON SCHEDULES
// // ============================================

// // 🔹 Schedule: כל יום ב-6:00 בבוקר - Morning Intelligence
// cron.schedule("0 6 * * *", async () => {
//   logger.info("\n⏰ Scheduled task: Morning Intelligence (6:00 AM)");
//   try {
//     await runMorningIntelligence();
//   } catch (error) {
//     logger.error("Error in morning intelligence:", error);
//   }
// });

// // 🔹 Schedule: כל 30 דקות בין 9:00-17:00 - בדיקת דוחות
// cron.schedule("*/30 9-17 * * *", async () => {
//   logger.info("\n⏰ Scheduled task: Check and Process (every 30 min during market hours)");
//   try {
//     await runCheckAndProcess();
//   } catch (error) {
//     logger.error("Error in check and process:", error);
//   }
// });

// // 🔹 Schedule: כל יום ב-3:00 בבוקר - רענון cache
// cron.schedule("0 3 * * *", async () => {
//   logger.info("\n⏰ Scheduled task: Refresh US stocks cache (3:00 AM)");
//   try {
//     await refreshUSStocksCache();
//   } catch (error) {
//     logger.error("Error in cache refresh:", error);
//   }
// });

// // ============================================
// // EXPRESS SERVER SETUP
// // ============================================

// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));
// app.use(requestLogger);
// app.use("/api/healthCheck", healthCheckRoutes);
// app.use("/api/main", mainRoutes);
// app.use(errorHandler);

// export default app;
import express from "express";
import dotenv from "dotenv";
import mainRoutes from "./routes/mainRoutes";
import healthCheckRoutes from "./routes/healthCheckRoutes";
import { errorHandler, requestLogger } from "./middleware/errorHandler"; // הוספתי requestLogger כי הוא היה בקוד שלך
import logger from "./utils/logger";
import cron from "node-cron";
// ✅ השינוי החשוב: ייבוא הקונטרולר החכם
import { runDailyCheck } from "./controllers/mainController"; 
import { ensureCacheIsUpdated } from "./utils/usStocksCache";

dotenv.config({ quiet: true });

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Routes
app.use("/api/main", mainRoutes);
app.use("/api/healthCheck", healthCheckRoutes);

// Error Handling
app.use(errorHandler);

// ============================================================================
// 🕒 CRON SCHEDULING (המוח החדש)
// ============================================================================

// אתחול ראשוני בהרצת השרת
(async () => {
  try {
    logger.info("🚀 Server starting... Initializing caches.");
    await ensureCacheIsUpdated();
    
    // בדיקה ראשונית בהפעלה - המנוע החכם יחליט אם לרוץ או לחכות
    logger.info("🔄 Triggering initial daily check...");
    await runDailyCheck();
  } catch (error) {
    logger.error("❌ Error in initial run:", error);
  }
})();

// 1. Morning Intelligence (איסוף מניות בבוקר)
// רץ כל יום ב-06:00 בבוקר
cron.schedule("0 6 * * *", async () => {
  logger.info("⏰ CRON: Triggering Morning Intelligence...");
  try {
    await runDailyCheck(); 
  } catch (error) {
    logger.error("❌ CRON Error (Morning Intelligence):", error);
  }
});

// 2. Periodic Checks (וידוא שהמעבד רץ)
// רץ כל 30 דקות בשעות המסחר כדי לוודא שה-StockProcessor פעיל
cron.schedule("*/30 9-23 * * *", async () => {
    logger.info("⏰ CRON: Ensuring Stock Processor is running...");
    await runDailyCheck();
});

// 3. Cache Refresh
cron.schedule("0 3 * * *", async () => {
  logger.info("\n⏰ Scheduled task: Refresh US stocks cache (3:00 AM)");
  await ensureCacheIsUpdated();
});

logger.info("✅ Scheduler initialized (Connected to Smart StockProcessor)");

export default app;