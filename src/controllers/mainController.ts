import { Request, Response } from "express";
import { morningIntelligence, StockProcessor } from "../services/openRouterService";
import { sendTelegramMessage } from "../services/telegramService";
import logger from "../utils/logger";
import fs from "fs/promises";
import path from "path";
import { stockLog } from "../utils/structureLogger";

export let activeProcessor: StockProcessor | null = null;

export const runDailyCheck = async (req?: Request, res?: Response) => {
  try {
    const yesterday = new Date();

    const today1 = new Date();
    const filePath = path.join(__dirname, "../data/stocksReportingToday.json");
    yesterday.setDate(today1.getDate() - 1);

    const today = yesterday.toISOString().split("T")[0];

    logger.info(`🚀 Starting Daily Check Process for ${today}`);

    const intelligenceData = await morningIntelligence(today);

    intelligenceData.stocks = intelligenceData.stocks.map(stock => ({
      ...stock,
      sentToTelegram: false
    }));

    // Restore sentToTelegram flags from existing state file if it's from today
    try {
      const fileContent = await fs.readFile(filePath, "utf-8");
      const existingData = JSON.parse(fileContent);

      if (existingData.date === today) {
        logger.info(`📂 Found existing state file from ${today} - restoring sentToTelegram flags`);

        intelligenceData.stocks = intelligenceData.stocks.map(stock => {
          const existingStock = existingData.stocks?.find((s: any) => s.symbol === stock.symbol);
          return {
            ...stock,
            cachedIRPortal: existingStock?.cachedIRPortal || null,
            sentToTelegram: existingStock?.sentToTelegram || false
          };
        });

        logger.info(`✅ Restored state for ${intelligenceData.stocks.filter((s: any) => s.sentToTelegram).length} stocks already sent`);
      } else {
        logger.info(`📂 Found old state file (${existingData.date}) - starting fresh`);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        logger.warn(`⚠️ Failed to load existing state: ${e.message}`);
      }
    }

    await fs.writeFile(filePath, JSON.stringify(intelligenceData, null, 2));
    logger.info(`💾 Saved initial state to ${filePath}`);

    if (intelligenceData.stocks.length === 0) {
      logger.info("😴 No stocks to check today.");
      if (res) return res.status(200).json({ message: "No stocks today" });
      return;
    }

    if (activeProcessor) {
      logger.info("🔄 Stopping previous processor instance...");
      activeProcessor.stop();
    }

    activeProcessor = new StockProcessor(async (completedStock) => {
      if (completedStock.analysis) {
        if (completedStock.sentToTelegram) {
          logger.info(`⏭️ ${completedStock.symbol} already sent to Telegram - skipping`);
          return;
        }

        logger.info(`📤 Sending Telegram report for ${completedStock.symbol}...`);
        try {
          await sendTelegramMessage(completedStock.analysis);
          completedStock.sentToTelegram = true;
          stockLog.sent(completedStock.symbol);
          logger.info(`✅ ${completedStock.symbol} marked as sent to Telegram`);

          try {
            const currentState = JSON.parse(await fs.readFile(filePath, "utf-8"));
            const stockIndex = currentState.stocks.findIndex((s: any) => s.symbol === completedStock.symbol);
            if (stockIndex !== -1) {
              currentState.stocks[stockIndex].sentToTelegram = true;
            }
            await fs.writeFile(filePath, JSON.stringify(currentState, null, 2));
            logger.info(`💾 Updated state file: ${completedStock.symbol} marked as sent`);
          } catch (saveError: any) {
            logger.error(`❌ Failed to save state for ${completedStock.symbol}: ${saveError.message}`);
          }

        } catch (err) {
          logger.error(`❌ Failed to send Telegram for ${completedStock.symbol}`, err);
        }
      }
    });

    activeProcessor.initialize(intelligenceData);
    activeProcessor.start();

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
