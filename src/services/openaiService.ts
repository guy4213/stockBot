import { OpenAI } from "openai";
import dotenv from "dotenv";
import logger from "../utils/logger";

dotenv.config({ quiet: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// export async function generateText(stockData: any): Promise<string> {
//   const outputFormat = `
// 🔹 סימול: ${stockData.symbol}
// 📅 תאריך: ${stockData.reportDate}


// • EPS: $2.06 (Beat ~17–28%)  
// • Revenues: ~$484M (YoY +10.5%, beat ~11%)  
// • Guidance: שיפור לשנת FY25, EBITDA כ‑43%  
// • FCF: חיוני ומשופר (~\$206M בחצי שנה)  

// 📈 אנליסטים: Targets ~\$243–254 – Upside ריאלי  
// ✅ האם יעדים יעמדו? כן – עם Beat חזק, צמיחה חזויה ותמיכה אנליסטית

// 📈 המלצה: קנייה  
// • כניסה: $235–240 • יעד ראשון: $270 • יעד שני: $300  
// • סטופ: $225  
// • סיכון–סיכוי: ~1:3.2
// `;

//   const instructions = `
//  ${stockData.reportStatus} הכן דוח 
//  סכם את הדוחות והכן סיכום מקצועי של 3-4 שורות בלבד! כולל מסקנה  מסקנה ${stockData.reportStatus}
// והסבר לשיקול

// התשובה חייבת להיות כמו בדוגמא הבאה:

// ${outputFormat}

// נתח דוח כספי רבעוני של חברה ציבורית, תוך מענה ישיר לשאלות ולקריטריונים הבאים.
// המטרה: לקבוע אם מדובר בדוח חיובי מאוד, כלומר כזה שמעיד על פוטנציאל חזק למסחר חיובי במניה.
// התייחס גם למרכיבים איכותיים (טון הנהלה, אמינות, צמיחה אורגנית), ולא רק לנתונים כמותיים.
// חלק1–ניתוח כמותי (חובה לדוח חיובי מאוד):
// 1.EPS(רווח למניה מתואם–Non-GAAP:)
// •האם גבוה מהתחזיות?
// •אם כן–בכמה אחוזים?
// נחשב חזק אם ה־EPSגבוה לפחות ב־10%מהתחזית.
// 2.הכנסות (Revenue:)
// •האם עברו את תחזית האנליסטים?
// •בכמה אחוזים?
// נחשב חזק אם עברו את התחזית ביותר מ־3%.
// 3.Guidanceקדימה:
// •האם החברה העלתה תחזיות עתידיות (EPS, הכנסות,EBITDA?)
// רק אם התחזית עלתה–המשך.
// אם נשארה אותו דבר או ירדה–לא נחשב דוח חיובי.
// 4.תזרים מזומנים חופשי (Free Cash Flow:)
// •האם חיובי?
// •האם יש שיפור ביחס לרבעון המקביל?
// עדיפות לחברות צמיחה עםFCFביחס גבוה להכנסות.
// 5.צמיחה שנתית (YoY Growth:)
// •האם ההכנסות צמחו לפחות ב־10%לעומת השנה שעברה?
// •אם מדובר בפלטפורמה–האם גם מספר המשתמשים/לקוחות גדל?
// חלק2–ניתוח איכותי / אסטרטגי:
// 6.סנטימנט הנהלה (Earnings Call / Commentary:)
// •האם ההנהלה נשמעת חיובית, בטוחה, ומדגישה צמיחה והמשכיות?
// אם יש אזהרות, הסתייגויות או ניסוחים שליליים–לא נחשב חיובי.
// 7.פעולות חריגות בדוח:
// •האם החברה הודיעה על קיצוצים, סגירת חטיבות, פיטורים, צמצומים?
// 8.סוג הצמיחה:
// •האם היא אורגנית (מפעילות פנימית) או לא (מרכישות)?
// 9.תזרים מזומנים מפעילות שוטפת (Operating Cash Flow:)
// •האם חיובי?
// •האם יש שיפור משמעותי?
// 10.אמינות ביצועים:
// •האם החברה נוהגת לעמוד בתחזיות באופן עקבי?
// •האם יש שינוי מהותי במדד האמינות שלה?
// מסקנה:
// •אם כל סעיפי חלק1מתקיימים, וטון חלק2הוא חיובי או ניטרלי–סמן את הדוח כ־“חיובי מאוד”.
// •אם חסרים קריטריונים קריטיים–סמן “לא חיובי”.
// •אפשר לציין גם אם מדובר ב־דוח שלילי במיוחד שמתאים לשורט

// פרומפט ניתוח דוח כספי–לזיהוי “דוח חיובי מאוד” בלבד
// נתח דוח כספי רבעוני של חברה ציבורית.
// המטרה היא לקבוע אם הדוח חיובי מאוד–כלומר, עומד בסטנדרט הגבוה ביותר להשקעה.
// סמן את הדוח כ”חיובי מאוד” רק אם כל הקריטריונים הבאים מתקיימים יחד.
// אחרת–סמן “לא חיובי”.
// קריטריונים לדוח חיובי מאוד (חובה לעמוד בכולם):
// 1.Beatבהכנסות (Revenue:)
// •ההכנסות בפועל גבוהות לפחות ב־3%מהתחזית של האנליסטים (consensus estimate.)
// 2.Beatב־EPS(רווח למניה מתואם):
// •הרווח למניה (Non-GAAP EPS) גבוה לפחות ב־10%מהתחזית.
// 3.Guidanceעתידי (תחזית קדימה):
// •החברה מעלה את התחזית שלה לשנה כולה (Revenue, EBITDA, אוEPS.)
// •אם אין שינוי או יש הנמכה–זה לא דוח חיובי.
// 4.תזרים מזומנים חופשי (Free Cash Flow – FCF:)
// •קייםFCFחיובי, או שיש שיפור חד לעומת השנה הקודמת (YoY.)
// •נדרשFCFביחס להכנסות אם מדובר בחברת צמיחה.
// 5.צמיחה שנתית (YoY Growth:)
// •צמיחה של לפחות10%בהכנסות לעומת אותו רבעון אשתקד.
// •אם מדובר בפלטפורמה–צריך גם גידול במספר המשתמשים/לקוחות.
// 6.קול הנהלה (Earnings Call / Commentary:)
// •טון חיובי, בטוח, מדגיש צמיחה והמשכיות.
// •ללא אזהרות, הסתייגויות או שפה זהירה מדי.

// ממוצע 4 רבעונים אחרונים, סטטיסטיקה
// מה קורה למניה כהש-EPSגבוה מהתחזית או נמוך מהתחזית

// 🟢 תבנית פלט:
// ${outputFormat}

// `;

//   try {
//     logger.info("Sending prompt to chatGpt");
//     const prompt = JSON.stringify(stockData) + instructions;
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4.1-nano", // or 'gpt-4' if your key supports it
//       messages: [{ role: "user", content: prompt }],
//       temperature: 0.7,
//     });
//     // const inputTokens = completion.usage?.prompt_tokens;
//     // const outputTokens = completion.usage?.completion_tokens;
//     const answer = completion.choices[0].message.content;

//     return answer || "Can't get AI response";
//   } catch (error: any) {
//     console.error("OpenAI API error:", error.message);
//     throw new Error("Failed to generate text from OpenAI");
//   }
// }

export async function generateText(stockData: any): Promise<string> {
  
  // בניית הפורמט הדינמי
  const outputFormat = `
🔹 סימול: ${stockData.symbol}
🏢 חברה: ${stockData.companyName || stockData.symbol}
💰 מחיר נוכחי: $${stockData.currentPrice}
📊 שווי שוק: $${(stockData.marketCap / 1_000_000_000).toFixed(1)}B
📈 נפח מסחר יומי: ${(stockData.avgVolume / 1_000_000).toFixed(1)}M מניות

📊 ביצועים רבעוניים:
- EPS בפועל: $${stockData.lastEpsActual} (תחזית: $${stockData.lastEpsEstimated})
  → Beat של ${stockData.lastEpsChangePercent}%
  
- הכנסות בפועל: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M (תחזית: $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M)
  → Beat של ${stockData.lastRevenueChangePercent}%

📈 צמיחה שנתית (YoY):
- EPS: ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange}%
- הכנסות: ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange}%
- תזרים מזומנים חופשי: ${stockData.yoyFreeCashFlowChange > 0 ? '+' : ''}${stockData.yoyFreeCashFlowChange}%

🎯 סיווג: ${stockData.reportStatus}

💼 המלצת מסחר:
${stockData.tradeParams ? `
- כיוון: ${stockData.tradeParams.direction}
- כניסה: ${stockData.tradeParams.entry}
- יעד ראשון: ${stockData.tradeParams.targetFirst} (+5%)
- יעד שני: ${stockData.tradeParams.targetSecond} (+15%)
- סטופ לוס: ${stockData.tradeParams.stop} (-5%)
- יחס סיכון/סיכוי: ${stockData.tradeParams.riskReward}
` : 'אין המלצת מסחר'}

📝 סיכום והמלצה:
[כאן תכתוב 3-4 שורות ניתוח מקצועי בעברית]
`;

  const instructions = `
אתה אנליסט פיננסי מומחה. קיבלת את הנתונים הבאים על דוח רווח רבעוני.

**תפקידך:**
1. לנתח את הנתונים הכמותיים שסופקו
2. לכתוב סיכום מקצועי של 3-4 שורות בעברית
3. להתייחס לנקודות החוזק/חולשה העיקריות
4. לתת המלצה ברורה (קנייה/מכירה/המתנה)

**חשוב:**
- אל תמציא נתונים שלא סופקו לך
- אל תשנה את הסיווג (${stockData.reportStatus}) - הוא כבר חושב
- התמקד בניתוח איכותי של המשמעות של המספרים
- השתמש בשפה מקצועית אבל ברורה

**כל המידע שאתה צריך נמצא כאן:**
${JSON.stringify(stockData, null, 2)}

**התשובה שלך חייבת להיות בפורמט הזה בדיוק:**

${outputFormat}

**דוגמה לסיכום טוב:**
"החברה הציגה ביצועים חזקים במיוחד עם Beat משמעותי הן ב-EPS והן בהכנסות. 
הצמיחה השנתית של ${stockData.yoyRevenueChange}% בהכנסות ו-${stockData.yoyEpsChange}% ב-EPS 
מעידה על מומנטום חיובי. תזרים המזומנים החופשי ${stockData.yoyFreeCashFlowChange > 0 ? 'משתפר' : 'נחלש'} 
מה שמחזק את איכות הרווחים. בהינתן ${stockData.reportStatus}, זוהי הזדמנות ${stockData.reportStatus.includes('חיובי') ? 'קנייה' : 'מכירה'} 
עם פוטנציאל עליה של עד 15% לטווח קצר-בינוני."

עכשיו כתוב את הדוח בעברית בפורמט שצוין לעיל.
`;

  try {
    logger.info("Sending prompt to ChatGPT");
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // או המודל שאתה משתמש בו
      messages: [{ role: "user", content: instructions }],
      temperature: 0.7,
    });
    
    const answer = completion.choices[0].message.content;
    return answer || "Can't get AI response";
    
  } catch (error: any) {
    console.error("OpenAI API error:", error.message);
    throw new Error("Failed to generate text from OpenAI");
  }
}