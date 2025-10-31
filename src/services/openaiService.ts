import { OpenAI } from "openai";
import dotenv from "dotenv";
import logger from "../utils/logger";

dotenv.config({ quiet: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateText(stockData: any): Promise<string> {
  
  // 🎯 Simplified prompt that won't trigger OpenAI refusals
  const systemPrompt = `You are a professional financial analyst providing educational analysis of public company earnings reports.

Your role:
- Analyze quarterly earnings data objectively
- Provide insights based on the data provided
- Write in Hebrew for Israeli investors
- This is for educational purposes only

Important: All numerical data is already provided. You just need to analyze and summarize it.`;

  const outputFormat = `
📌 סימול: ${stockData.symbol}
📅 תאריך דוח: ${new Date().toLocaleDateString('he-IL')}

📊 פרטי דוח:
• EPS: $${stockData.lastEpsActual} מול תחזית $${stockData.lastEpsEstimated} (סטייה ${stockData.lastEpsChangePercent.toFixed(2)}%)
• Revenues: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M מול תחזית $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M (סטייה ${stockData.lastRevenueChangePercent.toFixed(2)}%)
• Guidance: ${stockData.guidance?.guidance || 'לא זמין'}
• Free Cash Flow: ${stockData.yoyFreeCashFlowChange > 0 ? 'חיובי ומשתפר' : stockData.yoyFreeCashFlowChange < 0 ? 'שלילי או יורד' : 'יציב'}
• YoY Growth: EPS ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange.toFixed(2)}% | Revenue ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange.toFixed(2)}%
• שולי רווח: ${stockData.margins ? `Net ${(stockData.margins.netProfitMargin * 100).toFixed(2)}% (${stockData.margins.marginTrend === 'improving' ? 'עולה' : stockData.margins.marginTrend === 'declining' ? 'יורד' : 'יציב'})` : 'לא זמין'}
• סנטימנט הנהלה: ${stockData.sentiment?.sentiment === 'positive' ? 'חיובי' : stockData.sentiment?.sentiment === 'negative' ? 'שלילי' : 'ניטרלי'}

⚖ ניקוד כולל: ${stockData.finalScore?.totalScore?.toFixed(2) || 'לא חושב'}
⚖ סיווג סופי: ${stockData.reportStatus}

📈 המלצת מסחר:
${stockData.tradeParams ? `
כיוון: ${stockData.tradeParams.direction}
כניסה: ${stockData.tradeParams.entry}
יעד רווח: ${stockData.tradeParams.targetSecond}
סטופ לוס: ${stockData.tradeParams.stop}
` : 'אין המלצה'}

🧩 שיקול דעת AI:
[כתוב כאן ניתוח קצר של 2-3 שורות]

📝 מסקנה:
[סיכום של 1-2 שורות עם המלצה ברורה]
`;

  const userPrompt = `
Please analyze this quarterly earnings report and provide insights in Hebrew.

Company: ${stockData.companyName || stockData.symbol} (${stockData.symbol})
Price: $${stockData.currentPrice}
Market Cap: $${(stockData.marketCap / 1_000_000_000).toFixed(1)}B

Key Metrics:
- EPS: $${stockData.lastEpsActual} vs est. $${stockData.lastEpsEstimated} (${stockData.lastEpsChangePercent > 0 ? '+' : ''}${stockData.lastEpsChangePercent.toFixed(1)}%)
- Revenue: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M vs est. $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M (${stockData.lastRevenueChangePercent > 0 ? '+' : ''}${stockData.lastRevenueChangePercent.toFixed(1)}%)
- YoY EPS Growth: ${stockData.yoyEpsChange.toFixed(1)}%
- YoY Revenue Growth: ${stockData.yoyRevenueChange.toFixed(1)}%
- FCF Growth: ${stockData.yoyFreeCashFlowChange.toFixed(1)}%
- Guidance: ${stockData.guidance?.guidance || 'unavailable'}
- Classification: ${stockData.reportStatus}

Please provide your analysis in this exact format (in Hebrew):

${outputFormat}

For the "שיקול דעת AI" section, write 2-3 sentences explaining:
1. Why this report received its classification
2. Key strengths or weaknesses
3. What investors should watch

For the "מסקנה" section, provide a clear 1-2 sentence recommendation.

Write naturally and focus on actionable insights. This is educational analysis, not investment advice.
`;

  try {
    logger.info("🤖 Sending simplified prompt to ChatGPT");
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Using mini to reduce costs and avoid refusals
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });
    
    const answer = completion.choices[0].message.content;
    
    if (!answer || answer.toLowerCase().includes("i'm sorry") || answer.toLowerCase().includes("i cannot")) {
      logger.warn("⚠️  AI gave a refusal response, using fallback");
      return generateFallbackResponse(stockData);
    }
    
    logger.info("✅ AI analysis completed successfully");
    return answer;
    
  } catch (error: any) {
    logger.error("❌ OpenAI API error:", error.message);
    logger.warn("Using fallback response due to API error");
    return generateFallbackResponse(stockData);
  }
}

