# 使用例・運用ガイド

## 日次運用フロー

### 1. 自動実行 (Scheduler 有効時)

毎日 9:00 JST に自動実行される場合の流れ:

```
EventBridge Scheduler (9:00 JST)
  ↓
Lambda 実行 (前日分の株価取得)
  ↓
S3 Raw バケットに CSV 保存
  ↓ (S3 Event - 有効化時)
Glue Job 自動実行
  ↓
S3 Processed バケットに Parquet 保存
  ↓
Glue Crawler (週次実行推奨)
  ↓
Athena でクエリ可能
```

### 2. 手動実行 (学習・開発時)

```bash
# 1. Lambda で株価データ取得
aws lambda invoke \
    --function-name FetchStockDataFunction \
    --payload '{}' \
    response.json

# 2. Glue Job で変換
aws glue start-job-run \
    --job-name stock-data-csv-to-parquet

# 3. Crawler でカタログ更新
aws glue start-crawler \
    --name stock-data-processed-crawler

# 4. Athena でクエリ
# AWS Console で実行
```

## Athena クエリ例

### 基本的なクエリ

```sql
-- 最新の株価データを確認
SELECT *
FROM stock_data_db.stock_data
ORDER BY date DESC
LIMIT 10;

-- 特定銘柄の時系列データ
SELECT date, ticker, close, volume
FROM stock_data_db.stock_data
WHERE ticker = 'AAPL'
  AND year = 2024
ORDER BY date DESC;

-- 月次サマリー
SELECT 
    ticker,
    year,
    month,
    COUNT(*) as trading_days,
    AVG(close) as avg_close,
    MIN(low) as month_low,
    MAX(high) as month_high,
    SUM(volume) as total_volume
FROM stock_data_db.stock_data
WHERE year = 2024
GROUP BY ticker, year, month
ORDER BY ticker, year DESC, month DESC;
```

### セクター別分析

```sql
-- Tech セクターの日次サマリー
SELECT 
    date,
    COUNT(DISTINCT ticker) as num_stocks,
    AVG(close) as avg_close_price,
    SUM(volume) as total_volume,
    MIN(low) as sector_min_price,
    MAX(high) as sector_max_price
FROM stock_data_db.stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA')
  AND year >= 2024
GROUP BY date
ORDER BY date DESC;

-- セクター別パフォーマンス比較 (月次)
SELECT 
    CASE 
        WHEN ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA') THEN 'Technology'
        WHEN ticker IN ('JPM', 'BAC', 'WFC') THEN 'Finance'
        WHEN ticker IN ('JNJ', 'PFE') THEN 'Healthcare'
        ELSE 'Other'
    END as sector,
    year,
    month,
    AVG(close) as avg_close,
    SUM(volume) as total_volume
FROM stock_data_db.stock_data
WHERE year = 2024
GROUP BY 
    CASE 
        WHEN ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA') THEN 'Technology'
        WHEN ticker IN ('JPM', 'BAC', 'WFC') THEN 'Finance'
        WHEN ticker IN ('JNJ', 'PFE') THEN 'Healthcare'
        ELSE 'Other'
    END,
    year,
    month
ORDER BY year DESC, month DESC, sector;
```

### ビューの作成

```sql
-- Tech セクター専用ビュー
CREATE OR REPLACE VIEW tech_sector_daily AS
SELECT 
    date,
    ticker,
    open,
    high,
    low,
    close,
    volume,
    year,
    month,
    day
FROM stock_data_db.stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA')
  AND year >= 2024;

-- Finance セクター専用ビュー
CREATE OR REPLACE VIEW finance_sector_daily AS
SELECT 
    date,
    ticker,
    open,
    high,
    low,
    close,
    volume,
    year,
    month,
    day
FROM stock_data_db.stock_data
WHERE ticker IN ('JPM', 'BAC', 'WFC')
  AND year >= 2024;
```

## QuickSight 接続準備 (将来)

QuickSight で可視化する場合の準備:

### 1. Athena ビューの作成

```sql
-- QuickSight 用の集計済みビュー
CREATE OR REPLACE VIEW quicksight_daily_summary AS
SELECT 
    date,
    ticker,
    CASE 
        WHEN ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA') THEN 'Technology'
        WHEN ticker IN ('JPM', 'BAC', 'WFC') THEN 'Finance'
        WHEN ticker IN ('JNJ', 'PFE') THEN 'Healthcare'
        WHEN ticker IN ('XOM', 'CVX') THEN 'Energy'
        ELSE 'Other'
    END as sector,
    close as price,
    volume,
    year,
    month
FROM stock_data_db.stock_data
WHERE year >= 2024;
```

