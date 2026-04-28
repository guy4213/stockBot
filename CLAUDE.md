# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (hot-reload via ts-node-dev)
npm run dev

# Production build (tsc + copies src/data → dist/data)
npm run build

# Run production build
npm start

# Type-check only
npx tsc --noEmit
```

There is no test suite. Validation is done by running the server and checking log output in `src/logs/`.

## Architecture

StockBot is an automated earnings-report analysis bot that delivers trading intelligence to a Telegram channel. Every trading day it:

1. Scrapes Yahoo Finance for that day's earnings reporters (via Playwright, with a cheerio HTML fallback).
2. Filters to US-listed stocks meeting minimum market-cap ($300M) and volume (1M) thresholds.
3. Runs a multi-layer analysis pipeline for each stock and sends a Hebrew-language report to Telegram.

### Request flow

```
app.ts (cron 06:00) → runDailyCheck() → morningIntelligence(date)
    → grokScanEarningsToday()       [Yahoo scrape — grokService.ts]
    → loadUsStocksCache()           [src/data/us_stocks_cache.json]
    → FMP getQuote() per stock      [stockService.ts]
    → StockProcessor.start()        [openRouterService.ts]
        → per stock, when its reporting window opens:
            → runHardPreFilter()        [stockService.ts]  — financial signals
            → findEarningsPdfCandidates() / fetchContentWithJina()
            → Grok AI full extraction   [grokService.ts callGrokAPI()]
            → calculationService.ts     — MiraScore, IntradayPotential, etc.
            → sendTelegramMessage()     [telegramService.ts]
```

### Key files

| File | Purpose |
|---|---|
| `src/app.ts` | Express setup + three cron jobs (06:00 daily run, 3:00 cache refresh, every-30-min safety net) |
| `src/controllers/mainController.ts` | `runDailyCheck()` — orchestrates the day's processing; holds `activeProcessor` singleton |
| `src/services/openRouterService.ts` | `morningIntelligence()`, `StockProcessor` class, OpenRouter API wrapper, IR portal discovery |
| `src/services/grokService.ts` | Yahoo Finance scraping (Playwright + cheerio), `callGrokAPI()`, `findEarningsPdfCandidates()` |
| `src/services/stockService.ts` | All FMP API calls (quotes, earnings, ratios, sector heat, ETF flow), `runHardPreFilter()` |
| `src/services/calculationService.ts` | Pure scoring functions: MiraScore, IntradayPotential, TrendPotential, Supercycle, MarketTruth |
| `src/services/contentExtractor.ts` | Fetches earnings press-release content via Jina Reader |
| `src/services/telegramService.ts` | Telegram bot init, `/status` command, `sendTelegramMessage()` |
| `src/utils/usStocksCache.ts` | Manages `src/data/us_stocks_cache.json` (US stock universe, refreshed every 7 days) |
| `src/data/stocksReportingToday.json` | Live state file for the current day's processing; persisted so restarts resume correctly |
| `src/types/grok.types.ts` | All shared TypeScript interfaces (`Stock`, `FullExtractionResponse`, `MiraScore`, etc.) |

### AI providers

- **Grok (xAI)** — primary AI via `https://api.x.ai/v1/responses`, model `grok-4-fast-reasoning`. Used for: earnings quarter lookup, IR portal verification, earnings PDF discovery (with web_search tool), full extraction analysis.
- **OpenRouter** — secondary AI via `https://openrouter.ai/api/v1/chat/completions`, default model `google/gemini-2.0-flash-001`. Used for IR portal verification (`verifyIRWithFlash`).

### External data APIs

- **FMP (Financial Modeling Prep)** — quotes, earnings history, cash flow, sector performance, analyst estimates. Uses both `/stable` and `/api/v3,v4` endpoints.
- **Finnhub** — earnings calendar, EPS estimates, stock metrics.
- **Serper** — Google search for ETF flow signals and news momentum.
- **Jina Reader** (`r.jina.ai`) — converts earnings press-release URLs to clean text.
- **Yahoo Finance** — scraped (not API) for the daily earnings calendar.

### Required environment variables

```
GROK_API_KEY
OPENROUTER_API_KEY
FMP_API_KEY
FINNHUB_API_KEY
SERPER_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
PORT                 # optional, defaults to 3000
```

### `StockProcessor` scheduling logic

Each stock has a `windowStart`/`windowEnd` (NY time). BMO stocks are checked after market open (around 09:30 ET); AMC stocks after market close (around 16:00 ET). The processor polls every 30 minutes (`CHECK_INTERVAL_MS`) and only processes stocks whose window is active (±3 hours buffer, `WINDOW_BUFFER_HOURS`). A safety-net cron in `app.ts` restarts the processor if `activeProcessor` becomes null.

### State persistence

`src/data/stocksReportingToday.json` is written at the start of each daily run and updated throughout. On restart within the same day, `sentToTelegram` flags and `cachedIRPortal` are restored from this file so stocks already reported are not sent again.
