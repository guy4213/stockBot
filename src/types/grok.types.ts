// ============================================
// GROK SERVICE TYPE DEFINITIONS
// ============================================

// ============================================
// Grok API Types
// ============================================

export interface GrokMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GrokRequest {
  model: string;
  messages: GrokMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  search_parameters?: {
    mode: "auto" | "always" | "never";
    return_citations?: boolean;
    max_search_results?: number;
  };
}

export interface GrokUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  num_sources_used?: number;
}

export interface GrokChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

export interface GrokResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: GrokChoice[];
  usage: GrokUsage;
}

// ============================================
// Morning Intelligence Types
// ============================================

// types/grok.types.ts

export interface Stock {
  symbol: string;
  companyName: string;
  reportType: "BMO" | "AMC";
  windowStart: string;
  windowEnd: string;
  marketCap: number;
  volume: number;
  confidence: number;
  sources: string[];
  quarter?: number;
  fiscalYear?: number;
  sentToTelegram?: boolean;  // ✅ Track if sent (persisted in JSON)
  // ✅ הוסף את זה
  finnhubData?: {
    epsActual: number | null|undefined;
    epsEstimate: number | null|undefined;
    revenueActual: number | null;
    revenueEstimate: number | null;
  };
}

export interface MorningIntelligenceResponse {
  date: string;
  stocks: Stock[];
}

// ============================================
// Mini-Check Types
// ============================================

export type MiniCheckResult = "YES" | "NO" | "UNSURE";

export interface MiniCheckResponse {
  symbol: string;
  checkTime: string;
  result: MiniCheckResult;
}

// ============================================
// Full Extraction Types
// ============================================

export interface MarketData {
  price: number|null ;
  marketCap: number | null;
  volume: number | null;
  source: string;
}

export interface EPS {
  actual: number | null;
  estimate: number | null;
  beat: number | null;
  beatPercent: number | null;
  source: string;
}

export interface Revenue {
  actual: number ;
  estimate: number ;
  beat: number | null;
  beatPercent: number | null;
  source: string;
}

export interface YoYGrowth {
  epsChange: number | null;
  revenueChange: number | null;
  revenueChangeType?: "quarterly" | "TTM";  // Type of revenue comparison
}

export interface CashFlow {
  freeCashFlow: number | null;
  yoyChange: number | null;
}

export interface Margins {
  netMargin: number | null;
  operatingMargin: number | null;
  trend: string;
  isEfficiencyRatio?: boolean; 
}

export interface Guidance {
  status: "raised" | "maintained" | "lowered" | "unavailable";
  details: string | null;  
}

export interface Sentiment {
  overall: "positive" | "neutral" | "negative";
  reasoning: string | null; 
}

export interface DataQuality {
  completeness: number; // 0-100
  confidence: number; // 0-100
  crossValidated: boolean;
  sources: string[];
}

export interface AIRecommendation {
  decision: "SEND" | "SEND_WITH_WARNING" | "WAIT" | "NOT_PUBLISHED_YET";
  reasoning: string;
}

export interface FullExtractionResponse {
  symbol: string;
  companyName: string;
  reportDate: string;
  reportTime: string;
  marketData: MarketData;
  eps: EPS;
  isEfficiencyRatio? : boolean; 
  revenue: Revenue;
  yoyGrowth: YoYGrowth;
  cashFlow: CashFlow;
  margins: Margins;
  guidance: Guidance;
  sentiment: Sentiment;
  highlights: string[];
  concerns: string[];
  managementCommentary: string | null;
  dataQuality: DataQuality;
  aiRecommendation: AIRecommendation;
}

// ============================================
// Mira Score Types
// ============================================

export interface MiraScoreBreakdown {
  epsScore: number;
  revenueScore: number;
  guidanceScore: number;
  yoyEpsScore: number;
  yoyRevenueScore: number;
  fcfScore: number;
  marginScore: number;
  sentimentScore: number;
}

export interface MiraScore {
  totalScore: number;
  classification: string;
  breakdown: MiraScoreBreakdown;
  exceptions: string[];
}

// ============================================
// Final Analysis Types
// ============================================

export interface TradingRecommendation {
  direction: string;
  entryPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
}

export interface FinalAnalysis {
  symbol: string;
  date: string;
  summary: string; // Hebrew formatted message
  miraScore: MiraScore;
  tradingRecommendation: TradingRecommendation;
  aiReasoning: string;
  conclusion: string;
  dataSources: string[];
  confidence: number;
}

// ============================================
// Stock Processing State Types
// ============================================

export type ProcessingStatus =
  | "pending"      // Not yet checked
  | "checking"     // Checking if report is published
  | "extracting"   // Extracting full data
  | "completed"    // Successfully completed
  | "error";       // Error occurred

export interface StockProcessingState {
  symbol: string;
  companyName: string;
  reportType: "BMO" | "AMC";
  windowStart: string;
  windowEnd: string;
  marketCap: number;
  volume: number;
  status: ProcessingStatus;
  lastCheck: string | null;
  checkCount: number;
  error: string | null;
  fullData: FullExtractionResponse | null;
  analysis: FinalAnalysis | null;
  sentToTelegram: boolean;  // ✅ Track if already sent to Telegram
}