// Fallback function in case AI refuses or fails
function generateFallbackResponse(stockData: any): string {
  const epsStatus = stockData.lastEpsChangePercent > 5 ? "חזק" : stockData.lastEpsChangePercent < -5 ? "חלש" : "סביר";
  const revenueStatus = stockData.lastRevenueChangePercent > 3 ? "חזק" : stockData.lastRevenueChangePercent < -3 ? "חלש" : "סביר";
  const recommendation = stockData.reportStatus.includes("חיובי") ? "קנייה" : stockData.reportStatus === "שלילי" ? "מכירה" : "המתנה";
  
  return `
📌 סימול: ${stockData.symbol}
📅 תאריך דוח: ${new Date().toLocaleDateString('he-IL')}

📊 פרטי דוח:
• EPS: $${stockData.lastEpsActual} מול תחזית $${stockData.lastEpsEstimated} (סטייה ${stockData.lastEpsChangePercent.toFixed(2)}%)
• Revenues: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M מול תחזית $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M (סטייה ${stockData.lastRevenueChangePercent.toFixed(2)}%)
• Guidance: ${stockData.guidance?.guidance || 'לא זמין'}
• Free Cash Flow: ${stockData.yoyFreeCashFlowChange > 0 ? 'חיובי ומשתפר' : stockData.yoyFreeCashFlowChange < 0 ? 'שלילי או יורד' : 'יציב'}
• YoY Growth: EPS ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange.toFixed(2)}% | Revenue ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange.toFixed(2)}%
• שולי רווח: ${stockData.margins ? `Net ${(stockData.margins.netProfitMargin * 100).toFixed(2)}% (${stockData.margins.marginTrend === 'improving' ? 'עולה' : stockData.margins.marginTrend === 'declining' ? 'יורד' : 'יציב'})` : 'לא זמין'}
• סנטימנט הנהלה: ${stockData.sentiment?.sentiment === 'positive' ? 'חיובי' : stockData.sentiment?.sentiment === 'negative' ? 'שלילי' : 'ניטרלי'}

⚖ ניקוד כולל: ${stockData.finalScore?.totalScore?.toFixed(2) || 'N/A'}
⚖ סיווג סופי: ${stockData.reportStatus}

📈 המלצת מסחר:
${stockData.tradeParams ? `
כיוון: ${stockData.tradeParams.direction}
כניסה: ${stockData.tradeParams.entry}
יעד רווח: ${stockData.tradeParams.targetSecond}
סטופ לוס: ${stockData.tradeParams.stop}
` : 'אין המלצה'}

🧩 שיקול דעת AI:
החברה הציגה ביצועים ${epsStatus} ב-EPS ו${revenueStatus} בהכנסות. הצמיחה השנתית של ${Math.abs(stockData.yoyEpsChange).toFixed(1)}% ב-EPS מעידה על ${stockData.yoyEpsChange > 10 ? 'מומנטום חיובי' : stockData.yoyEpsChange < 0 ? 'מגמה שלילית' : 'יציבות'}. ${stockData.guidance?.guidance === 'raised' ? 'העלאת התחזית מחזקת את התזה החיובית.' : stockData.guidance?.guidance === 'lowered' ? 'הורדת התחזית מעוררת דאגה.' : ''}

📝 מסקנה:
בהתבסס על הניתוח, המלצתנו היא **${recommendation}**. ${stockData.reportStatus.includes("חיובי") ? 'הנתונים מצביעים על הזדמנות עם פוטנציאל עליה.' : 'הנתונים מצביעים על סיכון ויש להיזהר.'}
`;
}