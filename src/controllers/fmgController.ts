import logger from "../utils/logger";
import { getCashFlow, getEarnings } from "../services/stockService";
import { percentageChange } from "../utils/percentageChange";

export const getFmgData = async (symbol: string): Promise<any> => {
  const getEarningsRes = await getEarnings(symbol);

  if (!getEarningsRes) {
    logger.error("There is no fmg response");
    throw new Error(`No data found for symbol: ${symbol}`);
  }

  const currentReportIndex = getEarningsRes.findIndex(
    (report) => report.epsActual && report.revenueActual
  );
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
  const cashFlowStatementRes = await getCashFlow(symbol);
  const lastFiveReportsCashFlow = cashFlowStatementRes.slice(0, 5);
  const currentFreeCashFlow = lastFiveReportsCashFlow[0].freeCashFlow;
  const lastYearFreeCashFlow =
    lastFiveReportsCashFlow[lastFiveReportsCashFlow.length - 1].freeCashFlow;
  const yoyFreeCashFlowChange = percentageChange(
    currentFreeCashFlow,
    lastYearFreeCashFlow
  );
  const stockData = {
    symbol: currentReport.symbol,
    lastEpsActual: currentReport.epsActual,
    lastEpsEstimated: currentReport.epsEstimated,
    lastEpsChangePercent: percentageChange(
      currentReport.epsActual,
      currentReport.epsEstimated
    ),
    yoyEpsChange,
    lastRevenueActual: currentReport.revenueActual,
    lastRevenueEstimated: currentReport.revenueEstimated,
    lastRevenueChangePercent: percentageChange(
      currentReport.revenueActual,
      currentReport.revenueEstimated
    ),
    yoyRevenueChange,
    yoyFreeCashFlowChange,
    earningsReports: lastFiveReports,
    cashFlowActivities: lastFiveReportsCashFlow,
  };

  logger.info(`Fetched data for symbol: ${symbol}`);

  return stockData;
};