### 2. データマートテーブルの作成 (CTAS)

```sql
-- セクター別月次集計テーブル
CREATE TABLE stock_data_db.sector_monthly_mart
WITH (
    format = 'PARQUET',
    parquet_compression = 'SNAPPY',
    external_location = 's3://stock-data-processed-<ACCOUNT_ID>/datamart/sector_monthly/'
) AS
SELECT 
    CASE 
        WHEN ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA') THEN 'Technology'
        WHEN ticker IN ('JPM', 'BAC', 'WFC') THEN 'Finance'
        WHEN ticker IN ('JNJ', 'PFE') THEN 'Healthcare'
        WHEN ticker IN ('XOM', 'CVX') THEN 'Energy'
        ELSE 'Other'
    END as sector,
    year,
    month,
    COUNT(DISTINCT ticker) as num_stocks,
    COUNT(DISTINCT date) as trading_days,
    AVG(close) as avg_close,
    MIN(low) as min_price,
    MAX(high) as max_price,
    SUM(volume) as total_volume
FROM stock_data_db.stock_data
WHERE year >= 2024
GROUP BY 
    CASE 
        WHEN ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA') THEN 'Technology'
        WHEN ticker IN ('JPM', 'BAC', 'WFC') THEN 'Finance'
        WHEN ticker IN ('JNJ', 'PFE') THEN 'Healthcare'
        WHEN ticker IN ('XOM', 'CVX') THEN 'Energy'
        ELSE 'Other'
    END,
    year,
    month;
```

## Aurora マスターデータの管理

### 新しい銘柄の追加

```sql
INSERT INTO stocks (ticker, name, sector, exchange, country)
VALUES ('NFLX', 'Netflix Inc.', 'Technology', 'NASDAQ', 'USA');
```

### セクター情報の更新

```sql
UPDATE stocks
SET sector = 'Technology',
    updated_at = CURRENT_TIMESTAMP
WHERE ticker = 'TSLA';
```

### 銘柄の無効化

```sql
UPDATE stocks
SET is_active = FALSE,
    updated_at = CURRENT_TIMESTAMP
WHERE ticker = 'XXXX';
```

### セクター一覧の確認

```sql
SELECT * FROM v_stocks_by_sector;
```

## Scheduler の管理

### Scheduler を有効化

```bash
aws scheduler update-schedule \
    --name DailyStockDataFetch \
    --state ENABLED \
    --schedule-expression "cron(0 0 * * ? *)" \
    --flexible-time-window Mode=OFF \
    --target '{
        "Arn": "arn:aws:lambda:ap-northeast-1:<ACCOUNT_ID>:function:FetchStockDataFunction",
        "RoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/StockDataSchedulerRole"
    }'
```

### Scheduler を無効化

```bash
aws scheduler update-schedule \
    --name DailyStockDataFetch \
    --state DISABLED \
    --schedule-expression "cron(0 0 * * ? *)" \
    --flexible-time-window Mode=OFF \
    --target '{
        "Arn": "arn:aws:lambda:ap-northeast-1:<ACCOUNT_ID>:function:FetchStockDataFunction",
        "RoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/StockDataSchedulerRole"
    }'
```

### Scheduler の状態確認

```bash
aws scheduler get-schedule --name DailyStockDataFetch
```

## S3 Event Notification の有効化

CDK で S3 Event Notification を有効化する場合:

`bin/stock-etl.ts` を編集:

```typescript
const glueStack = new GlueStack(app, 'GlueStack', {
  // ...
  s3EventNotificationEnabled: true, // true に変更
});
```

再デプロイ:

```bash
cdk deploy GlueStack
```

## コスト監視

### 主なコスト要素

1. **Aurora Serverless v2**: ACU 時間単位の課金
2. **Lambda**: 実行回数と実行時間
3. **Glue Job**: DPU 時間単位の課金
4. **S3**: ストレージとリクエスト
5. **Athena**: スキャンしたデータ量

### コスト削減のヒント

```bash
# 1. 使わない時は Aurora を停止
aws rds stop-db-cluster --db-cluster-identifier stock-master-cluster

# 2. S3 の古いデータを削除
aws s3 rm s3://stock-data-raw-<ACCOUNT_ID>/raw/ --recursive

# 3. Athena のパーティションを活用
# WHERE year = 2024 AND month = '11' を必ず指定

# 4. Glue Job は必要な時だけ実行
```
