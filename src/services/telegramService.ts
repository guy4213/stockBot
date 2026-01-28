import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import logger from "../utils/logger";
import { StockData } from "../types";
import fs from "fs";
import path from "path";
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
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    // קרא את הקובץ
    const filePath = path.join(__dirname, "../data/stocksReportingToday.json");
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    
    // בנה הודעה
    const total = data.stocks.length;
    const sent = data.stocks.filter((s: any) => s.sentToTelegram).length;
    const pending = total - sent; // כל מה שלא נשלח
    
    let message = `📊 *Earnings Bot Status*\n\n`;
    message += `📅 Date: ${data.date}\n`;
    message += `📈 Total: ${total}\n`;
    message += `✅ Sent: ${sent}\n`;
    message += `⏳ Pending: ${pending}\n\n`;
    
    // רשימת מניות
    message += `*Stocks:*\n`;
    data.stocks.forEach((s: any) => {
      const emoji = s.sentToTelegram ? '✅' : '⏳';
      const status = s.sentToTelegram ? 'sent' : 'pending';
      message += `${emoji} ${s.symbol} - ${status}\n`;
    });
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
  }
});
export async function sendTelegramMessage(
  stockData: StockData | any
): Promise<void> {
  const message = stockData.summary || stockData.aiSummery;
  const id = process.env.TELEGRAM_CHAT_ID;
  
  if (!id) {
    logger.error("❌ No Telegram chat ID provided");
    throw new Error("No Telegram chat ID provided");
  }

  if (!message || message.trim().length === 0) {
    logger.error(`❌ Cannot send empty message for stock ${stockData.symbol || 'unknown'}`);
    throw new Error(`Cannot send empty message for stock ${stockData.symbol || 'unknown'}`);
  }

  try {
    logger.info(`📤 Sending Telegram message to chat ID ${id} for stock ${stockData.symbol || 'unknown'}`);
    await bot.sendMessage(id, message);
    logger.info(`✅ Telegram message sent successfully to chat ID ${id}`);
  } catch (error) {
    logger.error(`❌ Failed to send Telegram message to chat ID ${id}:`, error);
    throw error;
  }
}