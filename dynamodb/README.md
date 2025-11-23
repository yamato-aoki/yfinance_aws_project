# DynamoDB シードデータ投入方法

## 前提条件
- DynamoDBStackがデプロイ済みであること
- AWS CLI設定済み

## 投入方法

### 方法1: Node.jsスクリプト（推奨）

```bash
node scripts/seed-dynamodb.js
```

### 方法2: AWS CLI

```bash
# 1ファイルずつ投入
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

### 方法3: AWS Console
1. DynamoDBコンソールを開く
2. テーブル `stock-master` を選択
3. 「項目を作成」をクリック
4. `dynamodb/seed_data.json` の内容を手動で入力

## データ確認

```bash
# 全データ取得
aws dynamodb scan --table-name stock-master

# 特定銘柄を取得
aws dynamodb get-item \
  --table-name stock-master \
  --key '{"ticker": {"S": "AAPL"}}'
```
