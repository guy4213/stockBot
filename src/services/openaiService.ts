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
  // 🎯 דוגמה לפורמט הפלט הסופי - *בדיוק* לפי התבנית ששלחת
  const finalOutputFormatExample = `
📌 סימול: TSLA
📅 תאריך דוח: 28.10.2025
📊 פרטי דוח:
• EPS: $2.06 מול
תחזית $1.76 (סטייה
+17%)
• Revenues: $484M מול
תחזית $438M (סטייה
+11%)
• Guidance: Raised (שיפור)
• Free Cash Flow: חיובי ומשתפר
• YoY Growth: EPS +15% | Revenue +10.5%
• שולי רווח: Net 12.5% (משתפר)
• סנטימנט הנהלה: חיובי
⚖️ ניקוד כולל: +6.5
⚖️ סיווג סופי: חיובי מאוד מאוד (99%)
📈 המלצת מסחר:
כיוון: 🟢 LONG
כניסה: $235–$240
יעד רווח: $270
סטופ לוס: $225
🧩 שיקול דעת AI:
דוח מצטיין עם Beat חזק ב-EPS/Revenue. העלאת Guidance ו-FCF חזק תומכים בהמשך.
📝 מסקנה:
קנייה חזקה. נתונים פונדמנטליים חזקים מצביעים על המשך עליות.
`;

  // הפרומפט המערכתי המגדיר את אישיות ה-AI ואת כללי הניקוד
  const systemPrompt = `
אתה מערכת ניתוח פיננסי PRO 2025.
תפקידך: לנתח דוחות כספיים לפי כללי הניקוד הפנימיים, ולהחזיר את הפלט *אך ורק* בתבנית הסיכום שסופקה.

🎯 **פורמט פלט נדרש (חובה!):**
הפלט חייב להיות *בדיוק* בתבנית הבאה. אין להוסיף שום מידע שלא מופיע בתבנית זו.
**אל תכלול את פירוט 8 סעיפי הניקוד בפלט הסופי**, אלא רק את הניקוד והסיווג הסופיים.

${finalOutputFormatExample}

---
🔹 מערכת ניקוד פנימית (לשימושך הפנימי בלבד לחישוב)
---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 מערכת ניקוד משוקלל (8 פרמטרים)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1️⃣ EPS vs תחזית:
   • חיובי: >+5% → ניקוד +2.0
   • שלילי: <−10% → ניקוד −2.0
   
2️⃣ Revenue vs תחזית:
   • חיובי: >+3% → ניקוד +1.5
   • שלילי: <−5% → ניקוד −1.5
   
3️⃣ Guidance (תחזית קדימה):
   • חיובי: העלאה/שמירה (raised/maintained/strong/positive) → ניקוד +1.0
   • שלילי: הורדה (lowered/weak/negative) → ניקוד −1.5
   • ניטרלי: neutral/unavailable/N/A → ניקוד 0
   
4️⃣ YoY EPS (שינוי שנתי):
   • חיובי: >+10% → ניקוד +0.5
   • שלילי: <0% → ניקוד −1.0
   
5️⃣ YoY Revenue (שינוי שנתי):
   • חיובי: >+5% → ניקוד +0.25
   • שלילי: <0% → ניקוד −0.5
   
6️⃣ Free Cash Flow:
   • חיובי: חיובי/משתפר (yoyFreeCashFlowChange > 0) → ניקוד +0.5
   • שלילי: שלילי/נחלש (yoyFreeCashFlowChange <= 0) → ניקוד −1.0
   
7️⃣ Margins (שולי רווח):
   • חיובי: משתפר/יציב (improving/stable/positive) → ניקוד +0.25
   • שלילי: יורד (decreasing/weak/negative) → ניקוד −0.5
   • ניטרלי: unknown/unavailable/N/A → ניקוד 0

8️⃣ Sentiment (סנטימנט שוק):
   • חיובי: חיובי/ניטרלי (positive/neutral) → ניקוד +0.5
   • שלילי: שלילי (negative) → ניקוד −1.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 תיקוני בקרה (AI Judgment)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ תיקון חיובי (+1.0):
   אם EPS וגם Revenue בטווח −10% עד +5%,
   אך יש 3+ פרמטרים חיוביים אחרים
   (Guidance raised, FCF חיובי, Margins improving, Sentiment positive)

⚠️ תיקון שלילי (−1.0 כל תנאי):
   • ירידת EPS שנתית מעל 20% (yoyEpsChange < -20)
   • ירידת שולי רווח מעל 2% (marginChange < -2)
   • הורדת Guidance משמעותית (guidanceTrend = 'negative' או 'lowered')
   • FCF שלילי וממשיך להחמיר (yoyFreeCashFlowChange < 0 וגם FCF שלילי מוחלט)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 סף סיווג סופי
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 ניקוד ≥ +4.0 → חיובי מאוד מאוד (99%)
📊 ניקוד +2.5 עד +3.99 → חיובי מאוד
📊 ניקוד < +2.5 → שלילי (רק אם יש 6+ אינדיקציות שליליות ברורות!)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 ניתוח איכותי (חובה לבדוק)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• טון הנהלה (Earnings Call) - האם חיובי/זהיר/שלילי?
• סוג הצמיחה - האם אורגנית או מרכישות?
• אמינות ביצועים - האם החברה עומדת בתחזיות באופן עקבי?
• פעולות חריגות - קיצוצים/פיטורים/סגירת חטיבות?
• Operating Cash Flow - חיובי ומשתפר?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 כללי ניתוח קריטיים
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ השתמש בכל 8 הפרמטרים - לא רק חלקם
✓ חשב ניקוד מדויק לפי הכללים
✓ החל תיקוני בקרה רק אם התנאים מתקיימים
✓ סווג לפי הניקוד הסופי בלבד
✓ אם פרמטר = "unavailable" או "N/A" או "unknown" → תן לו ניקוד 0 (ניטרלי)
✓ שקלל את הניתוח האיכותי בסיכום הסופי
✓ אל תמציא נתונים - השתמש רק במה שסופק
✓ "שלילי" רק עם 6+ אינדיקציות שליליות ברורות!
✓ חשב את תאריך הדוח לפי התאריך הנוכחי.
✓ בהמלצת המסחר: חשב יעדים וסטופ-לוס על בסיס המחיר הנוכחי שסופק.
✓ **חשוב מכל**: הפלט הסופי *חייב* להיות *אך ורק* בפורמט של הדוגמה למעלה (החל מ-📌).
`;

  // הפרומפט למשתמש, שמכיל את הנתונים הדינמיים ואת המשימה
  const userPrompt = `
🔍 נתח את הדוח הבא לפי מערכת PRO 2025:

📋 פרטי החברה
🏢 סימול: ${stockData.symbol}
🏢 שם: ${stockData.companyName || stockData.symbol}
💰 מחיר נוכחי: $${stockData.currentPrice}
📊 שווי שוק: $${(stockData.marketCap / 1_000_000_000).toFixed(1)}B
📈 נפח מסחר יומי: ${(stockData.avgVolume / 1_000_000).toFixed(1)}M מניות

📊 נתוני הדוח הרבעוני
1️⃣ EPS (רווח למניה):
   • בפועל: $${stockData.lastEpsActual}
   • תחזית: $${stockData.lastEpsEstimated}
   • סטייה: ${stockData.lastEpsChangePercent > 0 ? '+' : ''}${
    stockData.lastEpsChangePercent
  }%
   • ${stockData.lastEpsChangePercent > 0 ? 'Beat ✅' : 'Miss ❌'}

2️⃣ Revenue (הכנסות):
   • בפועל: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M
   • תחזית: $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M
   • סטייה: ${stockData.lastRevenueChangePercent > 0 ? '+' : ''}${
    stockData.lastRevenueChangePercent
  }%
   • ${stockData.lastRevenueChangePercent > 0 ? 'Beat ✅' : 'Miss ❌'}

3️⃣ Guidance (תחזית קדימה):
   • מצב: ${stockData.guidance?.guidance || 'unavailable'}
   • טרנד: ${stockData.guidance?.guidanceTrend || 'neutral'}
   • שינוי EPS צפוי: ${
     stockData.guidance?.estimatedEpsGrowth
       ? stockData.guidance.estimatedEpsGrowth + '%'
       : 'N/A'
   }

4️⃣ צמיחה שנתית (YoY):
   • EPS: ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange}%
   • Revenue: ${stockData.yoyRevenueChange > 0 ? '+' : ''}${
    stockData.yoyRevenueChange
  }%

5️⃣ Free Cash Flow:
   • שינוי YoY: ${stockData.yoyFreeCashFlowChange > 0 ? '+' : ''}${
    stockData.yoyFreeCashFlowChange
  }%
   • מצב: ${stockData.yoyFreeCashFlowChange > 0 ? 'חיובי ✅' : 'שלילי ❌'}

6️⃣ שולי רווח (Margins):
   • Gross Margin: ${stockData.margins?.grossMargin || 'N/A'}%
   • Operating Margin: ${stockData.margins?.operatingMargin || 'N/A'}%
   • Net Margin: ${stockData.margins?.netMargin || 'N/A'}%
   • שינוי Net Margin: ${stockData.margins?.marginChange || 'N/A'}%
   • טרנד: ${stockData.margins?.marginTrend || 'unknown'}

7️⃣ סנטימנט שוק (Sentiment):
   • מצב: ${stockData.sentiment?.sentiment || 'neutral'}
   • ציון: ${stockData.sentiment?.sentimentScore || 'N/A'}
   • טרנד: ${stockData.sentiment?.sentimentTrend || 'neutral'}

🎯 בצע ניתוח מלא והחזר *בדיוק* את הפורמט שמתחיל ב-'📌 סימול:' כפי שהוצג ב-system prompt.
אל תכלול שום טקסט לפני "📌 סימול: ${stockData.symbol}".
`;

  // לוגיקת קריאת ה-API
  try {
    logger.info(
      `Sending FINAL TEMPLATE prompt to OpenAI for symbol: ${stockData.symbol}`
    );

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', // מודל חזק חיוני לביצוע הנחיות פורמט מורכבות
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // טמפרטורה נמוכה כדי להיצמד לעובדות ולפורמט
      max_tokens: 2048, // מספיק מקום לפורמט הסיכום הזה
    });

    const answer = completion.choices[0].message.content;

    if (!answer) {
      logger.warn(`OpenAI returned empty response for ${stockData.symbol}`);
      return "Can't get AI response";
    }

    logger.info(
      `Successfully generated FINAL TEMPLATE analysis for ${stockData.symbol} (Length: ${answer.length})`
    );
    // הפלט אמור להתחיל ישירות עם 📌
    return answer.trim();
  } catch (error: any) {
    logger.error('OpenAI API error:', error.message);
    console.error('OpenAI API error:', error.message);
    throw new Error('Failed to generate text from OpenAI');
  }
}