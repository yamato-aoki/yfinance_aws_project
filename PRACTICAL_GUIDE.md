# 実務でのCDKプロジェクト構築ガイド

## プロジェクト準備の全体フロー

### フェーズ1: 要件整理（1-2日）

#### 1. 要件定義

**データソース**
- 何のデータを扱うか（今回: yfinance API）
- データ形式（CSV → Parquet）
- データ量の見積もり

**処理要件**
- 更新頻度（毎日1回 9:00 JST）
- 処理時間の制約（5分以内）
- データ保持期間（raw: 90日、processed: 無期限）

**分析要件**
- 分析対象（セクター別集計、時系列分析）
- クエリパターン（日次、月次、セクター別）
- ユーザー（データアナリスト、ビジネス担当者）

#### 2. アーキテクチャ設計

**システム構成図を描く**
```
EventBridge Scheduler
    ↓
Lambda (データ取得)
    ↓
S3 Raw (CSV)
    ↓
Glue ETL (変換)
    ↓
S3 Processed (Parquet) + Aurora (マスター)
    ↓
Athena / QuickSight (分析)
```

**技術選定の理由を明確に**
- Lambda: サーバーレス、従量課金
- S3: 大量データ保存、低コスト
- Glue: マネージドETL、Spark基盤
- Aurora Serverless: マスターデータ、オートスケール
- Athena: S3直接クエリ、SQL使用可能

#### 3. コスト試算

| サービス | 使用量 | 月額コスト |
|---------|--------|-----------|
| Lambda | 300回 × 5分 × 512MB | $0.50 |
| S3 | 10GB + リクエスト | $0.30 |
| Glue | 300回 × 2DPU × 5分 | $13.00 |
| Aurora Serverless v2 | 0.5 ACU × 24h × 30日 | $30.00 |
| Athena | 10GB スキャン/月 | $0.05 |
| **合計** | | **約$44/月** |

**コスト削減案**
- 学習環境: Scheduler無効、手動実行
- Aurora: 使わない時は停止
- S3 Lifecycle: 古いデータ自動削除

---

## フェーズ2: 基盤構築（1-2日）

### デプロイ順序と理由

#### 順序1: VPCとネットワーク（必要な場合のみ）

```bash
# Aurora使用時は必須
npx cdk deploy VpcStack
```

**理由**: 
- データベースはプライベートサブネットに配置
- Glueから接続するためVPC設定が必要

**待ち時間**: 5-10分

---

#### 順序2: S3バケット

```bash
npx cdk deploy S3Stack
```

**理由**: 
- 他のリソース（Lambda、Glue）がS3に依存
- ストレージ層を最初に確保

**作成されるリソース**:
- raw バケット（CSV保存）
- processed バケット（Parquet保存）
- athena-results バケット（クエリ結果）

**確認**:
```bash
aws s3 ls | grep stock
```

**待ち時間**: 2-3分

---

#### 順序3: IAMロール

```bash
npx cdk deploy IamStack
```

**理由**: 
- Lambda/Glueの実行に必要な権限を事前準備
- 最小権限の原則に従った設計

**作成されるリソース**:
- Lambda実行ロール（S3書き込み権限）
- Glue実行ロール（S3読み書き、Aurora接続、VPC）

**確認**:
```bash
aws iam list-roles | grep Stock
```

**待ち時間**: 2-3分

---

#### 順序4: データベース（Aurora）

```bash
npx cdk deploy AuroraStack
```

**理由**: 
- 時間がかかる（10-15分）ので早めに開始
- デプロイ中に他の作業を並行可能

**作成されるリソース**:
- Aurora Serverless v2 クラスター
- VPC、サブネット、セキュリティグループ
- Secrets Manager（DB認証情報）

**デプロイ中の並行作業**:
- Lambda Layer準備
- Glueスクリプト確認
- テストデータ準備

**確認**:
```bash
aws rds describe-db-clusters --db-cluster-identifier stock-master-cluster
```

