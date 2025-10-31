import { getFmgData } from "../controllers/fmgController";
import { generateText } from "../services/openaiService";
import { sendEmail } from "../services/emailService";
import { sendTelegramMessage } from "../services/telegramService";
import logger from "../utils/logger";

const aiAnalysisEnabled = true;
const sendIsEnabled = true;

export const mainFlow = async (symbol: string) => {
  try {
    // get info from fmg
    const stockData = await getFmgData(symbol);
    let reportStatus = "ניטרלי";
    
    if (stockData) {
      // 🧮 חישוב ניקוד מפורט (BEFORE classification!)
      let totalScore = 0;
      const scoreBreakdown: string[] = [];
      
      // 1. EPS vs Estimate
      const epsChange = stockData.lastEpsChangePercent;
      if (epsChange > 10) { totalScore += 2; scoreBreakdown.push("EPS Beat >10%: +2"); }
      else if (epsChange >= 5) { totalScore += 1.5; scoreBreakdown.push("EPS Beat 5-10%: +1.5"); }
      else if (epsChange >= 3) { totalScore += 1; scoreBreakdown.push("EPS Beat 3-5%: +1"); }
      else if (epsChange >= -3) { totalScore += 0; scoreBreakdown.push("EPS In-line: 0"); }
      else if (epsChange >= -5) { totalScore += -0.5; scoreBreakdown.push("EPS Miss 3-5%: -0.5"); }
      else if (epsChange >= -10) { totalScore += -1; scoreBreakdown.push("EPS Miss 5-10%: -1"); }
      else { totalScore += -1.5; scoreBreakdown.push("EPS Miss >10%: -1.5"); }
      
      // 2. Revenue vs Estimate
      const revChange = stockData.lastRevenueChangePercent;
      if (revChange > 7) { totalScore += 1.5; scoreBreakdown.push("Revenue Beat >7%: +1.5"); }
      else if (revChange >= 3) { totalScore += 1; scoreBreakdown.push("Revenue Beat 3-7%: +1"); }
      else if (revChange >= -3) { totalScore += 0; scoreBreakdown.push("Revenue In-line: 0"); }
      else { totalScore += -1; scoreBreakdown.push("Revenue Miss >3%: -1"); }
      
      // 3. Guidance
      if (stockData.guidance?.guidance === 'raised') { totalScore += 1; scoreBreakdown.push("Guidance Raised: +1"); }
      else if (stockData.guidance?.guidance === 'maintained') { totalScore += 0.5; scoreBreakdown.push("Guidance Maintained: +0.5"); }
      else if (stockData.guidance?.guidance === 'lowered') { totalScore += -1.5; scoreBreakdown.push("Guidance Lowered: -1.5"); }
      else { scoreBreakdown.push("Guidance N/A: 0"); }
      
      // 4. YoY EPS Growth
      if (stockData.yoyEpsChange > 30) { totalScore += 1; scoreBreakdown.push("YoY EPS >30%: +1"); }
      else if (stockData.yoyEpsChange >= 10) { totalScore += 0.5; scoreBreakdown.push("YoY EPS 10-30%: +0.5"); }
      else if (stockData.yoyEpsChange >= -10) { totalScore += 0; scoreBreakdown.push("YoY EPS -10 to +10%: 0"); }
      else { totalScore += -0.5; scoreBreakdown.push("YoY EPS <-10%: -0.5"); }
      
      // 5. YoY Revenue Growth
      if (stockData.yoyRevenueChange > 20) { totalScore += 1; scoreBreakdown.push("YoY Revenue >20%: +1"); }
      else if (stockData.yoyRevenueChange >= 10) { totalScore += 0.5; scoreBreakdown.push("YoY Revenue 10-20%: +0.5"); }
      else if (stockData.yoyRevenueChange >= 0) { totalScore += 0; scoreBreakdown.push("YoY Revenue 0-10%: 0"); }
      else { totalScore += -0.5; scoreBreakdown.push("YoY Revenue <0%: -0.5"); }
      
      // 6. FCF
      if (stockData.yoyFreeCashFlowChange > 0) { totalScore += 0.5; scoreBreakdown.push("FCF Positive & Growing: +0.5"); }
      else if (stockData.yoyFreeCashFlowChange === 0) { totalScore += 0; scoreBreakdown.push("FCF Stable: 0"); }
      else { totalScore += -0.5; scoreBreakdown.push("FCF Negative/Declining: -0.5"); }
      
      // 7. Margins
      if (stockData.margins?.marginTrend === 'improving') { totalScore += 0.5; scoreBreakdown.push("Margins Improving: +0.5"); }
      else if (stockData.margins?.marginTrend === 'stable') { totalScore += 0; scoreBreakdown.push("Margins Stable: 0"); }
      else if (stockData.margins?.marginTrend === 'declining') { totalScore += -0.5; scoreBreakdown.push("Margins Declining: -0.5"); }
      else { scoreBreakdown.push("Margins N/A: 0"); }
      
      // 8. Sentiment
      if (stockData.sentiment?.sentiment === 'positive') { totalScore += 0.5; scoreBreakdown.push("Sentiment Positive: +0.5"); }
      else if (stockData.sentiment?.sentiment === 'neutral') { totalScore += 0; scoreBreakdown.push("Sentiment Neutral: 0"); }
      else if (stockData.sentiment?.sentiment === 'negative') { totalScore += -0.5; scoreBreakdown.push("Sentiment Negative: -0.5"); }
      else { scoreBreakdown.push("Sentiment N/A: 0"); }
      
      // 💾 שמור את הניקוד ב-stockData
      stockData.finalScore = {
        totalScore: totalScore,
        breakdown: scoreBreakdown
      };
      
      // סיווג לפי ניקוד מחושב
      if (totalScore >= 4) {
        reportStatus = "חיובי מאוד מאוד";
      } else if (totalScore >= 2) {
        reportStatus = "חיובי מאוד";
      } else if (totalScore <= -2) {
        reportStatus = "שלילי";
      }
      // בדיקה: אם יש 6+ מדדים שליליים - עבור לשלילי
      let negativeCount = 0;
      if (stockData.lastEpsChangePercent < -3) negativeCount++;
      if (stockData.lastRevenueChangePercent < -3) negativeCount++;
      if (stockData.yoyFreeCashFlowChange < 0) negativeCount++;
      if (stockData.margins?.marginTrend === 'declining') negativeCount++;
      if (stockData.guidance?.guidance === 'lowered') negativeCount++;
      if (stockData.yoyEpsChange < 0) negativeCount++;
      if (stockData.yoyRevenueChange < 0) negativeCount++;
      if (stockData.sentiment?.sentiment === 'negative') negativeCount++;
      
      if (negativeCount >= 6) {
        reportStatus = "שלילי";
        scoreBreakdown.push(`⚠️ Override: ${negativeCount} negative indicators → NEGATIVE`);
      }
      
      stockData.reportStatus = reportStatus;
      
      // הדפסת הניקוד ללוג
      logger.info(`\n🧮 Score Calculation for ${symbol}:`);
      scoreBreakdown.forEach(s => logger.info(`   ${s}`));
      logger.info(`   ───────────────────────────────`);
      logger.info(`   ⚖️ Total Score: ${totalScore.toFixed(2)}`);
      logger.info(`   🏁 Classification: ${reportStatus}\n`);
      
      if (!stockData.currentPrice || !stockData.marketCap) {
        logger.info(`Skipping ${symbol} - missing market data after filtering`);
        return;
      }

      if (stockData.reportStatus !== "ניטרלי") {
        // 🆕 חישוב פרמטרי מסחר
        const tradeParams = calculateTradeParams(stockData.currentPrice, reportStatus);
        
        if (tradeParams) {
          stockData.tradeParams = tradeParams;
          
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
          try {
            const aiSummery = await generateText(stockData);
            stockData.aiSummery = aiSummery;
            logger.info(`✅ AI summary generated for ${symbol}`);
          } catch (error) {
            logger.error(`❌ Failed to generate AI summary for ${symbol}:`, error);
            stockData.aiSummery = "AI analysis unavailable";
          }
        }
        
        // send email/telegram if needed
        if (sendIsEnabled) {
          try {
            await sendEmail(stockData);
            logger.info(`✅ Email sent successfully for ${symbol}`);
          } catch (error) {
            logger.error(`❌ Failed to send email for ${symbol}:`, error);
          }
          
          try {
            await sendTelegramMessage(stockData);
            logger.info(`✅ Telegram message sent successfully for ${symbol}`);
          } catch (error) {
            logger.error(`❌ Failed to send Telegram message for ${symbol}:`, error);
          }
        }
      } else {
        logger.info(`${symbol} - Neutral report, no notification sent`);
      }
    }
  } catch (error) {
    logger.error(`❌ Error in mainFlow for ${symbol}:`, error);
  }
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