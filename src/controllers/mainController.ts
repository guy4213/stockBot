import { getFmgData } from "../controllers/fmgController";
import { generateText } from "../services/openaiService";
import { sendEmail } from "../services/emailService";
import { sendTelegramMessage } from "../services/telegramService";
import logger from "../utils/logger";

const aiAnalysisEnabled = true;
const sendIsEnabled = true;

const count = (stockData: any) => {
  let count = 0;
  if (stockData.lastEpsChangePercent >= 5) count++;
  if (stockData.lastRevenueChangePercent >= 3) count++;
  if (stockData.yoyEpsChange >= 10) count++;
 if (stockData.yoyRevenueChange > 15) count++; // תוקן מ-10 ל-15
  if (stockData.yoyFreeCashFlowChange > 0) count++;
  return count >= 3;
};


const calculateTradeParams = (currentPrice: number, reportStatus: string) => {
  if (reportStatus.includes("חיובי")) {
    // LONG
    return {
      direction: "LONG 🟢",
      entry: `$${(currentPrice * 0.98).toFixed(2)}`, // -2%
      targetFirst: `$${(currentPrice * 1.05).toFixed(2)}`, // +5%
      targetSecond: `$${(currentPrice * 1.15).toFixed(2)}`, // +15%
      stop: `$${(currentPrice * 0.95).toFixed(2)}`, // -5%
      riskReward: "1:3",
    };
  } else if (reportStatus === "שלילי") {
    // SHORT
    return {
      direction: "SHORT 🔴",
      entry: `$${(currentPrice * 1.02).toFixed(2)}`, // +2%
      targetFirst: `$${(currentPrice * 0.95).toFixed(2)}`, // -5%
      targetSecond: `$${(currentPrice * 0.85).toFixed(2)}`, // -15%
      stop: `$${(currentPrice * 1.05).toFixed(2)}`, // +5%
      riskReward: "1:3",
    };
  }
  return null;
};

export const mainFlow = async (symbol: string) => {
  // get info from fmg
  const stockData = await getFmgData(symbol);
  let reportStatus = "ניטרלי";
  if (stockData) {
    if (
      stockData.lastEpsChangePercent >= 10 &&
      stockData.lastRevenueChangePercent >= 5 &&
      stockData.yoyEpsChange >= 20 &&
      stockData.yoyRevenueChange > 15 &&
      stockData.yoyFreeCashFlowChange > 0
    ) {
      reportStatus = "חיובי מאוד מאוד ";
    } else if (count(stockData)) {
      reportStatus = "חיובי מאוד";
    } else if (
      stockData.lastEpsChangePercent <= -10 ||
      stockData.lastRevenueChangePercent <= -5 ||
      stockData.yoyEpsChange <= 0 ||
      stockData.yoyRevenueChange <= 0 ||
      stockData.yoyFreeCashFlowChange <= 0
    ) {
      reportStatus = "שלילי";
    }
    stockData.reportStatus = reportStatus;
    if (!stockData.currentPrice || !stockData.marketCap) {
  logger.info(`Skipping ${symbol} - missing market data after filtering`);
          return;
        }

    if (stockData.reportStatus !== "ניטרלי") {
    
    // 🆕 חישוב פרמטרי מסחר (Entry, Target, Stop)
    const tradeParams = calculateTradeParams(stockData.currentPrice, reportStatus);
    
    if (tradeParams) {
      stockData.tradeParams = tradeParams;
      
      // 🆕 הדפסת פרטי המסחר ללוג
      logger.info(
        `\n📊 ${symbol} - ${reportStatus}\n` +
        `   💰 Current Price: $${stockData.currentPrice}\n` +
        `   ${tradeParams.direction}\n` +
        `   📍 Entry: ${tradeParams.entry}\n` +
        `   🎯 Target 1: ${tradeParams.targetFirst}\n` +
        `   🎯 Target 2: ${tradeParams.targetSecond}\n` +
        `   🛑 Stop Loss: ${tradeParams.stop}\n` +
        `   ⚖️  Risk:Reward = ${tradeParams.riskReward}`
      );
    }

    // send to AI for analysis
    if (aiAnalysisEnabled) {
      const aiSummery = await generateText(stockData);
      stockData.aiSummery = aiSummery;
    }
    
    // send email/telegram if needed
    if (sendIsEnabled) {
      await sendEmail(stockData);
      await sendTelegramMessage(stockData);
    }
    
  } else {
    logger.info(
      `${symbol} - Neutral report, no notification sent`
    );
  }
};
}