**待ち時間**: 10-15分

---

## フェーズ3: データ取得（半日）

### 順序5: Lambda関数

#### ステップ1: Lambda Layer作成

Lambda で yfinance を使うため、外部ライブラリをLayerとして準備。

```bash
# Layer用のディレクトリ作成
mkdir -p lambda-layer/python
cd lambda-layer

# yfinance と依存関係をインストール
pip install yfinance pandas requests -t python/

# ZIP化
zip -r yfinance-layer.zip python/

# AWSにアップロード
aws lambda publish-layer-version \
    --layer-name yfinance-layer \
    --description "yfinance and dependencies" \
    --zip-file fileb://yfinance-layer.zip \
    --compatible-runtimes python3.11

# 出力されたLayerVersionArnをメモ
```

#### ステップ2: Lambdaデプロイ

```bash
npx cdk deploy LambdaStack
```

**作成されるリソース**:
- Lambda関数（FetchStockDataFunction）
- 環境変数設定（バケット名、銘柄リスト）

#### ステップ3: Layerをアタッチ

```bash
aws lambda update-function-configuration \
    --function-name FetchStockDataFunction \
    --layers arn:aws:lambda:ap-northeast-1:ACCOUNT_ID:layer:yfinance-layer:1
```

#### ステップ4: 手動テスト

```bash
# Lambda実行
aws lambda invoke \
    --function-name FetchStockDataFunction \
    --payload '{}' \
    response.json

# 結果確認
cat response.json | jq
```

#### ステップ5: S3にデータが保存されたか確認

```bash
# raw バケットの確認
aws s3 ls s3://stock-data-raw-ACCOUNT_ID/raw/ --recursive

# ファイルダウンロードして中身確認
aws s3 cp s3://stock-data-raw-ACCOUNT_ID/raw/AAPL/2024/11/23/AAPL_2024-11-23.csv ./

# CSVの中身
cat AAPL_2024-11-23.csv
```

#### ステップ6: Scheduler有効化（オプション）

手動テストが成功したら、自動実行を有効化。

```bash
npx cdk deploy SchedulerStack
# またはコード編集して再デプロイ
```

**bin/stock-etl.ts を編集**:
```typescript
const schedulerStack = new SchedulerStack(app, 'SchedulerStack', {
  // ...
  scheduleEnabled: true,  // false → true に変更
});
```

---

## フェーズ4: データ変換（半日）

### 順序6: Glue設定

#### ステップ1: Aurora初期化

マスターテーブルを作成。

```bash
# Secrets Managerから認証情報取得
aws secretsmanager get-secret-value \
    --secret-id StockDatabaseCredentials \
    --query SecretString \
    --output text | jq

# MySQL接続
mysql -h <aurora-endpoint> -u admin -p stockdb

# SQLスクリプト実行
source sql/create_stocks_table.sql;

# テーブル確認
SELECT * FROM stocks;
```

#### ステップ2: Glueスクリプトアップロード

```bash
# Glueスクリプト用バケットにアップロード
aws s3 cp glue/etl_job.py \
    s3://glue-scripts-ACCOUNT_ID/glue/etl_job.py

# アップロード確認
aws s3 ls s3://glue-scripts-ACCOUNT_ID/glue/
```

#### ステップ3: Glueデプロイ

```bash
npx cdk deploy GlueStack
```

**作成されるリソース**:
- Glue Database（stock_data_db）
- Glue Job（stock-data-csv-to-parquet）
- Glue Crawler（stock-data-processed-crawler）

#### ステップ4: Glue Job手動実行

```bash
# ジョブ実行
aws glue start-job-run \
    --job-name stock-data-csv-to-parquet

# 実行状態確認
aws glue get-job-run \
    --job-name stock-data-csv-to-parquet \
    --run-id <job-run-id>

# CloudWatch Logsで詳細確認
aws logs tail /aws-glue/jobs/output --follow
```

#### ステップ5: Processed バケット確認

