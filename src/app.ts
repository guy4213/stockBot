import express from "express";
import cron from "node-cron";

import healthCheckRoutes from "./routes/healthCheckRoutes";
import mainRoutes from "./routes/mainRoutes";
import { errorHandler, requestLogger } from "./middleware/errorHandler";
import logger from "./utils/logger";
import { getEarningsCalendar } from "./services/stockService";
import { mainFlow } from "./controllers/mainController";
import { readFile, saveFile } from "./utils/file";

const app = express();

const runMainFlow = async () => {
  logger.info("Running a scheduled task");
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const companiesReportingSoon = await getEarningsCalendar(
    yesterdayStr,
    todayStr
  );

  const companiesSymbolsUniqueArr = Array.from(
    new Set(companiesReportingSoon.map((item: any) => item.symbol))
  );

  logger.info(`Reporting today/yesterday: ${companiesSymbolsUniqueArr}`);
  const previouslySentReportsObj = readFile("./previouslySentReports.json");
  logger.info(
    `Previously processed symbols: ${JSON.stringify(previouslySentReportsObj)}`
  );
  for (const companySymbol of companiesSymbolsUniqueArr) {
    const company = companiesReportingSoon.find(
      (item: any) => item.symbol === companySymbol
    );
    const symbol: string = company.symbol;
    try {
      if (
        //@ts-ignore
        previouslySentReportsObj[symbol] === todayStr ||
        //@ts-ignore
        previouslySentReportsObj[symbol] === yesterdayStr
      ) {
        logger.info(`Skipping ${symbol} as it has already been processed.`);
      } else if (company.epsActual === null || company.revenueActual === null) {
        logger.info(`Skipping ${symbol} due to missing EPS or revenue data.`);
      } else {
        logger.info(`Processing symbol: ${symbol}`);
        await mainFlow(symbol);
        //@ts-ignore
        previouslySentReportsObj[symbol] = todayStr;
        saveFile("./previouslySentReports.json", previouslySentReportsObj);
      }
    } catch (error) {
      logger.error(`Error processing symbol ${company.symbol}:`, error);
    }
  }
};

// Schedule a task to run
cron.schedule("*/1 * * * *", async () => {
  runMainFlow();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);
app.use("/api/healthCheck", healthCheckRoutes);
app.use("/api/main", mainRoutes);  // ← הוסף שורה זו

app.use(errorHandler);

export default app;
