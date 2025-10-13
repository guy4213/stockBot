// import nodemailer from "nodemailer";
// import dotenv from "dotenv";
// import logger from "../utils/logger";
// import { StockData } from "../types";

// dotenv.config({ quiet: true });

// const transporter = nodemailer.createTransport({
//   service: "gmail",
//   auth: {
//     user: process.env.GOOGLE_APP_EMAIL,
//     pass: process.env.GOOGLE_APP_PASSWORD,
//   },
// });

// export async function sendEmail(stockData: any | StockData): Promise<void> {
//   const emailTo = process.env.EMAIL_TO;

//   if (!emailTo) {
//     throw new Error("No email address provided");
//   }

//   const emailSubject = `Earnings Report for ${stockData.symbol}`;
//   const emailBody = `
//   <div style='direction: rtl; font-family: Arial, sans-serif;'>
//   <h1>Earnings Report for ${stockData.symbol}</h1>
//   <p>
//   ${stockData.aiSummery.replaceAll("\n", "<br>")}
//   </p>
//   </div>
//   `;
//   logger.info(`Sending email to ${emailTo}`);

//   //-------------------------------------------
//   const info = await transporter.sendMail({
//     from: process.env.GOOGLE_APP_EMAIL || "Earnings Bot ",
//     to: emailTo,
//     subject: emailSubject,
//     html: emailBody,
//   });
//   //-------------------------------------------
// }


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

  // ✅ FIX 1: Better validation with clear error messages
  if (!emailTo) {
    logger.error("❌ EMAIL_TO is not set in .env");
    throw new Error("EMAIL_TO environment variable is not set");
  }
  
  if (!stockData.aiSummery) {
    logger.error(`❌ No AI summary available for ${stockData.symbol}`);
    throw new Error("No AI summary available to send");
  }

  // ✅ FIX 2: Better subject line with report status emoji
  const statusEmoji = stockData.reportStatus.includes("חיובי") ? "🟢" : "🔴";
  const emailSubject = `${statusEmoji} Earnings Report: ${stockData.symbol} - ${stockData.reportStatus}`;
  
  // ✅ FIX 3: Better HTML formatting with proper line breaks
  const emailBody = `
  <div style='direction: rtl; font-family: Arial, sans-serif; max-width: 800px; padding: 20px;'>
    <h1 style='color: #333;'>📊 Earnings Report</h1>
    <h2 style='color: #666;'>${stockData.companyName || stockData.symbol} (${stockData.symbol})</h2>
    <div style='background: #f5f5f5; padding: 10px; border-radius: 5px; margin: 10px 0;'>
      <strong>סטטוס:</strong> ${stockData.reportStatus}
    </div>
    <hr style='border: 1px solid #ddd; margin: 20px 0;'>
    <div style='white-space: pre-wrap; line-height: 1.6;'>
      ${stockData.aiSummery.replace(/\n/g, "<br>")}
    </div>
  </div>
  `;
  
  logger.info(`📧 Preparing to send email to ${emailTo} for ${stockData.symbol}`);

  try {
    // ✅ FIX 4: Wrap in try-catch with detailed error logging
    const info = await transporter.sendMail({
      from: `"Stock Earnings Bot" <${process.env.GOOGLE_APP_EMAIL}>`, // Better sender name
      to: emailTo,
      subject: emailSubject,
      html: emailBody,
    });
    
    // ✅ FIX 5: Log success with message ID for tracking
    logger.info(`✅ Email sent successfully for ${stockData.symbol}. Message ID: ${info.messageId}`);
    
  } catch (error: any) {
    // ✅ FIX 6: Detailed error logging
    logger.error(`❌ Failed to send email for ${stockData.symbol}:`, {
      error: error.message,
      code: error.code,
      response: error.response
    });
    throw error; // Re-throw so mainController can handle it
  }
}