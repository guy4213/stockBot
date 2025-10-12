import logger from "../utils/logger";
import { getCashFlow, getEarnings,getQuote   } from "../services/stockService";
import { percentageChange } from "../utils/percentageChange";

// export const getFmgData = async (symbol: string): Promise<any> => {
//   const getEarningsRes = await getEarnings(symbol);
  
//   if (!getEarningsRes) {
//     logger.error("There is no fmg response");
//     throw new Error(`No data found for symbol: ${symbol}`);
//   }

//   const currentReportIndex = getEarningsRes.findIndex(
//     (report) => report.epsActual && report.revenueActual
//   );
//   const currentReport = getEarningsRes[currentReportIndex];
//   const lastFiveReports = getEarningsRes.slice(
//     currentReportIndex,
//     currentReportIndex + 5
//   );
//   const lastYearReport = lastFiveReports[lastFiveReports.length - 1];

//   const yoyRevenueChange = percentageChange(
//     currentReport.revenueActual,
//     lastYearReport.revenueActual
//   );
//   const yoyEpsChange = percentageChange(
//     currentReport.epsActual,
//     lastYearReport.epsActual
//   );
//   const cashFlowStatementRes = await getCashFlow(symbol);
//   const lastFiveReportsCashFlow = cashFlowStatementRes.slice(0, 5);
//   const currentFreeCashFlow = lastFiveReportsCashFlow[0].freeCashFlow;
//   const lastYearFreeCashFlow =
//     lastFiveReportsCashFlow[lastFiveReportsCashFlow.length - 1].freeCashFlow;
//   const yoyFreeCashFlowChange = percentageChange(
//     currentFreeCashFlow,
//     lastYearFreeCashFlow
//   );
//   const stockData = {
//     symbol: currentReport.symbol,
//     lastEpsActual: currentReport.epsActual,
//     lastEpsEstimated: currentReport.epsEstimated,
//     lastEpsChangePercent: percentageChange(
//       currentReport.epsActual,
//       currentReport.epsEstimated
//     ),
//     yoyEpsChange,
//     lastRevenueActual: currentReport.revenueActual,
//     lastRevenueEstimated: currentReport.revenueEstimated,
//     lastRevenueChangePercent: percentageChange(
//       currentReport.revenueActual,
//       currentReport.revenueEstimated
//     ),
//     yoyRevenueChange,
//     yoyFreeCashFlowChange,
//     earningsReports: lastFiveReports,
//     cashFlowActivities: lastFiveReportsCashFlow,
//   };

//   logger.info(`Fetched data for symbol: ${symbol}`);

//   return stockData;
// };

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
      `❌ ${symbol} - Market Cap too small: $${(quote.marketCap / 1_000_000).toFixed(0)}M (Required: $300M+)`
    );
    return null;
  }

  // 🔹 שלב 3: בדיקת תנאי סף - Volume ≥ 5M
  const MIN_AVG_VOLUME = 5_000_000;
  if (quote.avgVolume < MIN_AVG_VOLUME) {
    logger.info(
      `❌ ${symbol} - Volume too low: ${(quote.avgVolume / 1_000_000).toFixed(1)}M shares (Required: 5M+)`
    );
    return null;
  }

  logger.info(
    `✅ ${symbol} PASSED filters - Market Cap: $${(quote.marketCap / 1_000_000_000).toFixed(1)}B, Volume: ${(quote.avgVolume / 1_000_000).toFixed(1)}M`
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

  const yoyRevenueChange = percentageChange(
    currentReport.revenueActual,
    lastYearReport.revenueActual
  );
  const yoyEpsChange = percentageChange(
    currentReport.epsActual,
    lastYearReport.epsActual
  );

  // 🔹 שלב 5: שליפת תזרים מזומנים (הקוד הקיים)
  const cashFlowStatementRes = await getCashFlow(symbol);
  const lastFiveReportsCashFlow = cashFlowStatementRes.slice(0, 5);
  const currentFreeCashFlow = lastFiveReportsCashFlow[0].freeCashFlow;
  const lastYearFreeCashFlow =
    lastFiveReportsCashFlow[lastFiveReportsCashFlow.length - 1].freeCashFlow;
  const yoyFreeCashFlowChange = percentageChange(
    currentFreeCashFlow,
    lastYearFreeCashFlow
  );

  // 🔹 שלב 6: בניית אובייקט הנתונים המלא
  const stockData = {
    symbol: currentReport.symbol,

    // 🆕 נתוני שוק מ-quote
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

    // נתונים היסטוריים
    earningsReports: lastFiveReports,
    cashFlowActivities: lastFiveReportsCashFlow,
  };

  logger.info(`✅ Data fetched successfully for: ${symbol}`);

  return stockData;
};