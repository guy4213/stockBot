import { fullExtraction } from "./src/services/grokService";

async function testWFC() {
  console.log("🧪 Testing WFC Q4 2025 extraction...\n");

  try {
    const result = await fullExtraction(
      "WFC",
      "Wells Fargo",
      "2026-01-15",
      89.25,
      {
        epsActual: 1.76,
        epsEstimate: 1.69,
        revenueActual: 21292000000,
        revenueEstimate: 21865000000
      },
      4,     // Q4
      2025   // Fiscal Year 2025
    );

    console.log("\n📊 ===== RESULTS =====");
    console.log(`Revenue YoY: ${result.yoyGrowth.revenueChange}% (${result.yoyGrowth.revenueChangeType || 'unknown'})`);
    console.log(`Net Margin: ${result.margins.netMargin}%`);
    console.log(`Operating Margin: ${result.margins.operatingMargin}%`);
    console.log(`FCF: $${result.cashFlow.freeCashFlow ? (result.cashFlow.freeCashFlow / 1e6).toFixed(2) : 'N/A'}M`);
    console.log(`\nPDF URL: ${result.dataSources?.pdfUrl || 'N/A'}`);
    console.log("\n✅ Test complete!");

  } catch (error: any) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

testWFC();
