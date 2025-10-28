import logger from "../utils/logger";
import {
  getCashFlow,
  getEarnings,
  getQuote,
  getIncomeStatement, // 🆕
  getAnalystEstimates, // 🆕
  getSocialSentiment, // 🆕
} from "../services/stockService";
import { percentageChange } from "../utils/percentageChange";

export const getFmgData = async (symbol: string): Promise<any> => {
  // 🔹 שלב 1: שליפת נתוני שוק (Market Cap, Volume, Price)
  const quote = await getQuote(symbol);

  if (!quote) {
    logger.error(`No quote data available for ${symbol}`);
    return null;
  }

  // 🔹 שלב 2: בדיקת תנאי סף - Market Cap ≥ 300M$
  const MIN_MARKET_CAP = 300_000_000;
  if (quote.marketCap < MIN_MARKET_CAP) {
    logger.info(
      `❌ ${symbol} - Market Cap too small: $${(
        quote.marketCap / 1_000_000
      ).toFixed(0)}M (Required: $300M+)`
    );
    return null;
  }

  // 🔹 שלב 3: בדיקת תנאי סף - Volume ≥ 5M
  const MIN_AVG_VOLUME = 5_000_000;
  if (quote.avgVolume < MIN_AVG_VOLUME) {
    logger.info(
      `❌ ${symbol} - Volume too low: ${(quote.avgVolume / 1_000_000).toFixed(
        1
      )}M shares (Required: 5M+)`
    );
    return null;
  }

  logger.info(
    `✅ ${symbol} PASSED filters - Market Cap: $${(
      quote.marketCap / 1_000_000_000
    ).toFixed(1)}B, Volume: ${(quote.avgVolume / 1_000_000).toFixed(1)}M`
  );

  // 🔹 שלב 4: שליפת דוחות רווח (הקוד הקיים)
  const getEarningsRes = await getEarnings(symbol);

  if (!getEarningsRes) {
    logger.error("There is no fmg response");
    return null;
  }

  const currentReportIndex = getEarningsRes.findIndex(
    (report) => report.epsActual && report.revenueActual
  );

  if (currentReportIndex === -1) {
    logger.error(`No valid earnings report found for ${symbol}`);
    return null;
  }

  const currentReport = getEarningsRes[currentReportIndex];
  const lastFiveReports = getEarningsRes.slice(
    currentReportIndex,
    currentReportIndex + 5
  );
  const lastYearReport = lastFiveReports[lastFiveReports.length - 1];

  // 🔥 FIX: בדיקת null/0 לפני חישוב YoY
  const yoyRevenueChange = 
    lastYearReport && 
    lastYearReport.revenueActual !== null && 
    lastYearReport.revenueActual !== undefined &&
    lastYearReport.revenueActual !== 0
      ? percentageChange(currentReport.revenueActual, lastYearReport.revenueActual)
      : null;
      
  const yoyEpsChange = 
    lastYearReport && 
    lastYearReport.epsActual !== null && 
    lastYearReport.epsActual !== undefined &&
    lastYearReport.epsActual !== 0
      ? percentageChange(currentReport.epsActual, lastYearReport.epsActual)
      : null;

  // 🔹 שלב 5: שליפת תזרים מזומנים (הקוד הקיים) - 🔥 FIXED
  const cashFlowStatementRes = await getCashFlow(symbol);
  
  if (!cashFlowStatementRes || cashFlowStatementRes.length < 5) {
    logger.error(`Not enough cash flow data for ${symbol}`);
    return null;
  }
  
  const lastFiveReportsCashFlow = cashFlowStatementRes.slice(0, 5);
  const currentFreeCashFlow = lastFiveReportsCashFlow[0]?.freeCashFlow;
  const lastYearFreeCashFlow = lastFiveReportsCashFlow[lastFiveReportsCashFlow.length - 1]?.freeCashFlow;
  
  // 🔥 FIX: בדיקת null/0 לפני חישוב FCF YoY
  const yoyFreeCashFlowChange = 
    currentFreeCashFlow !== null && 
    currentFreeCashFlow !== undefined &&
    lastYearFreeCashFlow !== null && 
    lastYearFreeCashFlow !== undefined &&
    lastYearFreeCashFlow !== 0
      ? percentageChange(currentFreeCashFlow, lastYearFreeCashFlow)
      : null;

  // 🆕 שלב 6: שליפת Income Statement (Margins) - 🔥 FIXED VERSION
  const incomeStatements = await getIncomeStatement(symbol);
  let marginData: any = {
    grossMargin: null,
    operatingMargin: null,
    netMargin: null,
    marginChange: null,
    marginTrend: "unknown",
  };

  if (incomeStatements && incomeStatements.length >= 2) {
    const latest = incomeStatements[0];
    const previous = incomeStatements[1];

    marginData = {
      // 🔥 FIX: בדיקה נכונה של null/undefined (מאפשרת 0!)
      grossMargin: 
        latest.grossProfitRatio !== null && latest.grossProfitRatio !== undefined
          ? (latest.grossProfitRatio * 100).toFixed(2)
          : null,
      operatingMargin: 
        latest.operatingIncomeRatio !== null && latest.operatingIncomeRatio !== undefined
          ? (latest.operatingIncomeRatio * 100).toFixed(2)
          : null,
      netMargin: 
        latest.netIncomeRatio !== null && latest.netIncomeRatio !== undefined
          ? (latest.netIncomeRatio * 100).toFixed(2)
          : null,
      // חישוב שינוי ב-Net Margin
      marginChange: 
        latest.netIncomeRatio !== null && 
        latest.netIncomeRatio !== undefined &&
        previous.netIncomeRatio !== null && 
        previous.netIncomeRatio !== undefined
          ? ((latest.netIncomeRatio - previous.netIncomeRatio) * 100).toFixed(2)
          : null,
    };

    // קביעת טרנד
    if (marginData.marginChange !== null) {
      const change = parseFloat(marginData.marginChange);
      if (change > 0.5) {
        marginData.marginTrend = "improving"; // ניקוד: +0.25
      } else if (change < -2) {
        marginData.marginTrend = "declining"; // ניקוד: -0.5
      } else {
        marginData.marginTrend = "stable"; // ניקוד: +0.25
      }
    } else {
      // אם אין נתון לחישוב, נשאר "unknown"
      marginData.marginTrend = "unknown"; // ניקוד: 0
    }

    logger.info(
      `📊 ${symbol} Margins - Gross: ${marginData.grossMargin ?? 'N/A'}%, Operating: ${marginData.operatingMargin ?? 'N/A'}%, Net: ${marginData.netMargin ?? 'N/A'}%, Change: ${marginData.marginChange ?? 'N/A'}% (${marginData.marginTrend})`
    );
  } else {
    logger.warn(`⚠️ ${symbol} - No margin data available (less than 2 quarters)`);
  }

  // 🆕 שלב 7: שליפת Analyst Estimates (קירוב ל-Guidance) - 🔥 FIXED VERSION
  const analystEstimates = await getAnalystEstimates(symbol);
  let guidanceData: any = {
    guidance: "unavailable",
    estimatedEpsGrowth: null,
    estimatedRevenueGrowth: null,
    guidanceTrend: "neutral",
  };

  if (analystEstimates && analystEstimates.length >= 2) {
    const current = analystEstimates[0]; // תחזית עתידית
    const previous = analystEstimates[1]; // תחזית קודמת

    // 🔥 FIX: בדיקה נכונה של null/undefined (מאפשרת 0!)
    if (
      current.estimatedEpsAvg !== null && 
      current.estimatedEpsAvg !== undefined && 
      previous.estimatedEpsAvg !== null && 
      previous.estimatedEpsAvg !== undefined
    ) {
      // 🔥 FIX: בדיקת edge case - אם הבסיס הוא 0, לא ניתן לחשב אחוז שינוי
      if (previous.estimatedEpsAvg === 0) {
        logger.warn(
          `⚠️ ${symbol} - Cannot calculate guidance change (previous EPS estimate is 0). Treating as unavailable.`
        );
        guidanceData.guidance = "unavailable";
        guidanceData.guidanceTrend = "neutral";
        guidanceData.estimatedEpsGrowth = null;
      } else {
        const epsGrowth = percentageChange(
          current.estimatedEpsAvg,
          previous.estimatedEpsAvg
        );
        guidanceData.estimatedEpsGrowth = epsGrowth;

        if (epsGrowth > 3) {
          guidanceData.guidanceTrend = "raised"; // ניקוד: +1
          guidanceData.guidance = "raised";
        } else if (epsGrowth < -3) {
          guidanceData.guidanceTrend = "lowered"; // ניקוד: -1.5
          guidanceData.guidance = "lowered";
        } else {
          guidanceData.guidanceTrend = "maintained"; // ניקוד: +1 (יציב = טוב)
          guidanceData.guidance = "maintained";
        }
      }
    } else {
      // אחד מהנתונים חסר (null/undefined)
      logger.warn(
        `⚠️ ${symbol} - Analyst estimates are incomplete (current: ${current.estimatedEpsAvg}, previous: ${previous.estimatedEpsAvg})`
      );
    }

    logger.info(
      `🔮 ${symbol} Guidance (via Analyst Estimates) - ${guidanceData.guidance}, EPS Growth: ${guidanceData.estimatedEpsGrowth !== null ? guidanceData.estimatedEpsGrowth + '%' : 'N/A'}`
    );
  } else {
    logger.warn(`⚠️ ${symbol} - No analyst estimates available for guidance (need at least 2 quarters)`);
  }

  // 🆕 שלב 8: שליפת Social Sentiment
  const socialSentiment = await getSocialSentiment(symbol);
  let sentimentData: any = {
    sentiment: "neutral",
    sentimentScore: 0,
    stocktwitsPosts: 0,
    sentimentTrend: "neutral",
  };

  if (socialSentiment && socialSentiment.length > 0) {
    // חישוב ממוצע sentiment מ-5 הפוסטים האחרונים
    // 🔥 FIX: post.sentiment || 0 מטפל נכון גם ב-0 וגם ב-null
    const avgSentiment =
      socialSentiment.reduce(
        (sum: number, post: any) => sum + (post.sentiment ?? 0),
        0
      ) / socialSentiment.length;

    sentimentData = {
      sentiment: avgSentiment > 0.1 ? "positive" : avgSentiment < -0.1 ? "negative" : "neutral",
      sentimentScore: avgSentiment.toFixed(3),
      stocktwitsPosts: socialSentiment[0].stocktwitsPosts || 0,
      sentimentTrend:
        avgSentiment > 0.1
          ? "positive" // ניקוד: +0.5
          : avgSentiment < -0.1
          ? "negative" // ניקוד: -1
          : "neutral", // ניקוד: +0.5
    };

    logger.info(
      `💭 ${symbol} Sentiment - ${sentimentData.sentiment} (${sentimentData.sentimentScore}), Posts: ${sentimentData.stocktwitsPosts}`
    );
  } else {
    logger.warn(`⚠️ ${symbol} - No social sentiment data available`);
  }

  // 🔹 שלב 9: בניית אובייקט הנתונים המלא
  const stockData = {
    symbol: currentReport.symbol,

    // נתוני שוק מ-quote
    currentPrice: quote.price,
    marketCap: quote.marketCap,
    avgVolume: quote.avgVolume,
    companyName: quote.name,

    // נתוני EPS
    lastEpsActual: currentReport.epsActual,
    lastEpsEstimated: currentReport.epsEstimated,
    lastEpsChangePercent: percentageChange(
      currentReport.epsActual,
      currentReport.epsEstimated
    ),
    yoyEpsChange,

    // נתוני הכנסות
    lastRevenueActual: currentReport.revenueActual,
    lastRevenueEstimated: currentReport.revenueEstimated,
    lastRevenueChangePercent: percentageChange(
      currentReport.revenueActual,
      currentReport.revenueEstimated
    ),
    yoyRevenueChange,

    // תזרים מזומנים
    yoyFreeCashFlowChange,
    currentFreeCashFlow,

    // 🆕 3 הפרמטרים החדשים (FIXED!)
    margins: marginData,
    guidance: guidanceData,
    sentiment: sentimentData,

    // נתונים היסטוריים
    earningsReports: lastFiveReports,
    cashFlowActivities: lastFiveReportsCashFlow,
  };

  logger.info(`✅ Data fetched successfully for: ${symbol} (including Margins, Guidance & Sentiment) - FIXED VERSION`);

  return stockData;
};