import { Request, Response } from "express";
import { morningIntelligence, StockProcessor } from "../services/openRouterService";
import {  sendTelegramMessage } from "../services/telegramService";
import logger from "../utils/logger";
import fs from "fs";
import path from "path";
import { stockLog } from "../utils/structureLogger";

// משתנה גלובלי למעבד - כדי שלא יעלם בסיום הבקשה
export let activeProcessor: StockProcessor | null = null;

export const runDailyCheck = async (req?: Request, res?: Response) => {
  try {


    const d = new Date();
    d.setDate(d.getDate());
    const today = d.toISOString().split("T")[0];
    const filePath = path.join(__dirname, "../data/stocksReportingToday.json");

    logger.info(`🚀 Starting Daily Check Process for ${today}`);

    // 1. שלב ראשון: הבאת נתונים מפינהאב + FMP
    const intelligenceData = await morningIntelligence(today);

    // ✅ Initialize all stocks with sentToTelegram: false
    intelligenceData.stocks = intelligenceData.stocks.map(stock => ({
      ...stock,
      sentToTelegram: false
    }));

    // ✅ Try to load existing state (to restore sentToTelegram flags for already-sent stocks)
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const existingData = JSON.parse(fileContent);

        // Check if it's from today
        if (existingData.date === today) {
          logger.info(`📂 Found existing state file from ${today} - restoring sentToTelegram flags`);

          // Restore sentToTelegram=true for stocks that were already sent
          intelligenceData.stocks = intelligenceData.stocks.map(stock => {
            const existingStock = existingData.stocks?.find((s: any) => s.symbol === stock.symbol);
            return {
              ...stock,
              sentToTelegram: existingStock?.sentToTelegram || false
            };
          });

          logger.info(`✅ Restored state for ${intelligenceData.stocks.filter((s: any) => s.sentToTelegram).length} stocks already sent`);
        } else {
          logger.info(`📂 Found old state file (${existingData.date}) - starting fresh`);
        }
      } catch (e: any) {
        logger.warn(`⚠️ Failed to load existing state: ${e.message}`);
      }
    }

    // שמירה לקובץ (initial save)
    fs.writeFileSync(filePath, JSON.stringify(intelligenceData, null, 2));
    logger.info(`💾 Saved initial state to ${filePath}`);

    if (intelligenceData.stocks.length === 0) {
      logger.info("😴 No stocks to check today.");
      if (res) return res.status(200).json({ message: "No stocks today" });
      return;
    }

    // 2. שלב שני: הפעלת המעבד החכם
    
    // אם כבר יש מעבד רץ, נעצור אותו
    if (activeProcessor) {
        logger.info("🔄 Stopping previous processor instance...");
        activeProcessor.stop();
    }

    // יצירת אינסטנס חדש
    activeProcessor = new StockProcessor(async (completedStock) => {
        // Callback: יופעל רק כשהמניה סיימה בהצלחה ויש לה אנליזה
        if (completedStock.analysis) {
            // ✅ Check if already sent (prevent duplicates)
            if (completedStock.sentToTelegram) {
                logger.info(`⏭️ ${completedStock.symbol} already sent to Telegram - skipping`);
                return;
            }

            logger.info(`📤 Sending Telegram report for ${completedStock.symbol}...`);
            try {
                await sendTelegramMessage(completedStock.analysis);
                // ✅ Mark as sent after successful delivery
                completedStock.sentToTelegram = true;
                stockLog.sent(completedStock.symbol);
                logger.info(`✅ ${completedStock.symbol} marked as sent to Telegram`);

                // ✅ SAVE STATE: Update JSON file with new sentToTelegram status
                try {
                  // Read current state
                  const currentState = JSON.parse(fs.readFileSync(filePath, "utf-8"));

                  // Update the stock in the state
                  const stockIndex = currentState.stocks.findIndex((s: any) => s.symbol === completedStock.symbol);
                  if (stockIndex !== -1) {
                    currentState.stocks[stockIndex].sentToTelegram = true;
                  }

                  // Save updated state
                  fs.writeFileSync(filePath, JSON.stringify(currentState, null, 2));
                  logger.info(`💾 Updated state file: ${completedStock.symbol} marked as sent`);
                } catch (saveError: any) {
                  logger.error(`❌ Failed to save state for ${completedStock.symbol}: ${saveError.message}`);
                }

            } catch (err) {
                logger.error(`❌ Failed to send Telegram for ${completedStock.symbol}`, err);
                // ⚠️ Don't mark as sent if delivery failed
            }
        }
    });

    // טעינת המניות והתנעה
    activeProcessor.initialize(intelligenceData);
    activeProcessor.start(); // <-- זה מפעיל את ה-Interval החכם

    logger.info("✅ Smart Processor started successfully.");

    if (res) {
      res.status(200).json({
        message: "Stock Processor Started",
        mode: "Smart Scheduling (NY Time)",
        stocks: intelligenceData.stocks.map(s => ({
            symbol: s.symbol,
            window: `${s.windowStart} - ${s.windowEnd} NY Time`
        }))
      });
    }

  } catch (error: any) {
    logger.error("❌ Error in runDailyCheck:", error);
    if (res) res.status(500).json({ error: error.message });
  }
};
