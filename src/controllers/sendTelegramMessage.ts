import { Request, Response } from "express";
import logger from "../utils/logger";

export const notifyTelegram = async (req: Request, res: Response) => {
  const { message, chatId } = { message: "test", chatId: "5349523318" };

  logger.info(
    `Received request to send Telegram message ${message} to chatId: ${chatId}`
  );
  if (!message) {
    return res.status(400).json({ message: "Message is required" });
  }

  try {
    res.status(200).json({ message: "Message sent to Telegram" });
  } catch (err: any) {
    console.error("Telegram error:", err.message);
    res.status(500).json({ message: "Failed to send Telegram message" });
  }
};
