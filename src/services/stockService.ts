import axios from "axios";
import logger from "../utils/logger";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const apiKey = process.env.FMP_API_KEY;

export type EarningRes = {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  lastUpdated: string;
};

const baseUrl = "https://financialmodelingprep.com/stable";

export const getEarningsCalendar = async (
  startDate: string,
  endDate: string
) => {
  try {
    const url = `${baseUrl}/earnings-calendar?from=${startDate}&to=${endDate}&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getEarningsCalendar error:" + e);
  }
};

export const getEarnings = async (symbol: string) => {
  try {
    const url = `${baseUrl}/earnings?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data as EarningRes[];
  } catch (e) {
    logger.error("getEarnings error:" + e);
  }
};

export const getCashFlow = async (symbol: string) => {
  try {
    const url = `${baseUrl}/cash-flow-statement?symbol=${symbol}&period=quarter&apikey=${apiKey}`;
    const response = await axios.get(url);
    return response.data;
  } catch (e) {
    logger.error("getCashFlow error:" + e);
  }
};
