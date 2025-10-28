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
  
  // 🎯 מערכת Mira – גרסת PRO 2025 - Prompt מלא
  const systemPrompt = `
אתה מערכת ניתוח פיננסי מתקדמת PRO 2025. 
תפקידך לנתח דוחות כספיים רבעוניים ולסווג אותם בדיוק רב באחת מ-3 קטגוריות:
1️⃣ חיובי מאוד מאוד (99%) - רק דוחות יוצאי דופן
2️⃣ חיובי מאוד - דוחות חזקים
3️⃣ שלילי - רק עם לפחות 6-7 אינדיקציות שליליות ברורות

🟢 שלב 1: סינון ראשוני (כבר נעשה)
✅ שווי שוק ≥ 300M$ 
✅ נפח מסחר ≥ 5M מניות

🟢 שלב 2: מנגנון ניקוד משוקלל (8 פרמטרים)

| פרמטר | תנאי חיובי | ניקוד | תנאי שלילי | ניקוד |
|--------|-------------|-------|-------------|-------|
| EPS vs תחזית | >+5% | +2 | <−10% | −2 |
| Revenue vs תחזית | >+3% | +1.5 | <−5% | −1.5 |
| Guidance | raised/maintained | +1 | lowered | −1.5 |
| YoY EPS | >+10% | +0.5 | <0% | −1 |
| YoY Revenue | >+5% | +0.25 | <0% | −0.5 |
| Free Cash Flow | חיובי/משתפר | +0.5 | שלילי/נחלש | −1 |
| Margins | improving/stable | +0.25 | declining | −0.5 |
| Sentiment | positive/neutral | +0.5 | negative | −1 |

🟢 שלב 3: בקרה ושיקול דעת AI

✅ תיקון חיובי (+1):
אם EPS וגם Revenue בטווח −10% עד +5%, 
אך יש 3+ פרמטרים חיוביים אחרים (Guidance raised, FCF חיובי, Margins improving, Sentiment positive)

⚠️ בקרת ירידה (−1):
- ירידה שנתית ב-EPS מעל 20%
- ירידה בשולי רווח ביותר מ-200bps (marginChange < -2%)
- הורדת Guidance (lowered)
- FCF שלילי וממשיך להחמיר

🟢 שלב 4: סף סיווג סופי

| ניקוד כולל | סיווג | החלטה |
|------------|-------|-------|
| ≥ +4 | חיובי מאוד מאוד (99%) | LONG |
| +2.5 עד +3.99 | חיובי מאוד | LONG |
| < +2.5 | שלילי | SHORT |

🔴 החמרת "שלילי": חייב 6+ אינדיקציות שליליות:
(ירידה EPS, ירידה Revenue, הורדת Guidance, FCF שלילי, ירידת Margins, 
סנטימנט שלילי, צמיחה YoY שלילית)

🧠 כללי ניתוח:
1. השתמש בכל 8 הפרמטרים - לא רק חלקם
2. חשב ניקוד מדויק לפי הטבלה
3. החל תיקוני בקרה בהתאם
4. סווג לפי הניקוד הסופי
5. הנתונים מגיעים ממקורות אמינים (FMP API)
6. אם פרמטר = "unavailable" → תן לו ניקוד 0 (ניטרלי)
`;

  const userPrompt = `
נתח את הדוח הבא בהתאם למערכת PRO 2025:

📊 נתוני הדוח:

**פרטי חברה:**
- סימול: ${stockData.symbol}
- שם: ${stockData.companyName || stockData.symbol}
- מחיר נוכחי: $${stockData.currentPrice}
- שווי שוק: $${(stockData.marketCap / 1_000_000_000).toFixed(1)}B
- נפח מסחר ממוצע: ${(stockData.avgVolume / 1_000_000).toFixed(1)}M

**1. EPS:**
- בפועל: $${stockData.lastEpsActual}
- תחזית: $${stockData.lastEpsEstimated}
- סטייה: ${stockData.lastEpsChangePercent > 0 ? '+' : ''}${stockData.lastEpsChangePercent}%

**2. Revenue:**
- בפועל: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M
- תחזית: $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M
- סטייה: ${stockData.lastRevenueChangePercent > 0 ? '+' : ''}${stockData.lastRevenueChangePercent}%

**3. Guidance (מבוסס Analyst Estimates):**
- מצב: ${stockData.guidance?.guidance || "unavailable"}
- טרנד: ${stockData.guidance?.guidanceTrend || "neutral"}
- שינוי EPS צפוי: ${stockData.guidance?.estimatedEpsGrowth ? stockData.guidance.estimatedEpsGrowth + '%' : 'N/A'}

**4. YoY Growth:**
- EPS: ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange}%
- Revenue: ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange}%

**5. YoY Revenue:**
- צמיחה: ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange}%

**6. Free Cash Flow:**
- YoY שינוי: ${stockData.yoyFreeCashFlowChange > 0 ? '+' : ''}${stockData.yoyFreeCashFlowChange}%
- מצב: ${stockData.yoyFreeCashFlowChange > 0 ? 'חיובי' : 'שלילי'}

**7. Margins (שולי רווח):**
- Gross Margin: ${stockData.margins?.grossMargin || 'N/A'}%
- Operating Margin: ${stockData.margins?.operatingMargin || 'N/A'}%
- Net Margin: ${stockData.margins?.netMargin || 'N/A'}%
- שינוי Net Margin: ${stockData.margins?.marginChange || 'N/A'}%
- טרנד: ${stockData.margins?.marginTrend || "unknown"}

**8. Sentiment (סנטימנט שוק):**
- מצב: ${stockData.sentiment?.sentiment || "neutral"}
- ציון: ${stockData.sentiment?.sentimentScore || "N/A"}
- טרנד: ${stockData.sentiment?.sentimentTrend || "neutral"}

---

🎯 **בצע את הניתוח לפי שלבים:**

**שלב 1: חשב ניקוד עבור כל פרמטר**

| פרמטר | ערך | ניקוד |
|--------|-----|-------|
| EPS vs תחזית | ${stockData.lastEpsChangePercent}% | ? |
| Revenue vs תחזית | ${stockData.lastRevenueChangePercent}% | ? |
| Guidance | ${stockData.guidance?.guidanceTrend} | ? |
| YoY EPS | ${stockData.yoyEpsChange}% | ? |
| YoY Revenue | ${stockData.yoyRevenueChange}% | ? |
| FCF | ${stockData.yoyFreeCashFlowChange}% | ? |
| Margins | ${stockData.margins?.marginTrend} | ? |
| Sentiment | ${stockData.sentiment?.sentimentTrend} | ? |

**שלב 2: תיקוני בקרה**
בדוק:
- האם EPS וגם Revenue חלשים אבל יש 3+ פרמטרים חזקים? → +1
- האם יש ירידת EPS >20%? → -1
- האם ירידת Margins >2%? → -1
- האם הורדת Guidance? → כבר במערכת הניקוד

**שלב 3: סיווג סופי**
סכום ניקוד → סיווג

---

📝 **התשובה חייבת להיות בפורמט הזה בדיוק:**

📌 סימול: ${stockData.symbol}
🏢 חברה: ${stockData.companyName || stockData.symbol}
📅 תאריך ניתוח: ${new Date().toLocaleDateString('he-IL')}

📊 פרטי דוח:
• EPS: ${stockData.lastEpsActual} מול תחזית ${stockData.lastEpsEstimated} (סטייה ${stockData.lastEpsChangePercent > 0 ? '+' : ''}${stockData.lastEpsChangePercent}%)
• Revenues: $${(stockData.lastRevenueActual / 1_000_000).toFixed(0)}M מול תחזית $${(stockData.lastRevenueEstimated / 1_000_000).toFixed(0)}M (סטייה ${stockData.lastRevenueChangePercent > 0 ? '+' : ''}${stockData.lastRevenueChangePercent}%)
• Guidance: ${stockData.guidance?.guidance === 'unavailable' ? 'לא זמין - נחשב ניטרלי' : stockData.guidance?.guidance}
• Free Cash Flow: ${stockData.yoyFreeCashFlowChange > 0 ? 'חיובי' : 'שלילי'} (YoY: ${stockData.yoyFreeCashFlowChange > 0 ? '+' : ''}${stockData.yoyFreeCashFlowChange}%)
• YoY Growth: EPS ${stockData.yoyEpsChange > 0 ? '+' : ''}${stockData.yoyEpsChange}% | Revenue ${stockData.yoyRevenueChange > 0 ? '+' : ''}${stockData.yoyRevenueChange}%
• שולי רווח: ${stockData.margins?.marginTrend === 'unknown' ? 'לא זמין - נחשב ניטרלי' : `Net ${stockData.margins?.netMargin}% (${stockData.margins?.marginTrend})`}
• סנטימנט: ${stockData.sentiment?.sentiment} (${stockData.sentiment?.sentimentScore || 'N/A'})

⚖️ טבלת ניקוד (הצג חישוב מפורט):

| פרמטר | תוצאה | ניקוד |
|--------|--------|-------|
| EPS vs תחזית | ${stockData.lastEpsChangePercent}% | [חשב לפי כללים] |
| Revenue vs תחזית | ${stockData.lastRevenueChangePercent}% | [חשב לפי כללים] |
| Guidance | ${stockData.guidance?.guidanceTrend} | [חשב לפי כללים] |
| YoY EPS | ${stockData.yoyEpsChange}% | [חשב לפי כללים] |
| YoY Revenue | ${stockData.yoyRevenueChange}% | [חשב לפי כללים] |
| FCF | ${stockData.yoyFreeCashFlowChange}% | [חשב לפי כללים] |
| Margins | ${stockData.margins?.marginTrend} | [חשב לפי כללים] |
| Sentiment | ${stockData.sentiment?.sentimentTrend} | [חשב לפי כללים] |
| **תיקוני בקרה** | [בדוק תנאים] | [+1/0/-1] |
| **סה"כ ניקוד** | | **[סכום מדויק]** |

⚖️ סיווג סופי: [חיובי מאוד מאוד / חיובי מאוד / שלילי]

📈 המלצת מסחר:
כיוון: [LONG 🟢 / SHORT 🔴]
כניסה: $[חשב: current price ± 2%]
יעד ראשון: $[חשב: +5% או -5%]
יעד שני: $[חשב: +15% או -15%]
סטופ לוס: $[חשב: -5% או +5%]
יחס סיכון/סיכוי: 1:3

🧩 שיקול דעת AI:
[כתוב כאן ניתוח איכותי של 3-4 שורות המסביר:
1. מדוע הדוח קיבל את הסיווג הזה (התייחס לניקוד הכולל)
2. נקודות חוזק/חולשה עיקריות (צין פרמטרים ספציפיים)
3. האם Margins/Guidance/Sentiment שיחקו תפקיד משמעותי?
4. המלצה אסטרטגית]

📝 מסקנה:
[סיכום של 2-3 שורות עם המלצה ברורה - קנייה/מכירה/המתנה]

---

**חשוב מאוד:**
- חשב את הניקוד המדויק לפי הטבלה
- אל תשכח לבדוק תיקוני בקרה
- אם Guidance/Margins/Sentiment = unavailable → תן ניקוד 0
- הסבר את החישוב בצורה ברורה
`;

  try {
    logger.info("🤖 Sending PRO 2025 prompt to ChatGPT for advanced analysis");
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // דורש GPT-4 לניתוח מורכב. אם אין גישה, השתמש ב-"gpt-4o-mini"
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3, // נמוך יותר לדיוק רב יותר בניקוד
      max_tokens: 2500,
    });
    
    const answer = completion.choices[0].message.content;
    
    logger.info("✅ AI analysis completed successfully");
    
    return answer || "❌ לא ניתן לקבל תשובה מה-AI";
    
  } catch (error: any) {
    logger.error("❌ OpenAI API error:", error.message);
    throw new Error("Failed to generate text from OpenAI");
  }
}


