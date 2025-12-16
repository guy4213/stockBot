# Grok Service - Deployment Guide

## 📋 Table of Contents
1. [Overview](#overview)
2. [Key Improvements](#key-improvements)
3. [Architecture](#architecture)
4. [Environment Setup](#environment-setup)
5. [AWS Lambda Deployment](#aws-lambda-deployment)
6. [Alternative Deployments](#alternative-deployments)
7. [Monitoring & Logging](#monitoring--logging)
8. [Cost Optimization](#cost-optimization)
9. [Troubleshooting](#troubleshooting)

---

## 🎯 Overview

The optimized Grok service provides automated earnings report extraction with:
- **Sequential processing** - One stock at a time to avoid rate limits
- **Scheduled checks** - Every 5-10 minutes to detect new reports
- **Targeted searches** - Direct IR site access for faster data retrieval
- **Smart retries** - Exponential backoff for API failures
- **State management** - Track progress across multiple stocks

---

## ✨ Key Improvements

### Before (Original Code)
❌ Batch processing causing rate limits
❌ No systematic checking schedule
❌ Generic searches leading to incomplete data
❌ Limited error handling
❌ No progress tracking

### After (Optimized Code)
✅ Sequential processing with delays
✅ Scheduled checks every 5 minutes
✅ Targeted IR searches with fallbacks
✅ Exponential backoff retry logic
✅ Full state management with callbacks

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Morning Intelligence                      │
│         (Run once at market open - get stock list)          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   Stock Processor                            │
│              (Manages state & scheduling)                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────┴────────────┐
        │   Every 5 minutes        │
        └────────────┬────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  For each stock sequentially (with 2-min delay between):    │
│                                                              │
│  1. Mini-Check → Is report published? (YES/NO/UNSURE)       │
│     │                                                        │
│     ├─ YES → Continue                                       │
│     ├─ NO → Wait for next cycle                             │
│     └─ UNSURE → Wait for next cycle                         │
│                                                              │
│  2. Full Extraction → Get financial data from IR site       │
│     │                                                        │
│     └─ Target: IR website → SEC EDGAR → News sites          │
│                                                              │
│  3. Final Analysis → Generate Hebrew analysis               │
│     │                                                        │
│     └─ Calculate Mira Score → Trading recommendation        │
│                                                              │
│  4. Callback → Send to Telegram                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Environment Setup

### Required Environment Variables

Create a `.env` file:

```bash
# Grok API (xAI)
GROK_API_KEY=xai-your-api-key-here

# Optional: Telegram (for sending results)
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# Optional: Logging
LOG_LEVEL=info
NODE_ENV=production
```

### Install Dependencies

```bash
npm install axios dotenv winston

# Type definitions
npm install --save-dev @types/node
```

---

## ☁️ AWS Lambda Deployment

### Option 1: Lambda + EventBridge (Recommended)

This setup runs the service as a scheduled Lambda function.

#### Step 1: Prepare Lambda Package

Create a `lambda.ts` handler:

```typescript
// src/lambda/earningsHandler.ts
import { Context, ScheduledEvent } from 'aws-lambda';
import { dailyEarningsWorkflow } from '../examples/grokServiceUsage';
import logger from '../utils/logger';

export const handler = async (event: ScheduledEvent, context: Context) => {
  logger.info('📋 Lambda function started');
  logger.info('Event:', JSON.stringify(event, null, 2));

  try {
    // Get today's date
    const date = new Date().toISOString().split('T')[0];

    // Run the workflow
    await dailyEarningsWorkflow(date);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Workflow completed successfully' }),
    };
  } catch (error) {
    logger.error('❌ Lambda execution failed:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Workflow failed', details: error }),
    };
  }
};
```

#### Step 2: Build and Package

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Create deployment package
cd dist
zip -r ../lambda-deployment.zip .
cd ..

# Add node_modules (without dev dependencies)
npm install --production
zip -r lambda-deployment.zip node_modules
```

#### Step 3: Create Lambda Function

```bash
# Create execution role
aws iam create-role \
  --role-name GrokEarningsLambdaRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach basic execution policy
aws iam attach-role-policy \
  --role-name GrokEarningsLambdaRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Create Lambda function
aws lambda create-function \
  --function-name grok-earnings-processor \
  --runtime nodejs18.x \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/GrokEarningsLambdaRole \
  --handler lambda/earningsHandler.handler \
  --zip-file fileb://lambda-deployment.zip \
  --timeout 900 \
  --memory-size 512 \
  --environment Variables="{GROK_API_KEY=xai-your-key-here}"
```

#### Step 4: Schedule with EventBridge

```bash
# Create EventBridge rule (run every 5 minutes during market hours)
aws events put-rule \
  --name grok-earnings-schedule \
  --schedule-expression "cron(0/5 9-17 ? * MON-FRI *)" \
  --description "Check earnings every 5 minutes during market hours"

# Add Lambda permission
aws lambda add-permission \
  --function-name grok-earnings-processor \
  --statement-id AllowEventBridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:us-east-1:YOUR_ACCOUNT_ID:rule/grok-earnings-schedule

# Connect rule to Lambda
aws events put-targets \
  --rule grok-earnings-schedule \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:grok-earnings-processor"
```

### Option 2: Lambda with Step Functions (Advanced)

For better orchestration and error handling:

```yaml
# stepfunctions-definition.json
{
  "Comment": "Earnings Report Processing Workflow",
  "StartAt": "MorningIntelligence",
  "States": {
    "MorningIntelligence": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:morning-intelligence",
      "Next": "ProcessStocks",
      "Retry": [{
        "ErrorEquals": ["States.ALL"],
        "IntervalSeconds": 60,
        "MaxAttempts": 3,
        "BackoffRate": 2.0
      }]
    },
    "ProcessStocks": {
      "Type": "Map",
      "ItemsPath": "$.stocks",
      "MaxConcurrency": 1,
      "Iterator": {
        "StartAt": "MiniCheck",
        "States": {
          "MiniCheck": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:mini-check",
            "Next": "CheckResult"
          },
          "CheckResult": {
            "Type": "Choice",
            "Choices": [{
              "Variable": "$.result",
              "StringEquals": "YES",
              "Next": "FullExtraction"
            }],
            "Default": "WaitAndRetry"
          },
          "FullExtraction": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:full-extraction",
            "Next": "FinalAnalysis"
          },
          "FinalAnalysis": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:final-analysis",
            "Next": "SendToTelegram"
          },
          "SendToTelegram": {
            "Type": "Task",
            "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:send-telegram",
            "End": true
          },
          "WaitAndRetry": {
            "Type": "Wait",
            "Seconds": 300,
            "Next": "MiniCheck"
          }
        }
      },
      "End": true
    }
  }
}
```

---

## 🚀 Alternative Deployments

### Docker Container (EC2, ECS, or local)

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --production

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Set environment
ENV NODE_ENV=production

# Run the service
CMD ["node", "dist/examples/grokServiceUsage.js"]
```

Build and run:

```bash
# Build image
docker build -t grok-earnings-service .

# Run container
docker run -d \
  --name grok-earnings \
  --env-file .env \
  --restart unless-stopped \
  grok-earnings-service
```

### Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grok-earnings-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grok-earnings
  template:
    metadata:
      labels:
        app: grok-earnings
    spec:
      containers:
      - name: grok-earnings
        image: your-registry/grok-earnings-service:latest
        env:
        - name: GROK_API_KEY
          valueFrom:
            secretKeyRef:
              name: grok-secrets
              key: api-key
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: grok-earnings-cron
spec:
  schedule: "*/5 9-17 * * 1-5"  # Every 5 min, 9am-5pm, Mon-Fri
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: grok-earnings
            image: your-registry/grok-earnings-service:latest
            env:
            - name: GROK_API_KEY
              valueFrom:
                secretKeyRef:
                  name: grok-secrets
                  key: api-key
          restartPolicy: OnFailure
```

### PM2 (Process Manager for Node.js)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'grok-earnings-service',
    script: './dist/examples/grokServiceUsage.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    cron_restart: '0 6 * * 1-5'  // Restart daily at 6am weekdays
  }]
};
```

Run with PM2:

```bash
# Install PM2
npm install -g pm2

# Start service
pm2 start ecosystem.config.js

# Monitor
pm2 monit

# View logs
pm2 logs grok-earnings-service

# Stop service
pm2 stop grok-earnings-service
```

---

## 📊 Monitoring & Logging

### CloudWatch Logs (AWS)

```typescript
// Add CloudWatch logging
import CloudWatchLogs from 'aws-sdk/clients/cloudwatchlogs';

const cloudwatch = new CloudWatchLogs({ region: 'us-east-1' });

async function logToCloudWatch(message: string, level: string) {
  await cloudwatch.putLogEvents({
    logGroupName: '/aws/lambda/grok-earnings-processor',
    logStreamName: new Date().toISOString().split('T')[0],
    logEvents: [{
      message: JSON.stringify({ level, message, timestamp: Date.now() }),
      timestamp: Date.now()
    }]
  }).promise();
}
```

### Custom Metrics

```typescript
// Track key metrics
import { CloudWatch } from 'aws-sdk';

const cloudwatch = new CloudWatch({ region: 'us-east-1' });

async function publishMetric(name: string, value: number) {
  await cloudwatch.putMetricData({
    Namespace: 'GrokEarnings',
    MetricData: [{
      MetricName: name,
      Value: value,
      Unit: 'Count',
      Timestamp: new Date()
    }]
  }).promise();
}

// Usage
await publishMetric('StocksProcessed', 1);
await publishMetric('APIErrors', 1);
await publishMetric('ProcessingTimeMs', duration);
```

---

## 💰 Cost Optimization

### Grok API Costs

With **grok-4-fast-reasoning** (97% cheaper than grok-3):

| Operation | Tokens | Cost/Call | Daily (50 stocks) |
|-----------|--------|-----------|-------------------|
| Morning Intelligence | ~6,000 | $0.01 | $0.01 |
| Mini-Check (per stock) | ~50 | $0.0001 | $0.02 |
| Full Extraction | ~4,000 | $0.008 | $0.40 |
| Final Analysis | ~2,000 | $0.004 | $0.20 |
| **Total Daily** | | | **~$0.63/day** |

**Monthly**: ~$18.90
**Yearly**: ~$229.95

### AWS Lambda Costs

| Resource | Usage | Cost/Month |
|----------|-------|------------|
| Lambda execution | 288 invocations/day × 30s avg | $0.20 |
| EventBridge | 288 events/day | $0.00 |
| CloudWatch Logs | 10 GB/month | $0.50 |
| **Total AWS** | | **$0.70/month** |

**Grand Total**: ~$19.60/month (~$235/year)

### Optimization Tips

1. **Use grok-4-fast-reasoning** - 97% cheaper than grok-3
2. **Cache market cap data** - Avoid repeated lookups
3. **Reduce check frequency** - 10 min intervals instead of 5 min
4. **Filter stocks earlier** - Apply market cap/volume filters before API calls
5. **Batch similar operations** - Group non-time-sensitive tasks

---

## 🔧 Troubleshooting

### Common Issues

#### 1. Rate Limit Errors (429)

**Solution**: The code already handles this with exponential backoff. If persisting:

```typescript
// Increase delays
const DELAY_BETWEEN_STOCKS_MS = 5 * 60 * 1000; // 5 minutes instead of 2
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes instead of 5
```

#### 2. Timeout Errors

**Solution**: Increase Lambda timeout:

```bash
aws lambda update-function-configuration \
  --function-name grok-earnings-processor \
  --timeout 900  # 15 minutes
```

#### 3. Incomplete Data

**Solution**: Check the AI recommendation decision:

```typescript
if (fullData.aiRecommendation.decision === "WAIT") {
  // Data not complete yet, will retry
  logger.info(`Data incomplete for ${symbol}, will check again`);
}
```

#### 4. Missing Environment Variables

**Solution**: Verify .env file or Lambda environment:

```bash
# Check Lambda environment variables
aws lambda get-function-configuration \
  --function-name grok-earnings-processor \
  --query 'Environment'
```

#### 5. JSON Parse Errors

**Solution**: The code includes JSON extraction logic. If issues persist:

```typescript
// Enable debug logging
logger.info(`Raw response: ${response.substring(0, 500)}`);
```

---

## 📞 Support & Resources

- **Grok API Docs**: https://x.ai/docs
- **AWS Lambda Docs**: https://docs.aws.amazon.com/lambda/
- **Winston Logger**: https://github.com/winstonjs/winston
- **TypeScript**: https://www.typescriptlang.org/docs/

---

## 🎉 Summary

The optimized Grok service provides:

✅ **Sequential processing** - No more rate limit issues
✅ **Scheduled checks** - Automatic report detection
✅ **Targeted searches** - Faster, more accurate data
✅ **Smart retries** - Handles API failures gracefully
✅ **State management** - Track progress across stocks
✅ **Cost efficient** - ~$20/month for 50 stocks daily
✅ **Production ready** - Comprehensive error handling
✅ **Easy deployment** - Multiple platform options

Happy trading! 🚀📈