```bash
# Parquetファイルが作成されたか
aws s3 ls s3://stock-data-processed-ACCOUNT_ID/processed/ --recursive

# 階層構造の確認
# processed/AAPL/2024/11/23/*.parquet
```

#### ステップ6: Crawler実行

```bash
# Crawler起動
aws glue start-crawler \
    --name stock-data-processed-crawler

# 状態確認
aws glue get-crawler \
    --name stock-data-processed-crawler

# 完了後、Glue Catalogにテーブルが作成される
aws glue get-tables \
    --database-name stock_data_db
```

---

## フェーズ5: 分析環境（半日）

### 順序7: Athena

```bash
npx cdk deploy AthenaStack
```

**作成されるリソース**:
- Athena WorkGroup（stock-data-analytics）
- Named Queries（サンプルクエリ）
- クエリ結果用S3設定

#### ステップ1: Athenaでテストクエリ

AWSコンソール → Athena を開く

```sql
-- データベース選択
USE stock_data_db;

-- テーブル確認
SHOW TABLES;

-- データ確認
SELECT * FROM stock_data
LIMIT 10;

-- パーティション確認
SHOW PARTITIONS stock_data;

-- セクター別集計
SELECT 
    sector,
    COUNT(*) as count,
    AVG(close) as avg_price
FROM stock_data
WHERE year = 2024 AND month = '11'
GROUP BY sector;
```

#### ステップ2: ビュー作成

```sql
-- Tech セクター専用ビュー
CREATE VIEW tech_sector_daily AS
SELECT 
    date,
    ticker,
    open,
    high,
    low,
    close,
    volume
FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA')
  AND year >= 2024;

-- ビュー確認
SELECT * FROM tech_sector_daily
ORDER BY date DESC, ticker
LIMIT 20;
```

#### ステップ3: QuickSight接続（将来）

1. QuickSight にサインアップ
2. データソースとして Athena を選択
3. `stock_data_db` データベースを選択
4. ビジュアル作成

---

## フェーズ6: 運用準備（1日）

### モニタリング設定

#### CloudWatch Alarm

```typescript
// lib/monitoring-stack.ts

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';

// Lambda エラー監視
new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
  metric: lambdaFunction.metricErrors(),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'Lambda function failed',
});

// Glue Job 失敗監視
new cloudwatch.Alarm(this, 'GlueJobFailureAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/Glue',
    metricName: 'glue.driver.aggregate.numFailedTasks',
    statistic: 'Sum',
  }),
  threshold: 1,
  evaluationPeriods: 1,
});
```

#### SNS通知

```bash
# SNSトピック作成
aws sns create-topic --name stock-pipeline-alerts

# メール購読
aws sns subscribe \
    --topic-arn arn:aws:sns:ap-northeast-1:ACCOUNT_ID:stock-pipeline-alerts \
    --protocol email \
    --notification-endpoint your-email@example.com
```

### ドキュメント作成

作成するドキュメント:
- README.md（プロジェクト概要）
- DEPLOYMENT.md（デプロイ手順）
- USAGE.md（運用手順）
- ARCHITECTURE.md（アーキテクチャ説明）
- TROUBLESHOOTING.md（トラブルシューティング）

### コスト監視

```bash
# コストエクスプローラーでタグ別集計
aws ce get-cost-and-usage \
    --time-period Start=2024-11-01,End=2024-11-30 \
    --granularity MONTHLY \
    --metrics UnblendedCost \
    --filter file://filter.json

# filter.json
{
  "Tags": {
    "Key": "Project",
    "Values": ["YFinanceStockETL"]
  }
}
```

---

## 実務での並行作業スケジュール例

### 月曜日

**午前（9:00-12:00）**
```
09:00 - S3Stack デプロイ開始
09:05 - IamStack デプロイ開始
09:10 - S3/IAM完了確認
09:15 - AuroraStack デプロイ開始（バックグラウンド）

待ち時間で：
09:20 - Lambda Layer 準備開始
10:00 - Lambda コード確認・修正
11:00 - Glue スクリプト確認
11:30 - ドキュメント整備
```

