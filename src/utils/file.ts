import fs from "fs";
import path from "path";
import logger from "./logger";

export const saveFile = (fileName: string, content: object): void => {
  const filePath = path.join(__dirname, "..", "data", fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
};
export const readFile = (fileName: string): object => {
  const filePath = path.join(__dirname, "..", "data", fileName);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};
