import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import logger from "../utils/logger";
import { StockData } from "../types";

dotenv.config({ quiet: true });

const token = process.env.TELEGRAM_BOT_TOKEN as string;
const bot = new TelegramBot(token, { polling: true });

logger.info("Telegram bot initialized");

bot.on("message", (msg) => {
  logger.info(`📨 Incoming message chat ID: ${msg.chat.id}`);
  logger.info(`📋 Chat Type: ${msg.chat.type}`);
  logger.info(`📝 Chat Title: ${msg.chat.title || 'N/A'}`);
  logger.info(`👤 From: ${msg.from?.first_name} (${msg.from?.username || 'no username'})`);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Hello ${msg.from?.first_name}! I'm your bot 👋`
  );
});

bot.onText(/\/chatid/, (msg) => {
  const chatInfo = `
🆔 Chat ID: ${msg.chat.id}
📱 Chat Type: ${msg.chat.type}
${msg.chat.title ? `📋 Chat Title: ${msg.chat.title}` : ''}
${msg.chat.username ? `🔗 Username: @${msg.chat.username}` : ''}

✅ Use this Chat ID in your .env file:
TELEGRAM_CHAT_ID=${msg.chat.id}
  `;
  bot.sendMessage(msg.chat.id, chatInfo);
  logger.info(`📞 Chat ID requested: ${msg.chat.id}`);
});

export async function sendTelegramMessage(
  stockData: StockData | any
): Promise<void> {
  const message = stockData.summary || stockData.aiSummery;
  const id = process.env.TELEGRAM_CHAT_ID;
  if (!id) {
    throw new Error("No Telegram chat ID provided");
  }

  if (!message || message.trim().length === 0) {
    throw new Error(`Cannot send empty message for stock ${stockData.symbol || 'unknown'}`);
  }

  logger.info(`Sending Telegram message to chat ID ${id}`);
  await bot.sendMessage(id, message);
}
