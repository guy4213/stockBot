import axios from "axios";
import logger from "../utils/logger";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const apiKey = process.env.FMP_API_KEY;

// 🔹 שני Base URLs שונים
const stableBaseUrl = "https://financialmodelingprep.com/stable";
const apiBaseUrl = "https://financialmodelingprep.com/api/v3";

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

// 🆕 NEW: שליפת נתוני שוק - Market Cap, Volume, Price
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