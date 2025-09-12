import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import logger from "../utils/logger";
import { StockData } from "../types";

dotenv.config({ quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN as string;
const bot = new TelegramBot(token, { polling: true });

logger.info("Telegram bot initialized");

bot.on("message", (msg) => {
  logger.info(`Incoming message chat ID: ${msg.chat.id}`);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Hello ${msg.from?.first_name}! I'm your bot 👋`
  );
});

export async function sendTelegramMessage(
  stockData: StockData | any
): Promise<void> {
  const message = stockData.aiSummery;
  const id = process.env.TELEGRAM_CHAT_ID;
  if (!id) {
    throw new Error("No Telegram chat ID provided");
  }
  logger.info(`Sending Telegram message to chat ID ${id}`);

  await bot.sendMessage(id, message);
}
