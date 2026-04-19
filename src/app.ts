import express from "express";
import dotenv from "dotenv";
import healthCheckRoutes from "./routes/healthCheckRoutes";
import { errorHandler, requestLogger } from "./middleware/errorHandler";
import logger from "./utils/logger";
import cron from "node-cron";
// ✅ ייבוא גם של activeProcessor
import { runDailyCheck, activeProcessor } from "./controllers/mainController"; 
import { ensureCacheIsUpdated } from "./utils/usStocksCache";

dotenv.config({ quiet: true });

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Routes
app.use("/api/healthCheck", healthCheckRoutes);

// Error Handling
app.use(errorHandler);

// ============================================================================
// 🕒 CRON SCHEDULING
// ============================================================================

// אתחול ראשוני בהרצת השרת
(async () => {
  try {
    logger.info("🚀 Server starting... Initializing caches.");
    await ensureCacheIsUpdated();
    logger.info("🔄 Triggering initial daily check...");
    await runDailyCheck();
  } catch (error) {
    logger.error("❌ Error in initial run:", error);
  }
})();

// 1. Morning Intelligence - כל יום ב-06:00
cron.schedule("0 6 * * *", async () => {
  logger.info("⏰ CRON: Morning Intelligence (6:00 AM)");
  try {
    await runDailyCheck(); 
  } catch (error) {
    logger.error("❌ CRON Error:", error);
  }
});

// 2. Safety Net - וידוא שהמעבד רץ (כל 30 דקות)
cron.schedule("*/30 9-23 * * *", async () => {
    logger.info("⏰ CRON: Checking processor health...");
    
    // ✅ בדיקה: האם יש מעבד פעיל?
    if (!activeProcessor) {
        logger.warn("⚠️ No active processor found - restarting...");
        try {
            await runDailyCheck();
        } catch (error) {
            logger.error("❌ Failed to restart processor:", error);
        }
    } else {
        logger.info("✅ Processor is active");
    }
});

// 3. Cache Refresh - כל יום ב-03:00
cron.schedule("0 3 * * *", async () => {
  logger.info("⏰ CRON: Refresh US stocks cache (3:00 AM)");
  await ensureCacheIsUpdated();
});

logger.info("✅ Scheduler initialized with safety net");

export default app;