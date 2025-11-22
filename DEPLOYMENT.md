# デプロイ手順

## 事前準備

1. AWS CLI の設定
```bash
aws configure
```

2. Node.js と npm のインストール確認
```bash
node --version  # v18.x 以上推奨
npm --version
```

3. AWS CDK CLI のインストール
```bash
npm install -g aws-cdk
cdk --version
```

## プロジェクトのセットアップ

```bash
# 1. 依存関係のインストール
npm install

# 2. TypeScript のコンパイル
npm run build

# 3. CDK の初期化 (初回のみ)
cdk bootstrap
```

## デプロイ

### 一括デプロイ

```bash
npm run deploy
```

### 個別デプロイ (推奨順序)

```bash
# 1. S3 バケット
cdk deploy S3Stack

# 2. IAM ロール
cdk deploy IamStack

# 3. Aurora クラスター (時間がかかります: 約 10-15 分)
cdk deploy AuroraStack

# 4. Lambda 関数
cdk deploy LambdaStack

# 5. Scheduler (デフォルト無効)
cdk deploy SchedulerStack

# 6. Glue リソース
cdk deploy GlueStack

# 7. Athena
cdk deploy AthenaStack
```

## デプロイ後の設定

### 1. Lambda Layer の作成と設定

```bash
# yfinance 用の Lambda Layer を作成
mkdir -p lambda-layer/python
cd lambda-layer
pip install yfinance==0.2.32 pandas requests -t python/
zip -r yfinance-layer.zip python

# Layer をパブリッシュ
aws lambda publish-layer-version \
    --layer-name yfinance-layer \
    --description "yfinance and dependencies" \
    --zip-file fileb://yfinance-layer.zip \
    --compatible-runtimes python3.11

# 出力された LayerVersionArn をコピー

# Lambda 関数に Layer をアタッチ
aws lambda update-function-configuration \
    --function-name FetchStockDataFunction \
    --layers arn:aws:lambda:ap-northeast-1:<ACCOUNT_ID>:layer:yfinance-layer:1
```

### 2. Aurora マスターテーブルの作成

```bash
# 1. Secrets Manager から認証情報を取得
aws secretsmanager get-secret-value \
    --secret-id StockDatabaseCredentials \
    --query SecretString \
    --output text | jq

# 2. Aurora エンドポイントを取得
aws rds describe-db-clusters \
    --db-cluster-identifier stock-master-cluster \
    --query 'DBClusters[0].Endpoint' \
    --output text

# 3. MySQL クライアントで接続
mysql -h <aurora-endpoint> -u admin -p stockdb

# 4. SQL スクリプトを実行
mysql> source sql/create_stocks_table.sql;

# または AWS Console の Query Editor を使用
```

### 3. Glue ETL スクリプトのアップロード

```bash
# Glue スクリプト用バケット名を取得
aws cloudformation describe-stacks \
    --stack-name YFinanceStockETL-GlueStack \
    --query 'Stacks[0].Outputs[?OutputKey==`GlueScriptLocation`].OutputValue' \
    --output text

# スクリプトをアップロード
aws s3 cp glue/etl_job.py s3://glue-scripts-<ACCOUNT_ID>/glue/etl_job.py
```

## 動作確認

### 1. Lambda の手動実行

```bash
aws lambda invoke \
    --function-name FetchStockDataFunction \
    --payload '{}' \
    response.json

cat response.json
```

### 2. S3 に CSV ファイルが作成されたことを確認

```bash
aws s3 ls s3://stock-data-raw-<ACCOUNT_ID>/raw/ --recursive
```

### 3. Glue Job の実行

```bash
aws glue start-job-run \
    --job-name stock-data-csv-to-parquet

# ジョブの状態確認
aws glue get-job-run \
    --job-name stock-data-csv-to-parquet \
    --run-id <job-run-id>
```

### 4. Glue Crawler の実行

```bash
aws glue start-crawler \
    --name stock-data-processed-crawler

# Crawler の状態確認
aws glue get-crawler \
    --name stock-data-processed-crawler
```

### 5. Athena でクエリ実行

```bash
# AWS Console で Athena を開く
# または AWS CLI で実行
aws athena start-query-execution \
    --query-string "SELECT * FROM stock_data_db.stock_data LIMIT 10" \
    --result-configuration OutputLocation=s3://athena-query-results-<ACCOUNT_ID>/
```

## トラブルシューティング

### Lambda で yfinance が使えない

エラー: `No module named 'yfinance'`

→ Lambda Layer を作成してアタッチしてください

### Glue Job が失敗する

エラー: `JDBC connection failed`

→ Glue Job の VPC 設定を確認してください (Aurora と同じ VPC)

### Athena でテーブルが見つからない

エラー: `Table not found`

→ Glue Crawler を実行してください

## クリーンアップ

```bash
# すべてのスタックを削除
cdk destroy --all

# S3 バケットの削除 (RETAIN 設定のため手動削除が必要)
aws s3 rb s3://stock-data-raw-<ACCOUNT_ID> --force
aws s3 rb s3://stock-data-processed-<ACCOUNT_ID> --force
aws s3 rb s3://athena-query-results-<ACCOUNT_ID> --force
aws s3 rb s3://glue-scripts-<ACCOUNT_ID> --force
```
