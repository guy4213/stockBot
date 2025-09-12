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
  if (stockData.yoyRevenueChange > 10) count++;
  if (stockData.yoyFreeCashFlowChange > 0) count++;
  return count >= 3;
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
    if (stockData.reportStatus !== "ניטרלי") {
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
    }
  } else {
    logger.info(
      `Skipping notification for stock: ${symbol} because did not met criteria`
    );
  }
};
