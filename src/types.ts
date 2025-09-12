export interface StockData {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  epsChangePercent: string | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  revenueChangePercent: string | null;
  operatingCashFlow: number;
  freeCashFlow: number;
  aiSummery: string;
  // eps: number;
  // revenue: string;
  // cashFlow: number;
  // forecasts: number;
  // marketReaction: number;
}
// export interface StockData {
//   symbol: string;
//   date: string;
//   epsActual: number | null;
//   epsEstimated: number | null;
//   epsChangePercent: string | null;
//   revenueActual: number | null;
//   revenueEstimated: number | null;
//   revenueChangePercent: string | null;
//   operatingCashFlow: number;
//   freeCashFlow: number;
//   aiSummery: string;
//   // eps: number;
//   // revenue: string;
//   // cashFlow: number;
//   // forecasts: number;
//   // marketReaction: number;
// }
