# yfinance AWS データパイプライン構築プロジェクト - 実装記録

## プロジェクト目的

S3にログ、Auroraにマスターというアーキテクチャを、株価データを使って学習環境で構築する。

## 達成したこと

### 1. プロジェクト構造の設計と実装

AWS CDK (TypeScript) を使用して、以下の7つのスタックを作成しました：

#### **S3Stack** - データ保存基盤
- **raw バケット**: Lambda が取得した CSV データを保存
- **processed バケット**: Glue が変換した Parquet データを保存
- **athena-results バケット**: クエリ結果を保存
- ライフサイクルポリシー: コスト最適化のため自動削除設定

#### **IamStack** - 権限管理
- **Lambda実行ロール**: S3への書き込み権限
- **Glue実行ロール**: S3読み書き、Aurora接続、VPC接続権限
- 最小権限の原則に従った設定

#### **AuroraStack** - マスターデータベース
- **Aurora Serverless v2**: コスト最適化 (0.5-1 ACU)
- **VPC構成**: パブリック/プライベート/分離サブネット
- **銘柄マスターテーブル**: ticker, sector, exchange などのメタ情報
- Secrets Manager による認証情報管理

#### **LambdaStack** - データ取得
- **yfinance 連携**: 前日の株価データを取得
- **環境変数**: 取得する銘柄リストを外部化
- **S3出力**: `/raw/{ticker}/{YYYY}/{MM}/{DD}/` 形式で保存
- Lambda Layer で yfinance をデプロイ（requirements.txt 含む）

#### **SchedulerStack** - 自動実行
- **EventBridge Scheduler**: 毎日 9:00 JST に実行
- **デフォルト無効**: コスト対策で手動有効化が必要
- cron 式: `cron(0 0 * * ? *)` (UTC 0:00 = JST 9:00)

#### **GlueStack** - ETL処理
- **Glue Database**: `stock_data_db` を作成
- **ETL Job**: CSV → Parquet 変換
  - パーティショニング: `{ticker}/{year}/{month}/{day}/`
  - Aurora マスターとの JOIN
  - 追加カラム: sector, exchange, country, ingested_at, source_file
- **Crawler**: processed バケットをスキャンしてカタログ化
- **S3 Event Trigger**: デフォルト無効

#### **AthenaStack** - データ分析
- **WorkGroup**: クエリ実行環境
- **Named Queries**: 
  - セクター別日次サマリー
  - 月次集計
  - Tech セクター専用ビュー
- QuickSight 連携を見据えたビュー設計

---

## アーキテクチャの特徴

### データフロー

```
EventBridge Scheduler (毎日9:00 JST) ─── 無効 ───┐
                                                  │
                                                  ↓
Lambda Function (yfinance)
- 前日の株価を取得 (AAPL, MSFT, GOOGL...)
- CSV形式で保存
                                                  ↓
S3 Raw Bucket
/raw/AAPL/2024/11/23/AAPL_2024-11-23.csv
                                                  │
                                    S3 Event ─── 無効 ───┐
                                                  │
                                                  ↓
Glue ETL Job
- CSV読み込み
- Aurora マスターと JOIN (sector, exchange)
- Parquet変換 + パーティション化
                                                  ↓
S3 Processed Bucket
/processed/AAPL/2024/11/23/xxx.parquet
                                                  ↓
Glue Crawler
- スキャンしてカタログ化
- パーティション情報を登録
                                                  ↓
Glue Data Catalog (stock_data_db)
                                                  ↓
Athena
- SQL でクエリ
- セクター別ビュー作成
- 月次集計
                                                  ↓
(将来) QuickSight
- ダッシュボード作成
- セクター別可視化
```

---

## データ構造設計

### S3 階層構造

```
s3://raw-bucket/
    raw/
        AAPL/              # ticker
            2024/          # year
                11/        # month
                    23/    # day
                        AAPL_2024-11-23.csv

s3://processed-bucket/
    processed/
        AAPL/              # partition: ticker
            year=2024/     # partition: year
                month=11/  # partition: month
                    day=23/# partition: day
                        part-00000.parquet
```

### Aurora 銘柄マスターテーブル

```sql
CREATE TABLE stocks (
    ticker       VARCHAR(10) PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    sector       VARCHAR(100),      -- Tech, Finance, Healthcare
    exchange     VARCHAR(50),       -- NASDAQ, NYSE
    country      VARCHAR(50),
    is_active    BOOLEAN DEFAULT TRUE,
    created_at   DATETIME,
    updated_at   DATETIME
);
```

**サンプルデータ**:
- Technology: AAPL, MSFT, GOOGL, META, NVDA
- Finance: JPM, BAC, WFC
- Healthcare: JNJ, PFE
- Energy: XOM, CVX

### Parquet 出力スキーマ

