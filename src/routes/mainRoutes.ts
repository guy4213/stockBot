import { Router } from "express";
import { mainFlow } from "../controllers/mainController";

const router = Router();
router.get("/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  if (!symbol) {
    return res
      .status(400)
      .json({ error: "Symbol query parameter is required" });
  }
  mainFlow(symbol);
  return res.json({ symbol });
});

export default router;
