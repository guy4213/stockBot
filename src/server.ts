import logger from "./utils/logger";
logger.info("------------------------------------------");
import app from "./app";
import dotenv from "dotenv";
dotenv.config({ quiet: true });
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
