// // ============================================
// // GROK SERVICE USAGE EXAMPLE
// // ============================================
// // This file demonstrates how to use the optimized Grok service
// // with sequential processing and scheduled checks.
// // ============================================

// import {
//   morningIntelligence,
//   StockProcessor,
// } from "../services/grokService";
// import logger from "../utils/logger";
// import { StockProcessingState } from "../types/grok.types";

// // ============================================
// // EXAMPLE 1: Basic Daily Workflow
// // ============================================

// async function dailyEarningsWorkflow(date: string) {
//   logger.info(`\n${"=".repeat(80)}`);
//   logger.info(`🌅 Starting Daily Earnings Workflow for ${date}`);
//   logger.info(`${"=".repeat(80)}\n`);

//   try {
//     // Step 1: Morning Intelligence - Get list of reporting stocks
//     logger.info("📋 Step 1: Running Morning Intelligence...");
//     const morningData = await morningIntelligence(date);

//     if (morningData.stocks.length === 0) {
//       logger.info("❌ No qualifying stocks found for today");
//       return;
//     }

//     logger.info(`✅ Found ${morningData.stocks.length} qualifying stocks`);
//     logger.info(`\nStocks to monitor:`);
//     morningData.stocks.forEach((stock, index) => {
//       logger.info(
//         `   ${index + 1}. ${stock.symbol} (${stock.companyName}) - ${stock.reportType} ${stock.windowStart}-${stock.windowEnd}`
//       );
//     });

//     // Step 2: Initialize Stock Processor
//     logger.info(`\n📦 Step 2: Initializing Stock Processor...`);

//     const processor = new StockProcessor((stock: StockProcessingState) => {
//       // Callback when a stock is completed
//       logger.info(`\n${"*".repeat(60)}`);
//       logger.info(`✅ STOCK COMPLETED: ${stock.symbol}`);
//       logger.info(`${"*".repeat(60)}`);

//       if (stock.analysis) {
//         logger.info(`\n📊 Analysis Summary:`);
//         logger.info(stock.analysis.summary);
//         logger.info(`\n🎯 Mira Score: ${stock.analysis.miraScore.totalScore}`);
//         logger.info(`📈 Trading Recommendation: ${stock.analysis.tradingRecommendation.direction}`);

//         // Here you would send to Telegram
//         // sendToTelegram(stock.analysis.summary);
//       }

//       logger.info(`\n${"*".repeat(60)}\n`);
//     });

//     // Initialize with morning data
//     processor.initialize(morningData);

//     // Step 3: Start the processor (runs every 5 minutes)
//     logger.info(`\n🚀 Step 3: Starting Stock Processor...`);
//     logger.info(`   The processor will check each stock every 5 minutes.`);
//     logger.info(`   When a report is published, it will automatically extract and analyze.`);
//     logger.info(`   Press Ctrl+C to stop.\n`);

//     processor.start();

//     // Monitor status every minute
//     const statusInterval = setInterval(() => {
//       const status = processor.getStatus();
//       logger.info(`\n📊 Status Update:`);
//       logger.info(`   Total: ${status.total}`);
//       logger.info(`   Pending: ${status.pending}`);
//       logger.info(`   Checking: ${status.checking}`);
//       logger.info(`   Extracting: ${status.extracting}`);
//       logger.info(`   Completed: ${status.completed}`);
//       logger.info(`   Errors: ${status.error}`);

//       // Stop monitoring when all done
//       if (status.completed + status.error === status.total) {
//         clearInterval(statusInterval);
//         processor.stop();
//         logger.info(`\n✅ All stocks processed! Workflow complete.`);
//       }
//     }, 60000); // Every minute

//     // Handle graceful shutdown
//     process.on("SIGINT", () => {
//       logger.info("\n\n🛑 Received SIGINT. Stopping processor...");
//       clearInterval(statusInterval);
//       processor.stop();
//       process.exit(0);
//     });
//   } catch (error) {
//     logger.error("❌ Error in daily earnings workflow:", error);
//     throw error;
//   }
// }

// // ============================================
// // EXAMPLE 2: Check Single Stock
// // ============================================

