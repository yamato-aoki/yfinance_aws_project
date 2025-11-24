# yfinance AWS Data Pipeline Project

AWS CDK (TypeScript) を使用して構築する **株価データパイプライン学習プロジェクト**。  
実務でよくある「S3 にログ、Aurora にマスター」という構造を、株価データを題材に再現したテンプレートです。

[![CDK Version](https://img.shields.io/badge/AWS_CDK-2.120.0-orange)](https://github.com/aws/aws-cdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.0-blue)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11-blue)](https://www.python.org/)
[![yfinance](https://img.shields.io/badge/yfinance-0.2.49-brightgreen)](https://pypi.org/project/yfinance/)
[![pandas](https://img.shields.io/badge/pandas-2.1.4-brightgreen)](https://pandas.pydata.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---


# 目次

- [構成の狙い](#構成の狙い)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [アーキテクチャ比較](#アーキテクチャ比較)
- [データフロー](#データフロー)
  - [Curated ビュー自動生成](#curated-ビュー自動生成)
- [データレイク3層構造](#データレイク3層構造)
- [S3 Processed バケット構造](#s3-processed-バケット構造)
- [Parquet カラム仕様](#parquet-カラム仕様)
- [マスターデータ構造（DynamoDB/Aurora）](#マスターデータ構造dynamodbaurora)
- [プロジェクト構造](#プロジェクト構造)
- [使い方](#使い方)
- [自動化を有効化する](#自動化を有効化する)
- [応用例](#応用例)
- [作者](#作者)
- [学習ガイド](#学習ガイド)



---

## 構成の狙い

本プロジェクトは、学習コストを抑えながら実務構造も理解できるように、

- **低コストで動作する DynamoDB + Lambda 構成**
- **本番運用を想定した Aurora + Glue 構成**

の **2パターン切り替え式** のアーキテクチャにしています。

設定は [`bin/stock-etl.ts` L73](./bin/stock-etl.ts#L73) の `useFreeTier` フラグで切り替えできます。

---

## アーキテクチャ概要

![Architecture Diagram](docs/architecture.png)

---

## アーキテクチャ比較

| 構成 | 低コスト構成（学習向け） | 本番構成（実務想定） |
|------|-----------------------|------------------------|
| マスターDB | **DynamoDB** (無料枠) | **Aurora Serverless v2** (~$100/月) |
| 変換処理 | **Lambda Transform** | **Glue ETL Job** (~$10/実行) |
| スケジューラ | EventBridge（デプロイ時は無効・手動で有効化） | 〃 |
| カタログ | Glue Crawler | 〃 |
| 分析 | Athena | 〃 |
| 月額概算 | **$0** | **$100+** |

---

## データフロー

### 共通パイプライン
1. **データ取得**: Lambda (yfinance) → S3 Raw (CSV)
2. **変換処理**: マスターJOIN → Parquet変換
3. **カタログ化**: Glue Crawler → Athena
4. **集計ビュー**: Lambda → Athena CTAS → S3 Curated

### 構成による違い

| 処理 | 低コスト構成 | 本番構成 |
|------|-------------|----------|
| **マスターDB** | DynamoDB (無料枠) | Aurora Serverless v2 |
| **変換処理** | Lambda Transform | Glue ETL Job |
| **月額コスト** | **$0** | **$100+** |

### Curated ビュー自動生成の仕組み

Processed bucket に Parquet ファイルが作成されると、S3 イベント通知により Lambda が自動起動し、5つの集計ビューを作成します。

**生成されるビュー:**
1. `sector_daily_summary` - セクター別日次サマリー
2. `ticker_monthly_summary` - 銘柄別月次サマリー
3. `sector_performance_ranking` - セクター内パフォーマンスランキング
4. `cross_sector_comparison` - セクター横断比較（セクターローテーション分析）
5. `volatility_analysis` - ボラティリティ分析（リスク指標）

**コスト:** 5銘柄×365日で約100KBのParquet → 5クエリで~500KB = **$0.0025/回**（年間$0.91 ≈ 140円）

---

## データレイク3層構造

| 層 | バケット | 形式 | 説明 |
|----|---------|------|------|
| **Raw** | `stock-data-raw` | CSV | yfinance から取得した生データ |
| **Processed** | `stock-data-processed` | Parquet | マスターJOIN済み、パーティション分割 |
| **Curated** | `stock-data-curated` | Parquet | セクター別集計、月次サマリー等のビジネスビュー |

---

## S3 Processed バケットの構造

IoT でよく使われる  
`device/type/year/month/day` 型の階層を **株価用にアレンジ**しています。

```
s3://参照用バケット/
  sector=Technology/
    ticker=AAPL/
      year=2024/
        month=11/
          day=24/
            data.parquet
```

### Parquet カラム例

| カラム | 説明 |
|--------|------|
| ticker | 銘柄コード |
| date | 日付 |
| year / month / day | パーティションキー |
| open / high / low / close | 株価 |
| volume | 出来高 |
| sector / exchange / country | マスター（DynamoDB/Aurora）JOIN結果 |
| ingested_at | 変換処理の実行時間 |
| source_file | 元 CSV ファイル名 |

---

## マスター（DynamoDB/Aurora）

**DynamoDB（低コスト）**  
or  
**Aurora（本番想定）**

```sql
CREATE TABLE stocks (
  ticker VARCHAR(10) PRIMARY KEY,
  name VARCHAR(255),
  sector VARCHAR(100),
  exchange VARCHAR(50),
  country VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## プロジェクト構造

```
yfinance_aws_project/
├── bin/                     # CDK アプリケーションエントリポイント
├── lib/                     # CDK スタック定義（インフラコード）
├── lambda/                  # Lambda 関数コード（Python）
│   ├── fetch_stock/        # 株価データ取得
│   ├── transform_parquet/  # CSV→Parquet 変換
│   └── create_curated_views/ # 集計ビュー自動生成
├── glue/                    # Glue ETL Job スクリプト
├── dynamodb/                # DynamoDB シードデータ
├── sql/                     # Aurora セットアップスクリプト
└── docs/                    # ドキュメント・図
```

---

## デプロイ方法

### 1. 構成の選択

[`bin/stock-etl.ts` L73](./bin/stock-etl.ts#L73) で構成を選択：

```ts
const useFreeTier = true;  // 低コスト構成（DynamoDB）
// const useFreeTier = false;  // 本番構成（Aurora + Glue）
```

### 2. デプロイ

```bash
npm install
cdk bootstrap
cdk deploy --all
```

### 3. マスターデータ初期化

- **低コスト構成**: 自動投入（DynamoDB）
- **本番構成**: 手動投入が必要（Aurora）

```bash
# 本番構成の場合のみ
mysql -h <aurora-endpoint> -u admin -p stock_data_db < sql/aurora_setup.sql
```

---

## 自動化の有効化

デフォルトは **手動実行モード**（コスト削減のため）。  
自動化を有効にする場合は [`bin/stock-etl.ts`](./bin/stock-etl.ts) を編集：

```ts
scheduleEnabled = true                // EventBridge スケジュール有効化
s3EventNotificationEnabled = true     // S3 イベント通知有効化
```

### 手動実行（デフォルト）

```bash
# 株価データ取得
aws lambda invoke --function-name FetchStockDataFunction response.json

# 変換処理（低コスト構成: Lambda / 本番構成: Glue）
aws lambda invoke --function-name TransformCSVtoParquetFunction response.json
# または
aws glue start-job-run --job-name stock-etl-job

# カタログ化
aws glue start-crawler --name stock-data-processed-crawler
```

---

## 応用例

yfinance はサンプルデータソースです。Lambda 関数を差し替えることで、様々な時系列データに対応可能：

- **IoT センサーデータ**: 温度、湿度、振動などのデバイスログ
- **アプリケーションログ**: API アクセスログ、エラーログ
- **気象データ**: 気温、降水量、風速などの観測データ
- **ソーシャルメディア**: ツイート数、エンゲージメント推移
- **Web アナリティクス**: PV、UU、滞在時間などのアクセス解析

パーティション構造（`sector/ticker/year/month/day`）は、  
`region/device/year/month/day` や `service/endpoint/year/month/day` 等に置き換え可能です。

---

## 作者

**青木 大和（Yamato Aoki）**

- **職種**: データエンジニア
- **専門領域**: データ基盤構築 / ETL / クラウド活用 / 再現性ある設計
- **GitHub**: [@yamato-aoki](https://github.com/yamato-aoki)

---

## 学習ガイド

このプロジェクトを使った効果的な学習手順は [LEARNING_ROADMAP.md](./LEARNING_ROADMAP.md) を参照してください。

---