**午後（13:00-18:00）**
```
13:00 - Aurora完了確認（約10-15分経過）
13:15 - LambdaStack デプロイ
13:20 - Lambda Layer アタッチ
13:30 - Lambda 手動テスト
14:00 - S3にデータ確認 → 成功
14:30 - 複数銘柄でテスト
15:00 - エラーハンドリング確認
15:30 - ドキュメント更新
```

### 火曜日

**午前（9:00-12:00）**
```
09:00 - Aurora マスターテーブル作成
09:30 - サンプルデータ投入
10:00 - Glue スクリプト S3 アップロード
10:15 - GlueStack デプロイ
10:30 - Glue Job 手動実行
11:00 - CloudWatch Logs確認
11:30 - Parquet ファイル確認
```

**午後（13:00-18:00）**
```
13:00 - Crawler 実行
13:15 - Glue Catalog 確認
13:30 - AthenaStack デプロイ
14:00 - Athena クエリテスト
15:00 - ビュー作成
16:00 - パフォーマンステスト
17:00 - ドキュメント最終更新
```

### 水曜日（予備日）

**午前（9:00-12:00）**
```
09:00 - 全体統合テスト
10:00 - エラーケース確認
11:00 - モニタリング設定
```

**午後（13:00-18:00）**
```
13:00 - レビュー・修正
15:00 - 運用手順書作成
17:00 - チームレビュー
```

---

## トラブルシューティング

### よくある問題と対処法

#### Lambda で yfinance が使えない

**エラー**: `No module named 'yfinance'`

**原因**: Lambda Layer が未設定

**対処**:
```bash
# Layer作成とアタッチ（上記参照）
aws lambda update-function-configuration \
    --function-name FetchStockDataFunction \
    --layers arn:aws:lambda:...:layer:yfinance-layer:1
```

#### Glue Job が Aurora に接続できない

**エラー**: `JDBC connection failed`

**原因**: VPC設定が不正

**対処**:
1. Glue Job と Aurora が同じVPCか確認
2. セキュリティグループで 3306 ポート許可
3. Glue の IAM ロールに VPC権限があるか確認

#### Athena でテーブルが見つからない

**エラー**: `Table not found: stock_data`

**原因**: Crawler が未実行

**対処**:
```bash
# Crawler実行
aws glue start-crawler --name stock-data-processed-crawler

# 完了確認
aws glue get-crawler --name stock-data-processed-crawler

# テーブル確認
aws glue get-tables --database-name stock_data_db
```

#### コストが予想より高い

**確認項目**:
1. Aurora が停止し忘れていないか
2. Scheduler が有効になっていないか
3. Glue Job が無限ループしていないか

**対処**:
```bash
# Aurora停止
aws rds stop-db-cluster --db-cluster-identifier stock-master-cluster

# Scheduler無効化
aws scheduler update-schedule --name DailyStockDataFetch --state DISABLED

# Glue Job停止
aws glue get-job-runs --job-name stock-data-csv-to-parquet
aws glue batch-stop-job-run --job-name stock-data-csv-to-parquet --job-run-ids <id>
```

---

## まとめ: 実務で重要なポイント

### 1. 段階的デプロイ

一度に全部デプロイせず、段階的に進める。
- 基盤 → アプリ → 分析 の順
- 各段階でテスト・確認

### 2. 並行作業の活用

時間がかかるリソース（Aurora、VPC）は早めに開始し、待ち時間で他作業。

### 3. コスト意識

学習環境では：
- Scheduler無効
- Aurora使用後は停止
- 不要なリソースは削除

### 4. ドキュメント化

コードと同じくらい重要：
- デプロイ手順
- 運用手順
- トラブルシューティング

### 5. モニタリング

本番環境では必須：
- CloudWatch Alarm
- SNS通知
- コスト監視