```
ticker          STRING     # 銘柄コード
date            STRING     # 日付 (YYYY-MM-DD)
year            INT        # パーティションキー
month           STRING     # パーティションキー (01-12)
day             STRING     # パーティションキー (01-31)
open            DOUBLE     # 始値
high            DOUBLE     # 高値
low             DOUBLE     # 安値
close           DOUBLE     # 終値
volume          INT        # 出来高
sector          STRING     # セクター (Aurora から)
exchange        STRING     # 取引所 (Aurora から)
country         STRING     # 国 (Aurora から)
ingested_at     STRING     # Glue 処理日時
source_file     STRING     # 元の CSV ファイル名
```

---

## 技術的な工夫

### 1. コスト最適化

| リソース | 設定 | 理由 |
|---------|------|------|
| EventBridge Scheduler | デフォルト無効 | 毎日実行でコスト発生を防ぐ |
| S3 Event Notification | デフォルト無効 | Lambda起動コストを抑える |
| Aurora Serverless v2 | 0.5-1 ACU | 最小限のキャパシティ |
| Glue Job | DPU 2.0 | 小規模データに最適化 |
| S3 Lifecycle | 自動削除 | ストレージコスト削減 |

### 2. トリガー設定

**S3 Event Trigger の無効化**
```typescript
s3EventNotificationEnabled: false  // デフォルト無効
```

手動で有効化して動作確認が可能。トリガー処理の仕組みを理解するため。

**Scheduler の無効化**
```typescript
scheduleEnabled: false  // デフォルト無効
```

必要な時だけ有効化。コスト管理と動作確認のため。

### 3. セクター別分析

```sql
-- Tech セクターの全銘柄を1つのビューに集約
CREATE VIEW tech_sector_all_stocks AS
SELECT 
    'Tech' as sector,
    ticker, date, close, volume
FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA')

UNION ALL

-- Finance セクター
SELECT 
    'Finance' as sector,
    ticker, date, close, volume
FROM stock_data
WHERE ticker IN ('JPM', 'BAC', 'WFC');
```

QuickSight で：
- セクター単位でグラフ化
- セクター間の比較
- 時系列での推移分析

---

## 実装した機能

### Lambda 関数 (Python)

**機能**:
- yfinance で前日の株価データを取得
- 複数銘柄を並列処理
- エラーハンドリング
- S3 に階層構造で保存

**環境変数**:
```python
RAW_BUCKET_NAME = 'stock-data-raw-{account}'
STOCK_TICKERS = 'AAPL,MSFT,GOOGL,AMZN,TSLA'
```

### Glue ETL Job (PySpark)

**処理フロー**:
1. S3 raw から CSV 読み込み
2. 日付から year/month/day を抽出
3. Aurora から銘柄マスターを取得 (JDBC)
4. LEFT JOIN で sector, exchange を追加
5. Parquet 形式で出力
6. ticker/year/month/day でパーティション化

**パラメータ**:
```python
--RAW_BUCKET          # 入力バケット
--PROCESSED_BUCKET    # 出力バケット
--AURORA_SECRET_ARN   # DB認証情報
--AURORA_ENDPOINT     # DB接続先
--S3_INPUT_PATH       # 特定ファイル処理（オプション）
```

### Athena クエリ例

**日次サマリー**:
```sql
SELECT 
    date,
    ticker,
    close,
    volume
FROM stock_data
WHERE year = 2024 AND month = '11'
ORDER BY date DESC, ticker;
```

**セクター別集計**:
```sql
SELECT 
    sector,
    year,
    month,
    AVG(close) as avg_price,
    SUM(volume) as total_volume
FROM stock_data
WHERE sector IN ('Technology', 'Finance')
GROUP BY sector, year, month;
```

---

## デプロイと運用

### デプロイ手順

```powershell
# 1. 依存関係インストール
npm install

# 2. ビルド
npm run build

# 3. CDK Bootstrap (初回のみ)
cdk bootstrap

# 4. デプロイ
npm run deploy
```

### デプロイ後の設定

#### 1. Lambda Layer 作成

```bash
# yfinance を含む Layer を作成
mkdir lambda-layer/python
pip install yfinance pandas -t lambda-layer/python/
cd lambda-layer && zip -r layer.zip python

# AWS にアップロード
aws lambda publish-layer-version \
    --layer-name yfinance-layer \
    --zip-file fileb://layer.zip \
    --compatible-runtimes python3.11

# Lambda に Layer をアタッチ
aws lambda update-function-configuration \
    --function-name FetchStockDataFunction \
    --layers arn:aws:lambda:...:layer:yfinance-layer:1
```

#### 2. Aurora マスターテーブル初期化

```bash
# Secrets Manager から認証情報取得
aws secretsmanager get-secret-value \
    --secret-id StockDatabaseCredentials

# MySQL で接続
mysql -h <aurora-endpoint> -u admin -p stockdb \
    < sql/create_stocks_table.sql
```

#### 3. Glue スクリプトアップロード

```bash
aws s3 cp glue/etl_job.py \
    s3://glue-scripts-<account>/glue/etl_job.py
```

### 運用フロー

#### 手動実行（学習時）

```bash
# 1. Lambda で株価取得
aws lambda invoke \
    --function-name FetchStockDataFunction \
    response.json

# 2. Glue Job で変換
aws glue start-job-run \
    --job-name stock-data-csv-to-parquet

# 3. Crawler でカタログ化
aws glue start-crawler \
    --name stock-data-processed-crawler

# 4. Athena でクエリ
# AWS Console で実行
```

