import { FullExtractionResponse, MiraScore } from "../types/grok.types";
import logger from '../utils/structureLogger';

export type IntradayClassification = "High" | "Medium" | "Low";

export interface IntradayPotential {
  classification: IntradayClassification;
  score: number;           // 0-6 כמה מדדים חיוביים
  signals: string[];       // פירוט לכל מדד
}
export type TrendClassification = "High" | "Medium" | "Low";

export interface TrendPotential {
  classification: TrendClassification;
  score: number;       // 0-7
  signals: string[];
}


export function calcTrendPotential(data: FullExtractionResponse): TrendPotential {
  let positiveCount = 0;
  const signals: string[] = [];

  // ── Metric 1: Dual Beat (Rev + EPS) ─────────────────────
  const epsBeat = data.eps.beatPercent ?? 0;
  const revBeat = data.revenue.beatPercent ?? 0;
  if (epsBeat > 0 && revBeat > 0) {
    positiveCount++;
    signals.push(`✅ Dual Beat: EPS +${epsBeat.toFixed(1)}% / Rev +${revBeat.toFixed(1)}%`);
  } else {
    signals.push(`❌ Dual Beat: EPS ${epsBeat.toFixed(1)}% / Rev ${revBeat.toFixed(1)}%`);
  }

  // ── Metric 2: Guidance Raised ────────────────────────────
  if (data.guidance.status === "raised") {
    positiveCount++;
    signals.push(`✅ Guidance: raised`);
  } else {
    signals.push(`❌ Guidance: ${data.guidance.status}`);
  }

  // ── Metric 3: Margin Expansion ───────────────────────────
  if (data.margins.trend === "improving") {
    positiveCount++;
    signals.push(`✅ Margin Expansion: improving`);
  } else {
    signals.push(`❌ Margin Expansion: ${data.margins.trend}`);
  }

  // ── Metric 4: Operating Leverage ─────────────────────────
  // Revenue growing + operating margin positive + improving
  const revChange = data.yoyGrowth.revenueChange ?? 0;
  const opMargin = data.margins.operatingMargin ?? 0;
  const marginTrend = data.margins.trend;
  if (revChange > 5 && opMargin > 0 && marginTrend === "improving") {
    positiveCount++;
    signals.push(`✅ Operating Leverage: Rev +${revChange.toFixed(1)}% + Op Margin ${opMargin.toFixed(1)}% improving`);
  } else {
    signals.push(`❌ Operating Leverage: Rev ${revChange.toFixed(1)}% / Op Margin ${opMargin.toFixed(1)}% (${marginTrend})`);
  }

  // ── Metric 5: YoY Acceleration ───────────────────────────
  const currEpsYoY = data.yoyGrowth.epsChange ?? null;
  const currRevYoY = data.yoyGrowth.revenueChange ?? null;
  const prevEpsYoY = data.yoyGrowth.prevQuarterEpsChange ?? null;
  const prevRevYoY = data.yoyGrowth.prevQuarterRevChange ?? null;

  const epsAccelerating =
    currEpsYoY !== null && prevEpsYoY !== null
      ? currEpsYoY > prevEpsYoY
      : null;

  const revAccelerating =
    currRevYoY !== null && prevRevYoY !== null
      ? currRevYoY > prevRevYoY
      : null;

  // Option B: both accelerating = ✅, mixed = ❌, both decelerating = ❌
  if (epsAccelerating === true && revAccelerating === true) {
    positiveCount++;
    signals.push(
      `✅ YoY Acceleration: EPS ${prevEpsYoY?.toFixed(1)}% → ${currEpsYoY?.toFixed(1)}% | Rev ${prevRevYoY?.toFixed(1)}% → ${currRevYoY?.toFixed(1)}%`
    );
  } else if (epsAccelerating === null && revAccelerating === null) {
    signals.push(`➡️ YoY Acceleration: N/A (insufficient data)`);
  } else {
    signals.push(
      `❌ YoY Acceleration: mixed or decelerating — EPS acc:${epsAccelerating} Rev acc:${revAccelerating}`
    );
  }

  // ── Metric 6: FCF Improvement ────────────────────────────
  const fcfChange = data.cashFlow.yoyChange ?? 0;
  if (fcfChange > 0) {
    positiveCount++;
    signals.push(`✅ FCF Improvement: +${fcfChange.toFixed(1)}% YoY`);
  } else {
    signals.push(`❌ FCF Improvement: ${fcfChange.toFixed(1)}% YoY`);
  }

  // ── Metric 7: Buybacks / Capital Return ──────────────────
  const buybacks = data.cashFlow.commonStockRepurchased ?? 0;
  const dividends = data.cashFlow.commonDividendsPaid ?? 0;
  const hasCapitalReturn = buybacks < 0 || dividends < 0;

  if (hasCapitalReturn) {
    const parts: string[] = [];
    if (buybacks < 0) parts.push(`Buybacks $${Math.abs(buybacks / 1e6).toFixed(0)}M`);
    if (dividends < 0) parts.push(`Dividends $${Math.abs(dividends / 1e6).toFixed(0)}M`);
    positiveCount++;
    signals.push(`✅ Capital Return: ${parts.join(" + ")}`);
  } else {
    signals.push(`❌ Capital Return: none`);
  }

  // ── Final Classification ──────────────────────────────────
  const classification: TrendClassification =
    positiveCount >= 6 ? "High"
    : positiveCount >= 4 ? "Medium"
    : "Low";

  logger.info(
    `📈 Trend Potential [${data.symbol}]: ${classification} (${positiveCount}/7 signals)`
  );
  signals.forEach((s) => logger.info(`   ${s}`));

  return { classification, score: positiveCount, signals };
}
export function calculateDetailedScore(data: FullExtractionResponse): MiraScore {
    let totalScore = 0;
    const scoreBreakdown: string[] = [];
    const exceptions: string[] = [];
    let negativeCount = 0;

    // ============================================
    // STEP 1: DYNAMIC SCORING (Updated Weights)
    // ============================================

    // 1. EPS Beat/Miss (±2 points)
    const epsChange = data.eps.beatPercent || 0;
    if (epsChange > 5) { totalScore += 2; scoreBreakdown.push(`EPS Beat ${epsChange.toFixed(1)}% → +2`); }
    else if (epsChange >= 0) { totalScore += 1; scoreBreakdown.push(`EPS Beat ${epsChange.toFixed(1)}% → +1`); }
    else if (epsChange >= -5) { totalScore -= 1; scoreBreakdown.push(`EPS Miss ${epsChange.toFixed(1)}% → -1`); negativeCount++; }
    else { totalScore -= 2; scoreBreakdown.push(`EPS Miss ${epsChange.toFixed(1)}% → -2`); negativeCount++; }

    // 2. Revenue Beat/Miss (±1.5 points)
    const revChange = data.revenue.beatPercent || 0;
    if (revChange > 2) { totalScore += 1.5; scoreBreakdown.push(`Revenue Beat ${revChange.toFixed(1)}% → +1.5`); }
    else if (revChange >= 0) { totalScore += 0.5; scoreBreakdown.push(`Revenue Beat ${revChange.toFixed(1)}% → +0.5`); }
    else if (revChange >= -2) { totalScore -= 0.5; scoreBreakdown.push(`Revenue Miss ${revChange.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1.5; scoreBreakdown.push(`Revenue Miss ${revChange.toFixed(1)}% → -1.5`); negativeCount++; }

    // 3. YoY EPS Growth (±1.5 points)
    const yoyEps = data.yoyGrowth.epsChange || 0;
    if (yoyEps > 10) { totalScore += 1.5; scoreBreakdown.push(`YoY EPS +${yoyEps.toFixed(1)}% → +1.5`); }
    else if (yoyEps > 0) { totalScore += 0.5; scoreBreakdown.push(`YoY EPS +${yoyEps.toFixed(1)}% → +0.5`); }
    else if (yoyEps >= -10) { totalScore -= 0.5; scoreBreakdown.push(`YoY EPS ${yoyEps.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1.5; scoreBreakdown.push(`YoY EPS ${yoyEps.toFixed(1)}% → -1.5`); negativeCount++; }

    // 4. YoY Revenue Growth (±1 point)
    const yoyRev = data.yoyGrowth.revenueChange || 0;
    if (yoyRev > 5) { totalScore += 1; scoreBreakdown.push(`YoY Revenue +${yoyRev.toFixed(1)}% → +1`); }
    else if (yoyRev > 0) { totalScore += 0.5; scoreBreakdown.push(`YoY Revenue +${yoyRev.toFixed(1)}% → +0.5`); }
    else if (yoyRev >= -5) { totalScore -= 0.5; scoreBreakdown.push(`YoY Revenue ${yoyRev.toFixed(1)}% → -0.5`); negativeCount++; }
    else { totalScore -= 1; scoreBreakdown.push(`YoY Revenue ${yoyRev.toFixed(1)}% → -1`); negativeCount++; }

    // 5. Free Cash Flow (±1 point)
    const fcf = data.cashFlow.freeCashFlow || 0;
    const fcfChange = data.cashFlow.yoyChange || 0;
    const fcfPositive = fcf > 0;
    const fcfImproving = fcfChange > 0;

    if (fcfPositive && fcfImproving) { totalScore += 1; scoreBreakdown.push(`FCF positive & improving → +1`); }
    else if (fcfPositive) { totalScore += 0.5; scoreBreakdown.push(`FCF positive → +0.5`); }
    else if (!fcfPositive && fcfChange < 0) { totalScore -= 1; scoreBreakdown.push(`FCF negative & declining → -1`); negativeCount++; }
    else if (fcfChange < 0) { totalScore -= 0.5; scoreBreakdown.push(`FCF declining → -0.5`); negativeCount++; }

    // 6. Margins (±1 point) - Check for >0.5% improvement/decline
    const netMargin = data.margins.netMargin || 0;
    const marginTrend = data.margins.trend || 'stable';

    if (marginTrend === 'improving' && Math.abs(netMargin) > 0.5) {
      totalScore += 1;
      scoreBreakdown.push(`Margins improving (${netMargin.toFixed(1)}%) → +1`);
    } else if (marginTrend === 'declining' && Math.abs(netMargin) > 0.5) {
      totalScore -= 1;
      scoreBreakdown.push(`Margins declining (${netMargin.toFixed(1)}%) → -1`);
      negativeCount++;
    }

    // 7. Guidance (±1.5 points)
    const guidance = data.guidance.status.toLowerCase();
    if (guidance.includes('raised')) { totalScore += 1.5; scoreBreakdown.push(`Guidance raised → +1.5`); }
    else if (guidance.includes('maintained')) { totalScore += 0.5; scoreBreakdown.push(`Guidance maintained → +0.5`); }
    else if (guidance.includes('lowered')) { totalScore -= 1.5; scoreBreakdown.push(`Guidance lowered → -1.5`); negativeCount++; }

    // 8. Sentiment (±0.5 points)
    if (data.sentiment.overall === 'positive') { totalScore += 0.5; scoreBreakdown.push(`Sentiment positive → +0.5`); }
    else if (data.sentiment.overall === 'negative') { totalScore -= 0.5; scoreBreakdown.push(`Sentiment negative → -0.5`); negativeCount++; }



    ///////////////////////////////////////////////////////////////////
    // Priced-In Detector - stage 3
    const pricedInScore = data.hardPreFilter?.pricedInScore ?? null;
    const pricedInClass = data.hardPreFilter?.pricedInClassification ?? null;

    if (pricedInScore !== null) {
      totalScore += pricedInScore;
      if (pricedInScore === -2) {
        scoreBreakdown.push(`Priced-In: Fully (${pricedInClass}) → -2`);
        negativeCount++;
      } else if (pricedInScore === -1) {
        scoreBreakdown.push(`Priced-In: Partially (${pricedInClass}) → -1`);
        negativeCount++;
      } else {
        scoreBreakdown.push(`Priced-In: Not Priced-In → +1`);
      }
    } else {
      scoreBreakdown.push(`Priced-In: N/A (נתונים חסרים) → 0`);
    }
    // Stage 4: Sector Heat Check
    const sectorHeatScore = data.hardPreFilter?.sectorHeatScore ?? null;
    const sectorHeatClass = data.hardPreFilter?.sectorHeatClassification ?? null;

    if (sectorHeatScore !== null) {
      totalScore += sectorHeatScore;
      if (sectorHeatScore === 1) {
        scoreBreakdown.push(`Sector Heat: 🔥 Hot → +1`);
      } else if (sectorHeatScore === -1.5) {
        scoreBreakdown.push(`Sector Heat: ❄️ Cold → -1.5`);
        negativeCount++;
      } else {
        scoreBreakdown.push(`Sector Heat: Neutral → 0`);
      }
    } else {
      scoreBreakdown.push(`Sector Heat: N/A → 0`);
    }
    // ============================================
    // STEP 2: SMART EXCEPTION LAYER
    // ============================================

    // Exception 1: Mixed Signal Override
    if (epsChange > 20 && revChange < -10) {
      totalScore -= 1;
      exceptions.push(`🔄 Mixed Signal: Strong EPS beat (+${epsChange.toFixed(1)}%) but revenue miss (${revChange.toFixed(1)}%) → -1`);
    }

    // Exception 2: Cash Flow Priority
    if (fcfChange > 100) {
      totalScore += 0.5;
      exceptions.push(`💰 Exceptional FCF growth (+${fcfChange.toFixed(1)}%) → +0.5`);
    }

    // Exception 3: Margin Collapse
    if (netMargin < -3) {
      totalScore -= 1;
      exceptions.push(`📉 Margin collapse (${netMargin.toFixed(1)}%) → -1`);
    }

    // Exception 4: Guidance Domination
    if (guidance.includes('raised')) {
      totalScore += 0.5;
      exceptions.push(`📈 Guidance raised (dominant signal) → +0.5`);
    }

    // Exception 5: Automatic Negative Override (6+ negative signals)
    if (negativeCount >= 6) {
      exceptions.push(`⚠️ AUTO-NEGATIVE: ${negativeCount} negative signals detected`);
    }

    // Exception 6: Strong EPS+Revenue Beat
    if (epsChange > 10 && revChange > 10) {
      exceptions.push(`🚀 Strong dual beat: EPS +${epsChange.toFixed(1)}%, Rev +${revChange.toFixed(1)}%`);
      // Force minimum POSITIVE classification (applied below)
    }

    // Exception 7: FCF Margin Protection
    if (fcfChange < 0 && marginTrend === 'improving') {
      // Limit FCF penalty to -0.5 max
      const fcfPenalty = scoreBreakdown.find(s => s.includes('FCF') && s.includes('-1'));
      if (fcfPenalty) {
        totalScore += 0.5; // Reduce penalty from -1 to -0.5
        exceptions.push(`🛡️ FCF declining but margins improving → penalty limited to -0.5`);
      }
    }

    // ============================================
    // STEP 3: FINAL CLASSIFICATION
    // ============================================

    let classification = "NEUTRAL";

    // Base classification
    if (totalScore >= 5) classification = "VERY_POSITIVE";
    else if (totalScore >= 2) classification = "POSITIVE";
    else if (totalScore <= -5) classification = "VERY_NEGATIVE";
    else if (totalScore <= -2) classification = "NEGATIVE";

    // Exception overrides
    if (negativeCount >= 6) {
      classification = "NEGATIVE";
    }

    if (epsChange > 10 && revChange > 10) {
      if (classification === "NEUTRAL" || classification === "NEGATIVE") {
        classification = "POSITIVE"; // Force positive for strong dual beat
      }
    }

    return {
        totalScore: Math.round(totalScore * 100) / 100, // Round to 2 decimals
        classification,
        breakdown: {
          epsScore: epsChange,
          revenueScore: revChange,
          guidanceScore: guidance.includes('raised') ? 1.5 : guidance.includes('lowered') ? -1.5 : 0,
          yoyEpsScore: yoyEps,
          yoyRevenueScore: yoyRev,
          fcfScore: fcfChange,
          marginScore: netMargin,
          sentimentScore: data.sentiment.overall === 'positive' ? 0.5 : data.sentiment.overall === 'negative' ? -0.5 : 0
        },
        exceptions
    };
}
export function calculateTradeParams(price: number, classification: string) {
    const safePrice = price || 0;

    // אין מחיר
    if (safePrice === 0 || !safePrice) {
        logger.warn(`⚠️ Cannot calculate trade params - price is invalid: ${price}`);
        const isLong  = classification === "POSITIVE"  || classification === "VERY_POSITIVE";
        const isShort = classification === "NEGATIVE"  || classification === "VERY_NEGATIVE";
        return {
            direction: isLong ? "LONG 🟢" : isShort ? "SHORT 🔴" : "NEUTRAL ⚪",
            entryPrice: 0, targetPrice: 0, stopPrice: 0,
            hasPriceData: false
        };
    }

    // LONG — חיובי או חיובי מאוד
    if (classification === "POSITIVE" || classification === "VERY_POSITIVE") {
        return {
            direction: "LONG 🟢",
            entryPrice:  Number((safePrice * 0.98).toFixed(2)),
            targetPrice: Number((safePrice * 1.05).toFixed(2)),
            stopPrice:   Number((safePrice * 0.95).toFixed(2)),
            hasPriceData: true
        };
    }

    // SHORT — שלילי או שלילי מאוד
    if (classification === "NEGATIVE" || classification === "VERY_NEGATIVE") {
        return {
            direction: "SHORT 🔴",
            entryPrice:  Number((safePrice * 1.02).toFixed(2)),
            targetPrice: Number((safePrice * 0.95).toFixed(2)),
            stopPrice:   Number((safePrice * 1.05).toFixed(2)),
            hasPriceData: true
        };
    }

    // NEUTRAL
    return {
        direction: "NEUTRAL ⚪",
        entryPrice:  Number(safePrice.toFixed(2)),
        targetPrice: Number((safePrice * 1.03).toFixed(2)),
        stopPrice:   Number((safePrice * 0.97).toFixed(2)),
        hasPriceData: true
    };
}


export function calcIntradayPotential(data: FullExtractionResponse): IntradayPotential {
  let positiveCount = 0;
  const signals: string[] = [];

  // ── מדד 1: EPS Surprise Size ─────────────────────────────
  const epsBeat = data.eps.beatPercent ?? 0;
  if (epsBeat > 5) {
    positiveCount++;
    signals.push(`✅ EPS Surprise: +${epsBeat.toFixed(1)}%`);
  } else {
    signals.push(`❌ EPS Surprise: ${epsBeat.toFixed(1)}%`);
  }

  // ── מדד 2: Margin Surprise ───────────────────────────────
  const marginTrend = data.margins.trend;
  if (marginTrend === "improving") {
    positiveCount++;
    signals.push(`✅ Margin Surprise: improving`);
  } else {
    signals.push(`❌ Margin Surprise: ${marginTrend}`);
  }

  // ── מדד 3: Guidance Delta ────────────────────────────────
  const guidance = data.guidance.status;
  if (guidance === "raised") {
    positiveCount++;
    signals.push(`✅ Guidance: raised`);
  } else {
    signals.push(`❌ Guidance: ${guidance}`);
  }

  // ── מדד 4: FCF Shift ─────────────────────────────────────
  const fcfChange = data.cashFlow.yoyChange ?? 0;
  if (fcfChange > 0) {
    positiveCount++;
    signals.push(`✅ FCF Shift: +${fcfChange.toFixed(1)}% YoY`);
  } else {
    signals.push(`❌ FCF Shift: ${fcfChange.toFixed(1)}% YoY`);
  }

  // ── מדד 5: Volume Spike ──────────────────────────────────
  const volumeRatio = data.hardPreFilter?.volumeRatio ?? 0;
  if (volumeRatio > 1.5) {
    positiveCount++;
    signals.push(`✅ Volume Spike: ×${volumeRatio.toFixed(1)}`);
  } else {
    signals.push(`❌ Volume Spike: ×${volumeRatio.toFixed(1)}`);
  }

  // ── מדד 6: AH Reaction ───────────────────────────────────
  const ahChange = data.hardPreFilter?.ahChangePercent ?? 0;
  if (ahChange > 2) {
    positiveCount++;
    signals.push(`✅ AH Reaction: +${ahChange.toFixed(1)}%`);
  } else {
    signals.push(`❌ AH Reaction: ${ahChange.toFixed(1)}%`);
  }

  // ── סיווג סופי ───────────────────────────────────────────
  const classification: IntradayClassification =
    positiveCount >= 5 ? "High"
    : positiveCount >= 3 ? "Medium"
    : "Low";

  logger.info(
    `⚡ Intraday Potential [${data.symbol}]: ${classification} (${positiveCount}/6 signals)`
  );
  signals.forEach(s => logger.info(`   ${s}`));

  return { classification, score: positiveCount, signals };
}
