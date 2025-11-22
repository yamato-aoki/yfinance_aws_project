# yfinance AWS Data Pipeline Project

AWS CDK (TypeScript) で構築する株価データパイプライン学習用プロジェクト

[![CDK Version](https://img.shields.io/badge/AWS_CDK-2.120.0-orange)](https://github.com/aws/aws-cdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.0-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Learning Project](https://img.shields.io/badge/Purpose-Learning-green)](https://github.com)

## 重要：コスト警告

このプロジェクトには**高額なAWSサービス**が含まれています。

| スタック | 月額概算 | デプロイ推奨 |
|---------|---------|------------|
| S3Stack | ~$1 | OK 学習可 |
| IamStack | $0 | OK 学習可 |
| LambdaStack | ~$0 | OK 学習可 |
| SchedulerStack | ~$1 | OK 学習可 |
| **AuroraStack** | **~$100/月** | NG 高額（非推奨） |
| **GlueStack** | **~$10/実行** | NG 実行時課金 |
| AthenaStack | 従量課金 | - 使用時のみ |

**学習目的の場合、Aurora/Glueスタックはデプロイせず、コードリーディングでの学習を推奨します。**

## プロジェクト概要

yfinance を使用して株価データ（日次）を取得し、S3 に保存・加工・分析可能な形式に変換するデータパイプラインです。実務の「S3 にログ、Aurora にマスター」という構造を株価データで再現しています。

## アーキテクチャ

```
EventBridge Scheduler (毎日 9:00 JST)
    ↓
Lambda (yfinance) → S3 Raw Bucket (CSV)
    ↓ (S3 Event - デフォルト無効)
Glue ETL Job → S3 Processed Bucket (Parquet)
    ↓
Glue Crawler → Glue Data Catalog
    ↓
Athena / QuickSight (将来)

Aurora (MySQL) ← 銘柄マスターデータ
    ↓ (JOIN)
Glue ETL Job
```

##  プロジェクト構造

```
yfinance_aws_project/
├── bin/
│   └── stock-etl.ts              # CDK エントリポイント
├── lib/
│   ├── s3-stack.ts               # S3 バケット (raw/processed)
│   ├── iam-stack.ts              # IAM ロール
│   ├── aurora-stack.ts           # Aurora クラスター & VPC
│   ├── lambda-stack.ts           # Lambda 関数
│   ├── scheduler-stack.ts        # EventBridge Scheduler (無効)
│   ├── glue-stack.ts             # Glue DB/Job/Crawler
│   └── athena-stack.ts           # Athena WorkGroup & ビュー
├── lambda/
│   └── fetch_stock/
│       ├── index.py              # Lambda ソースコード
│       └── requirements.txt      # yfinance 依存関係
├── glue/
│   └── etl_job.py                # Glue ETL ジョブスクリプト
├── sql/
│   └── create_stocks_table.sql   # Aurora マスターテーブル DDL
├── package.json
├── tsconfig.json
├── cdk.json
└── README.md
```

##  セットアップ手順

### 前提条件

- Node.js 18.x 以上
- AWS CLI 設定済み
- AWS CDK CLI インストール済み

```bash
npm install -g aws-cdk
```

### 1. 依存関係のインストール

```bash
npm install
```

### 2. CDK Bootstrap (初回のみ)

```bash
cdk bootstrap
```

### 3. スタックのデプロイ

```bash
# すべてのスタックをデプロイ
npm run deploy

# または個別にデプロイ
cdk deploy S3Stack
cdk deploy IamStack
cdk deploy AuroraStack
cdk deploy LambdaStack
cdk deploy SchedulerStack
cdk deploy GlueStack
cdk deploy AthenaStack
```

### 4. Aurora データベース初期化

デプロイ後、Aurora に接続して銘柄マスターテーブルを作成します。

```bash
# Secrets Manager から認証情報を取得
aws secretsmanager get-secret-value --secret-id StockDatabaseCredentials

# Aurora に接続 (Query Editor または MySQL クライアント)
mysql -h <aurora-endpoint> -u admin -p stockdb < sql/create_stocks_table.sql
```

### 5. Glue スクリプトのアップロード

```bash
# Glue スクリプト用 S3 バケットにアップロード
aws s3 cp glue/etl_job.py s3://glue-scripts-<ACCOUNT_ID>/glue/etl_job.py
```

### 6. Lambda Layer の作成 (yfinance)

Lambda で yfinance を使用するため、Lambda Layer を作成します。

```bash
# Lambda Layer の作成
mkdir -p lambda-layer/python
cd lambda-layer
pip install -r ../lambda/fetch_stock/requirements.txt -t python/
zip -r yfinance-layer.zip python
aws lambda publish-layer-version \
    --layer-name yfinance-layer \
    --zip-file fileb://yfinance-layer.zip \
    --compatible-runtimes python3.11

# Lambda 関数に Layer をアタッチ
aws lambda update-function-configuration \
    --function-name FetchStockDataFunction \
    --layers <layer-arn>
```

##  データフロー

### 1. データ取得 (Lambda)

- **トリガー**: EventBridge Scheduler (毎日 9:00 JST) - デフォルト無効
- **処理**: 前日の株価データを yfinance から取得
- **出力**: `s3://raw/{ticker}/{YYYY}/{MM}/{DD}/{ticker}_{YYYY-MM-DD}.csv`

### 2. データ変換 (Glue ETL)

- **トリガー**: S3 Event Notification (デフォルト無効) または手動実行
- **処理**: CSV → Parquet 変換、Aurora マスターとの JOIN
- **出力**: `s3://processed/{ticker}/{year}/{month}/{day}/`

**出力カラム構造**:
```
- ticker: 銘柄コード
- date: 日付
- year, month, day: パーティションキー
- open, high, low, close: 株価
- volume: 出来高
- sector, exchange, country: マスター情報 (Aurora から)
- ingested_at: Glue 処理日時
- source_file: 元の CSV ファイル名
```

### 3. カタログ登録 (Glue Crawler)

- Processed バケットをクロールして Glue Data Catalog に登録
- パーティション情報を自動検出

### 4. 分析 (Athena)

- Glue Catalog のテーブルをクエリ
- セクター別ビュー、月次集計など

##  主要機能

###  実装済み

-  S3 バケット (raw/processed/athena-results)
-  Aurora Serverless v2 クラスター
-  Lambda 関数 (yfinance 株価取得)
-  EventBridge Scheduler (デフォルト無効)
-  Glue ETL Job (CSV → Parquet)
-  Glue Crawler
-  Athena WorkGroup & Named Queries
-  IAM ロール & ポリシー
-  セクター別ビュー (Athena)

###  設定が必要

- Lambda Layer (yfinance) のアタッチ
- Aurora マスターテーブルの初期化
- Glue スクリプトの S3 アップロード
- EventBridge Scheduler の有効化 (オプション)
- S3 Event Notification の有効化 (オプション)

##  運用手順

### Scheduler を有効化する

```bash
aws scheduler update-schedule \
    --name DailyStockDataFetch \
    --state ENABLED \
    --schedule-expression "cron(0 0 * * ? *)" \
    --flexible-time-window Mode=OFF \
    --target "Arn=<lambda-arn>,RoleArn=<scheduler-role-arn>"
```

### Lambda を手動実行する

```bash
aws lambda invoke \
    --function-name FetchStockDataFunction \
    --payload '{}' \
    response.json
```

### Glue Job を手動実行する

```bash
aws glue start-job-run \
    --job-name stock-data-csv-to-parquet
```

### Glue Crawler を実行する

```bash
aws glue start-crawler \
    --name stock-data-processed-crawler
```

### Athena でクエリを実行する

```sql
-- Glue Catalog のテーブルを確認
SHOW TABLES IN stock_data_db;

-- 株価データを確認
SELECT * FROM stock_data
WHERE year = 2024 AND month = '11'
LIMIT 10;

-- Tech セクターの日次サマリー
SELECT 
    date,
    COUNT(DISTINCT ticker) as num_stocks,
    AVG(close) as avg_close,
    SUM(volume) as total_volume
FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL')
GROUP BY date
ORDER BY date DESC;
```

## コスト最適化

学習環境での コスト対策:

1. **Aurora Serverless v2**: 最小 0.5 ACU、最大 1 ACU
2. **EventBridge Scheduler**: デフォルト無効
3. **S3 Event Notification**: デフォルト無効
4. **Glue Job**: 手動実行推奨 (DPU: 2.0)
5. **S3 Lifecycle**: 
   - Raw データ: 90日後削除
   - Athena 結果: 7日後削除

### 使わない時はリソースを削除

```bash
# スタックを削除
cdk destroy --all

# S3 バケットは手動で削除 (RETAIN 設定のため)
aws s3 rb s3://stock-data-raw-<ACCOUNT_ID> --force
aws s3 rb s3://stock-data-processed-<ACCOUNT_ID> --force
```

## トラブルシューティング

### Lambda で yfinance が使えない

→ Lambda Layer を作成してアタッチしてください (上記「Lambda Layer の作成」参照)

### Glue Job が Aurora に接続できない

→ Glue Job の VPC 設定を確認してください (Aurora と同じ VPC/サブネット)

### Athena でテーブルが見つからない

→ Glue Crawler を実行して、Glue Data Catalog にテーブルを登録してください

### S3 Event Notification が動かない

→ デフォルトで無効です。GlueStack の `s3EventNotificationEnabled: true` に変更して再デプロイしてください

##  学習ポイント

1. **S3 パーティショニング**: 銘柄・日付単位の階層構造
2. **Glue ETL**: Spark を使った大規模データ処理
3. **Aurora + S3**: マスターデータとログデータの分離
4. **Athena**: Parquet を使った高速クエリ
5. **セクター別集計**: 実務の「カテゴリ別可視化」を再現

##  カスタマイズ

### 銘柄リストの変更

`bin/stock-etl.ts` の `stockTickers` 配列を編集:

```typescript
const stockTickers = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];
```

### Scheduler の時刻変更

`lib/scheduler-stack.ts` の cron 式を編集:

```typescript
scheduleExpression: 'cron(0 0 * * ? *)', // 毎日 0:00 UTC (9:00 JST)
```

### Glue Job の DPU 変更

`lib/glue-stack.ts` の `maxCapacity` を編集:

```typescript
maxCapacity: 2.0, // 2 DPU
```

##  参考資料

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS Glue ETL Documentation](https://docs.aws.amazon.com/glue/latest/dg/aws-glue-programming-intro.html)
- [yfinance Documentation](https://github.com/ranaroussi/yfinance)
- [Amazon Athena Documentation](https://docs.aws.amazon.com/athena/)

##  ライセンス

MIT License

##  Author

Learning Project for AWS Data Pipeline
