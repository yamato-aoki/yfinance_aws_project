# DynamoDB マスターデータ

## 概要

このディレクトリには DynamoDB 用の銘柄マスターデータが含まれています。

## データファイル

- `seed_data.json`: 5銘柄のマスターデータ（AAPL, GOOGL, MSFT, TSLA, AMZN）

## データ投入方法

### 自動投入（推奨）

**CDK デプロイ時に自動的にデータが投入されます。**

```bash
cdk deploy --all
```

**理由:**
- `DynamoDBStack` の `CustomResource` が自動実行
- 手動スクリプト実行不要
- スタック削除時にデータも自動削除（クリーンアップ容易）

### 手動投入（トラブルシューティング用）

CDK デプロイ後に手動でデータを追加・更新する場合:

```bash
aws dynamodb put-item \
  --table-name stock-master \
  --item '{
    "ticker": {"S": "AAPL"},
    "name": {"S": "Apple Inc."},
    "sector": {"S": "Technology"},
    "exchange": {"S": "NASDAQ"},
    "country": {"S": "US"},
    "is_active": {"BOOL": true}
  }'
```

## データ構造

| フィールド | 型 | 説明 |
|-----------|-----|------|
| ticker | String (PK) | 銘柄コード |
| name | String | 会社名 |
| sector | String | セクター |
| exchange | String | 取引所 |
| country | String | 国 |
| is_active | Boolean | アクティブフラグ |

## データ確認

```bash
# 全データ取得
aws dynamodb scan --table-name stock-master

# 特定銘柄を取得
aws dynamodb get-item \
  --table-name stock-master \
  --key '{"ticker": {"S": "AAPL"}}'
```
