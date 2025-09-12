import logger from "../utils/logger";
import { Request, Response, NextFunction } from "express";

// a middleware that shows the endpoint
// that was called and the time it took to process the request

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(
      `${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`
    );
  });
  next();
};
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // console.error(err.stack);
  logger.error(`Error: ${err.message}`);
  res.status(500).json({ message: err.message });
};
