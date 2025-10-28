import axios from "axios";
import logger from "../utils/logger";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const apiKey = process.env.FMP_API_KEY;

// 🔹 שני Base URLs שונים
const stableBaseUrl = "https://financialmodelingprep.com/stable";
const apiBaseUrl = "https://financialmodelingprep.com/api/v3";
const apiV4BaseUrl = "https://financialmodelingprep.com/api/v4";

export type EarningRes = {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  lastUpdated: string;
};

export const getEarningsCalendar = async (
  startDate: string,
  endDate: string
) => {
  try {
    const url = `${stableBaseUrl}/earnings-calendar?from=${startDate}&to=${endDate}&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getEarningsCalendar error:" + e);
  }
};

export const getEarnings = async (symbol: string) => {
  try {
    const url = `${stableBaseUrl}/earnings?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data as EarningRes[];
  } catch (e) {
    logger.error("getEarnings error:" + e);
  }
};

export const getCashFlow = async (symbol: string) => {
  try {
    const url = `${stableBaseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getCashFlow error:" + e);
  }
};

export const getQuote = async (symbol: string) => {
  try {
    const url = `${apiBaseUrl}/quote/${symbol}?apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No quote data for ${symbol}`);
      return null;
    }
    
    const quote = response.data[0];
    
    return {
      symbol: quote.symbol,
      name: quote.name,
      price: quote.price,
      marketCap: quote.marketCap,
      avgVolume: quote.avgVolume,
      volume: quote.volume,
      change: quote.change,
      changesPercentage: quote.changesPercentage,
      eps: quote.eps,
      pe: quote.pe,
    };
  } catch (e) {
    logger.error(`getQuote error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Income Statement למאר Margins
export const getIncomeStatement = async (symbol: string) => {
  try {
    const url = `${apiBaseUrl}/income-statement/${symbol}?period=quarter&limit=5&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No income statement data for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getIncomeStatement error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Analyst Estimates (כקירוב ל-Guidance)
export const getAnalystEstimates = async (symbol: string) => {
  try {
    const url = `${apiBaseUrl}/analyst-estimates/${symbol}?period=quarter&limit=2&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No analyst estimates for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getAnalystEstimates error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Social Sentiment
export const getSocialSentiment = async (symbol: string) => {
  try {
    const url = `${apiV4BaseUrl}/social-sentiment?symbol=${symbol}&limit=5&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No social sentiment data for ${symbol}`);
      return null;
    }
    
    return response.data;
  } catch (e) {
    logger.error(`getSocialSentiment error for ${symbol}:`, e);
    return null;
  }
};

// 🆕 NEW: שליפת Earnings Call Transcript (אופציונלי - כבד!)
export const getEarningsTranscript = async (
  symbol: string,
  quarter: number,
  year: number
) => {
  try {
    const url = `${apiBaseUrl}/earning_call_transcript/${symbol}?quarter=${quarter}&year=${year}&apikey=${apiKey}`;
    const response = await axios.get(url);
    
    if (!response.data || response.data.length === 0) {
      logger.warn(`No earnings transcript for ${symbol} Q${quarter} ${year}`);
      return null;
    }
    
    return response.data[0];
  } catch (e) {
    logger.error(`getEarningsTranscript error for ${symbol}:`, e);
    return null;
  }
};