// async function checkSingleStock(
//   symbol: string,
//   companyName: string,
//   date: string
// ) {
//   logger.info(`\n🔍 Checking single stock: ${symbol} (${companyName})`);

//   try {
//     const { miniCheck, fullExtraction, finalAnalysis } = await import(
//       "../services/grokService"
//     );

//     // Step 1: Check if report is published
//     logger.info(`📋 Step 1: Checking if report is published...`);
//     const miniCheckResult = await miniCheck(symbol, companyName);

//     if (miniCheckResult.result !== "YES") {
//       logger.info(`❌ Report not published yet for ${symbol}`);
//       return null;
//     }

//     logger.info(`✅ Report published! Extracting data...`);

//     // Step 2: Extract full data
//     logger.info(`📊 Step 2: Extracting full financial data...`);
//     const fullData = await fullExtraction(symbol, companyName, date);

//     if (
//       fullData.aiRecommendation.decision !== "SEND" &&
//       fullData.aiRecommendation.decision !== "SEND_WITH_WARNING"
//     ) {
//       logger.info(`⚠️ Data quality insufficient for ${symbol}`);
//       return null;
//     }

//     logger.info(`✅ Data extracted successfully!`);

//     // Step 3: Generate analysis
//     logger.info(`📝 Step 3: Generating Hebrew analysis...`);

//     // Calculate Mira Score (simplified)
//     const totalScore = calculateSimpleMiraScore(fullData);
    
//     // Derive classification from totalScore
//     const deriveClassification = (score: number): "POSITIVE" | "NEUTRAL" | "NEGATIVE" => {
//       if (score > 0) return "POSITIVE";
//       if (score < 0) return "NEGATIVE";
//       return "NEUTRAL";
//     };
    
//     const miraScore = {
//       totalScore,
//       classification: deriveClassification(totalScore),
//       breakdown: {
//         epsScore: fullData.eps.beatPercent || 0,
//         revenueScore: fullData.revenue.beatPercent || 0,
//         guidanceScore: fullData.guidance.status === "raised" ? 1 : 0,
//         yoyEpsScore: fullData.yoyGrowth.epsChange || 0,
//         yoyRevenueScore: fullData.yoyGrowth.revenueChange || 0,
//         fcfScore: fullData.cashFlow.yoyChange || 0,
//         marginScore: fullData.margins.changeFromPrior || 0,
//         sentimentScore: fullData.sentiment.score || 0,
//       },
//       exceptions: [],
//     };

//     const analysis = await finalAnalysis(fullData, miraScore);

//     logger.info(`✅ Analysis complete!`);
//     logger.info(`\n${analysis.summary}`);

//     return analysis;
//   } catch (error) {
//     logger.error(`❌ Error checking ${symbol}:`, error);
//     throw error;
//   }
// }

// // Helper function for Mira score
// function calculateSimpleMiraScore(data: any): number {
//   let score = 0;

//   if (data.eps.beatPercent) score += data.eps.beatPercent > 0 ? 1 : -1;
//   if (data.revenue.beatPercent) score += data.revenue.beatPercent > 0 ? 1 : -1;
//   if (data.guidance.status === "raised") score += 1;
//   if (data.guidance.status === "lowered") score -= 1;
//   if (data.sentiment.score) score += data.sentiment.score > 0.5 ? 1 : data.sentiment.score < -0.5 ? -1 : 0;

//   return score;
// }

// // ============================================
// // EXAMPLE 3: Manual Testing
// // ============================================

// async function manualTest() {
//   // Test with a specific date
//   const date = "2025-01-15"; // Change to desired date

//   await dailyEarningsWorkflow(date);
// }

// // ============================================
// // EXPORTS
// // ============================================

// export {
//   dailyEarningsWorkflow,
//   checkSingleStock,
//   manualTest,
// };

// // ============================================
// // RUN EXAMPLE (if called directly)
// // ============================================

// if (require.main === module) {
//   const args = process.argv.slice(2);
//   const date = args[0] || new Date().toISOString().split("T")[0];

//   logger.info("🚀 Running Grok Service Example...");
//   logger.info(`   Date: ${date}`);

//   dailyEarningsWorkflow(date).catch((error) => {
//     logger.error("❌ Fatal error:", error);
//     process.exit(1);
//   });
// }