#### 自動実行（本番想定）

```bash
# Scheduler を有効化
aws scheduler update-schedule \
    --name DailyStockDataFetch \
    --state ENABLED

# S3 Event Notification を有効化
# CDK で s3EventNotificationEnabled: true に変更して再デプロイ
```

---

## 学習ポイント

### 1. S3 パーティショニング戦略

**階層構造の意義**:
- クエリ時のスキャン量削減
- 日付範囲指定での高速検索
- コスト最適化（Athena は スキャン量課金）

**実装例**:
```sql
-- パーティション指定でスキャン量削減
SELECT * FROM stock_data
WHERE year = 2024 
  AND month = '11'
  AND day = '23';  -- 1日分だけスキャン
```

### 2. Aurora と S3 の使い分け

| データ種別 | 保存先 | 理由 |
|----------|-------|------|
| 銘柄マスター | Aurora | 頻繁に更新、参照整合性が必要 |
| 株価データ | S3 | 大量、追記のみ、分析用途 |

### 3. ETL でのマスター JOIN

```python
# Glue Job での JOIN
master_df = spark.read.jdbc(
    url="jdbc:mysql://aurora-endpoint/stockdb",
    table="stocks"
)

stock_df.join(master_df, on="ticker", how="left")
```

これにより：
- S3 に sector 情報も保存
- Athena で Aurora 不要
- クエリが高速化

### 4. セクター別可視化の設計

Tech セクター = AAPL + MSFT + GOOGL + ...

Athena ビューで実現：
```sql
CREATE VIEW tech_sector_daily AS
SELECT * FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL');
```

---

## このプロジェクトで学べること

1. **AWS CDK**: Infrastructure as Code の実践
2. **データパイプライン設計**: 取得 → 保存 → 変換 → 分析
3. **パーティショニング**: 大規模データの効率的な保存
4. **ETL処理**: Glue / PySpark の実装
5. **マスター/ログ分離**: Aurora と S3 の適切な使い分け
6. **イベント駆動**: S3 Event Trigger の仕組み
7. **コスト最適化**: Serverless / Lifecycle / 最小権限
8. **セクター分析**: カテゴリ別集計の設計パターン

---

## 成果物

### コード

- 7つの CDK スタック (TypeScript)
- Lambda 関数 (Python + yfinance)
- Glue ETL Job (PySpark)
- Aurora DDL (SQL)

### ドキュメント

- README.md - プロジェクト概要
- DEPLOYMENT.md - デプロイ手順
- USAGE.md - 運用ガイド
- ARCHITECTURE.md - 本ドキュメント

### 設定ファイル

- package.json - npm 設定
- tsconfig.json - TypeScript 設定
- cdk.json - CDK 設定
- .gitignore - バージョン管理除外

---

## 次のステップ（拡張案）

### 短期（すぐできる）

1. **QuickSight 接続**
   - Athena をデータソースに
   - セクター別ダッシュボード作成
   - 時系列グラフ可視化

2. **通知機能追加**
   - SNS でデータ取得完了を通知
   - CloudWatch Alarm で異常検知

3. **データ品質チェック**
   - Glue Data Quality ルール追加
   - 欠損値・異常値の検出

### 中期（アーキテクチャ拡張）

1. **リアルタイム処理**
   - Kinesis Data Streams で準リアルタイム取得
   - Lambda でストリーム処理

2. **機械学習統合**
   - SageMaker で株価予測モデル
   - 予測結果を S3 に保存

3. **データレイク拡張**
   - Lake Formation で権限管理
   - 複数データソースの統合

### 長期（本番運用想定）

1. **マルチアカウント構成**
   - 開発/本番環境の分離
   - Organizations での一元管理

2. **監視・運用自動化**
   - CloudWatch Dashboards
   - 自動リカバリ機能

3. **コスト最適化**
   - S3 Intelligent-Tiering
   - Graviton インスタンス活用

---

## 参考資料

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS Glue Developer Guide](https://docs.aws.amazon.com/glue/)
- [Amazon Athena User Guide](https://docs.aws.amazon.com/athena/)
- [yfinance Documentation](https://github.com/ranaroussi/yfinance)
- [PySpark Documentation](https://spark.apache.org/docs/latest/api/python/)

---

## プロジェクト完了チェックリスト

- [x] CDK プロジェクト初期化
- [x] 7つのスタック実装
- [x] Lambda 関数実装 (yfinance)
- [x] Glue ETL Job 実装
- [x] Aurora DDL 作成
- [x] ドキュメント整備
- [x] Node.js / npm セットアップ
- [x] TypeScript ビルド成功
- [x] CDK Bootstrap 完了
- [ ] 実際のデプロイ実行
- [ ] Lambda Layer 作成
- [ ] Aurora 初期化
- [ ] 動作確認

---

**作成日**: 2025-11-23  
**プロジェクト**: yfinance AWS データパイプライン
