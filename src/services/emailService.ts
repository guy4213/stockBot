import nodemailer from "nodemailer";
import dotenv from "dotenv";
import logger from "../utils/logger";
import { StockData } from "../types";

dotenv.config({ quiet: true });

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GOOGLE_APP_EMAIL,
    pass: process.env.GOOGLE_APP_PASSWORD,
  },
});

export async function sendEmail(stockData: any | StockData): Promise<void> {
  const emailTo = process.env.EMAIL_TO;

  if (!emailTo) {
    throw new Error("No email address provided");
  }

  const emailSubject = `Earnings Report for ${stockData.symbol}`;
  const emailBody = `
  <div style='direction: rtl; font-family: Arial, sans-serif;'>
  <h1>Earnings Report for ${stockData.symbol}</h1>
  <p>
  ${stockData.aiSummery.replaceAll("\n", "<br>")}
  </p>
  </div>
  `;
  logger.info(`Sending email to ${emailTo}`);

  //-------------------------------------------
  const info = await transporter.sendMail({
    from: process.env.GOOGLE_APP_EMAIL || "Earnings Bot ",
    to: emailTo,
    subject: emailSubject,
    html: emailBody,
  });
  //-------------------------------------------
}
