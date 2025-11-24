# 学習ロードマップ

このプロジェクトを使った効果的な学習手順をまとめました。

---

## 学習の全体像

### 学習目標
- AWS CDKによるInfrastructure as Codeの理解
- データレイク3層構造（Raw/Processed/Curated）の実装
- Lambda vs Glue の使い分け
- コスト最適化を意識した設計
- SAA-C03試験の頻出パターン習得

---

## Phase 1: 動作確認（1-2日）

### 目的
実際にデプロイして、各コンポーネントの動作を体感する

### 手順

```bash
# 1. デプロイ
npm install
cdk bootstrap
cdk deploy --all

# 2. パイプライン実行（手動実行）
# ※ スケジューラーはデフォルトで無効（bin/stock-etl.ts L122: scheduleEnabled: false）
aws lambda invoke --function-name FetchStockDataFunction response.json
aws lambda invoke --function-name TransformCSVtoParquetFunction response.json
aws glue start-crawler --name stock-data-processed-crawler

# 3. Lambda実行ログ確認
aws logs tail /aws/lambda/FetchStockDataFunction --follow
aws logs tail /aws/lambda/TransformCSVtoParquetFunction --follow
aws logs tail /aws/lambda/CreateCuratedViewsFunction --follow

# 4. S3バケット確認
aws s3 ls s3://stock-data-raw-<ACCOUNT_ID>/ --recursive
aws s3 ls s3://stock-data-processed-<ACCOUNT_ID>/ --recursive
aws s3 ls s3://stock-data-curated-<ACCOUNT_ID>/ --recursive
```

### AWS Console で確認

1. **S3**: 3つのバケットにデータが保存されているか
2. **Glue**: Crawlerが正常終了し、テーブルが作成されているか
3. **Athena**: クエリエディタで以下を実行

```sql
-- Processed データ確認
SELECT * FROM processed_db.stock_prices_parquet LIMIT 10;

-- Curated ビュー確認
SELECT * FROM curated_db.sector_daily_summary ORDER BY date DESC LIMIT 10;
SELECT * FROM curated_db.ticker_monthly_summary;
SELECT * FROM curated_db.sector_performance_ranking WHERE date = (SELECT MAX(date) FROM curated_db.sector_performance_ranking);
SELECT * FROM curated_db.cross_sector_comparison ORDER BY date DESC, performance_rank;
SELECT * FROM curated_db.volatility_analysis WHERE risk_category = 'High Risk';
```

4. **CloudWatch Logs**: Lambda実行ログを日本語で確認

### 学べること
- CDKデプロイの流れ
- Lambda/Glue/Athena の連携動作
- S3のパーティション構造（`sector/ticker/year/month/day`）
- Athenaのクエリ最適化（パーティションプルーニング）

---

## Phase 2: ソースコード深掘り（3-5日）

### 優先度順: 読むべきファイル

#### **最優先（全体像の理解）**

1. **`bin/stock-etl.ts`** (241行)
   - 全体のスタック構成
   - 依存関係の理解
   - `useFreeTier` の切り替え仕組み
   - 各スタックの役割分担

**読むポイント:**
```typescript
// L72: 構成切り替えフラグ
const useFreeTier = true;  // DynamoDB vs Aurora

// L140-220: 構成による分岐処理
if (useFreeTier) {
  // DynamoDB + Lambda Transform
} else {
  // Aurora + Glue ETL Job
}
```

---

#### **高優先（Lambda関数）**

2. **`lambda/fetch_stock/index.py`** (223行)
   - yfinance API の使用方法
   - S3へのCSV保存ロジック
   - エラーハンドリングパターン

**読むポイント:**
```python
# L87-92: 前日データ取得の理由
yesterday = datetime.now() - timedelta(days=1)
# 株式市場は当日のデータが取得できないため、前日のデータを取得

# L105-111: 休日対応
hist = stock.history(period='2d')  # 2日分取得して最新を使用

# L156-163: S3階層構造の構築
s3_key = f"raw/{ticker}/{year}/{month}/{day}/{ticker}_{date}.csv"
```

3. **`lambda/transform_parquet/index.py`** (168行)
   - DynamoDB Scan によるマスターデータ取得
   - Pandas DataFrameでのJOIN処理
   - Parquet変換とパーティション分割

**読むポイント:**
```python
# L73-75: マスターデータ取得
master_data = get_stock_master_data()

# L92-108: パーティションキー追加
df['year'] = df['date'].str[:4]
df['month'] = df['date'].str[5:7]
df['day'] = df['date'].str[8:10]

# L117-126: Parquet保存パス構築
output_key = f"sector={sector}/ticker={ticker}/year={year}/month={month}/day={day}/data.parquet"
```

4. **`lambda/create_curated_views/index.py`** (299行)
   - Athena CTAS（CREATE TABLE AS SELECT）の実装
   - 5つのビュー定義
   - クエリ完了待機ロジック

**読むポイント:**
```python
# L10-204: 5つのビュー定義（SQL埋め込み）
SQL_VIEWS = [
    {"name": "sector_daily_summary", "sql": "..."},
    {"name": "ticker_monthly_summary", "sql": "..."},
    # ...
]

# L226-249: クエリ実行とステータス監視
response = athena_client.start_query_execution(...)
status = wait_for_query_completion(query_execution_id)
```

---

#### **中優先（CDKスタック）**

5. **`lib/s3-stack.ts`** (48行)
   - 3層バケット構造（Raw/Processed/Curated）
   - ライフサイクルポリシー

6. **`lib/lambda-stack.ts`** (77行)
   - Lambda関数の定義
   - 環境変数の設定
   - IAMロールの付与

7. **`lib/lambda-curated-stack.ts`** (76行)
   - S3イベント通知の設定
   - Lambda と Athena の連携
   - 自動化の仕組み

8. **`lib/dynamodb-stack.ts`** (104行)
   - DynamoDBテーブル定義
   - CustomResourceによる自動シード投入

9. **`lib/glue-stack.ts`** (260行)
   - Glue Database/Crawler/ETL Job
   - Auroraとの接続設定

---

#### **低優先（補助的なスタック）**

10. **`lib/iam-stack.ts`** - IAMロール定義
11. **`lib/athena-stack.ts`** - Named Queries定義
12. **`lib/scheduler-stack.ts`** - EventBridge定期実行
13. **`lib/aurora-stack.ts`** - Aurora Serverless v2設定

---

### 読み方のコツ

```python
# 例: transform_parquet/index.py の読み方

# 1. ファイル冒頭のdocstringを読む
"""
Lambda Function: CSV to Parquet Transformer
...
"""

# 2. 環境変数を確認
PROCESSED_BUCKET = os.environ['PROCESSED_BUCKET']
TABLE_NAME = os.environ['TABLE_NAME']

# 3. メインロジックの流れを追う
def lambda_handler(event, context):
    # 1. S3イベントからファイル情報取得
    # 2. CSVファイル読み込み
    # 3. マスターデータ取得
    # 4. JOIN処理
    # 5. Parquet変換

# 4. エラーハンドリングを確認
try:
    # ...
except Exception as e:
    print(f"エラー: {str(e)}")
    raise

# 5. ヘルパー関数を読む
def get_stock_master_data():
    # DynamoDB Scan実装
```

---

## Phase 3: カスタマイズ実践（1週間）

### 初級: パラメータ変更

#### 銘柄リストの変更

```typescript
// bin/stock-etl.ts L68
const stockTickers = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];

// 日本株に変更してみる
const stockTickers = ['7203.T', '6758.T', '9984.T', '9983.T', '6501.T'];
// トヨタ、ソニー、ソフトバンクG、ファーストリテイリング、日立製作所
```

**手順:**
1. `bin/stock-etl.ts` を編集
2. `cdk deploy --all` で再デプロイ
3. Lambda実行して日本株データ取得
4. Athenaで確認

---

#### スケジュール時刻の変更

```typescript
// lib/scheduler-stack.ts
schedule: events.Schedule.cron({
  minute: '0',
  hour: '0',  // UTC 0時 = JST 9時
  weekDay: '*',
  month: '*',
  year: '*',
})

// JST 21時（UTC 12時）に変更
schedule: events.Schedule.cron({
  minute: '0',
  hour: '12',  // UTC 12時 = JST 21時
  weekDay: '*',
  month: '*',
  year: '*',
})
```

---

### 中級: 新しいビューを追加

#### 前日比を計算するビューを作成

```sql
-- sql/create_price_change_view.sql
CREATE OR REPLACE TABLE curated_db.daily_price_change
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/daily_price_change/'
) AS
SELECT 
  ticker,
  sector,
  date,
  close,
  LAG(close) OVER (PARTITION BY ticker ORDER BY date) as prev_close,
  ROUND((close - LAG(close) OVER (PARTITION BY ticker ORDER BY date)) / LAG(close) OVER (PARTITION BY ticker ORDER BY date) * 100, 2) as change_pct,
  volume,
  CASE 
    WHEN close > LAG(close) OVER (PARTITION BY ticker ORDER BY date) THEN 'UP'
    WHEN close < LAG(close) OVER (PARTITION BY ticker ORDER BY date) THEN 'DOWN'
    ELSE 'FLAT'
  END as direction
FROM processed_db.stock_prices_parquet
WHERE LAG(close) OVER (PARTITION BY ticker ORDER BY date) IS NOT NULL
ORDER BY date DESC, ticker;
```

**手順:**
1. SQLファイル作成
2. `lambda/create_curated_views/index.py` の `SQL_VIEWS` に追加
3. 再デプロイ
4. Lambda手動実行またはS3イベント待機

---

### 上級: 新しいデータソースに対応

#### 気象データに変更する例

1. **Lambda関数の書き換え**

```python
# lambda/fetch_weather/index.py
import requests

def lambda_handler(event, context):
    # OpenWeatherMap API などを使用
    api_key = os.environ['WEATHER_API_KEY']
    cities = ['Tokyo', 'Osaka', 'Nagoya']
    
    for city in cities:
        url = f"https://api.openweathermap.org/data/2.5/weather?q={city}&appid={api_key}"
        response = requests.get(url)
        data = response.json()
        
        # CSV作成
        csv_data = {
            'city': city,
            'date': datetime.now().strftime('%Y-%m-%d'),
            'temperature': data['main']['temp'],
            'humidity': data['main']['humidity'],
            'pressure': data['main']['pressure'],
        }
        
        # S3保存（パーティション構造変更）
        s3_key = f"raw/{city}/{year}/{month}/{day}/weather_{date}.csv"
        # ...
```

2. **パーティション構造の変更**

```python
# 変更前: sector/ticker/year/month/day
# 変更後: region/city/year/month/day

output_key = f"region={region}/city={city}/year={year}/month={month}/day={day}/data.parquet"
```

3. **マスターデータの変更**

```python
# DynamoDB: 都市マスター
{
  'city': 'Tokyo',
  'region': 'Kanto',
  'country': 'Japan',
  'timezone': 'Asia/Tokyo'
}
```

---

## Phase 4: AWS SA試験対策

### このプロジェクトがカバーする試験範囲

#### SAA-C03 ドメイン対応表

| ドメイン | 出題割合 | カバー内容 | このプロジェクトでの学習ポイント |
|---------|---------|-----------|---------------------------|
| **設計の復元力** | 26% | S3ライフサイクル、データ冗長性 | 3層バケット構造、自動削除ポリシー |
| **高パフォーマンス** | 24% | パーティション設計、クエリ最適化 | `sector/ticker/year/month/day` 階層 |
| **セキュアアプリ** | 30% | IAMロール、暗号化、VPC | `lib/iam-stack.ts`, Aurora VPC配置 |
| **コスト最適化** | 20% | サービス選択、Serverless | DynamoDB vs Aurora, Lambda vs Glue |

---

### 試験で狙われるポイントと対策

#### 1. S3パーティション設計

**試験問題例:**
> Athenaで大量のログデータを効率的にクエリしたい。どのようなS3構造にすべきか？

**このプロジェクトの解答:**
```
s3://bucket/
  sector=Technology/    ← パーティションキー
    ticker=AAPL/        ← パーティションキー
      year=2024/        ← パーティションキー
        month=11/       ← パーティションキー
          day=24/       ← パーティションキー
            data.parquet
```

**学習方法:**
- `lambda/transform_parquet/index.py` L117-126 のパス構築ロジックを読む
- Athenaで `WHERE sector='Technology' AND year='2024'` を実行
- CloudWatch Logs で「スキャンされたデータ量」を確認（パーティションプルーニング効果）

---

#### 2. Lambda vs Glue の使い分け

**試験問題例:**
> 毎日10GBのCSVファイルを処理する必要がある。最適なサービスは？

**判断基準:**
| 条件 | 推奨 | 理由 |
|------|------|------|
| データ量 < 250MB | Lambda | 15分タイムアウト、低コスト |
| データ量 > 250MB | Glue | Sparkで大規模処理、スケーラブル |
| 処理時間 < 15分 | Lambda | シンプル、起動高速 |
| 処理時間 > 15分 | Glue | タイムアウトなし |

**学習方法:**
- `bin/stock-etl.ts` L140-220 の分岐処理を読む
- Lambda版とGlue版の両方をデプロイして比較
- CloudWatch Logsで実行時間とメモリ使用量を確認

---

#### 3. EventBridge Scheduler

**試験問題例:**
> Lambda関数を毎日午前9時（JST）に実行したい。どう設定すべきか？

**このプロジェクトの解答:**
```typescript
// lib/scheduler-stack.ts
schedule: events.Schedule.cron({
  minute: '0',
  hour: '0',  // UTC 0時 = JST 9時
  weekDay: '*',
  month: '*',
  year: '*',
})
```

**学習方法:**
- `lib/scheduler-stack.ts` の全体を読む
- タイムゾーンの扱い（UTC vs JST）を理解
- 実際にスケジュール時刻を変更して動作確認

---

#### 4. DynamoDB vs Aurora 選択基準

**試験問題例:**
> マスターデータを保存する。どのDBを選択すべきか？

**判断基準:**
| 要件 | DynamoDB | Aurora |
|------|----------|--------|
| スキーマ変更頻度 | 高い → ○ | 低い → △ |
| トランザクション | 不要 → ○ | 必要 → ○ |
| JOIN処理 | できない → × | 得意 → ○ |
| コスト | 小規模なら安い | 常時課金 |
| 運用負荷 | サーバーレス | VPC管理必要 |

**学習方法:**
- `lib/dynamodb-stack.ts` と `lib/aurora-stack.ts` を比較
- 両方デプロイしてAWS Console で料金確認
- マスターデータのJOIN処理の違いを体感

---

### AWS サービス別 学習優先度

| サービス | このプロジェクトでの役割 | SAA試験での重要度 | 学習すべきファイル |
|---------|----------------------|-----------------|------------------|
| **Lambda** | データ取得・変換・Curated生成 | ★★★ 必須 | `lib/lambda-stack.ts`, `lambda/*/index.py` |
| **S3** | 3層データレイク | ★★★ 必須 | `lib/s3-stack.ts` |
| **Glue** | ETLジョブ・Crawler・Catalog | ★★★ 頻出 | `lib/glue-stack.ts`, `glue/etl_job.py` |
| **Athena** | サーバーレスクエリ | ★★ よく出る | `lib/athena-stack.ts` |
| **DynamoDB** | NoSQLマスターDB | ★★★ 必須 | `lib/dynamodb-stack.ts` |
| **Aurora** | RDBSマスターDB | ★★★ 必須 | `lib/aurora-stack.ts` |
| **EventBridge** | スケジューラー | ★★ 中程度 | `lib/scheduler-stack.ts` |
| **IAM** | 権限管理 | ★★★ 必須 | `lib/iam-stack.ts` |
| **CloudWatch Logs** | ログ管理 | ★★ よく出る | Lambda関数実行後に確認 |

---

## Phase 5: アウトプット（継続）

### 学んだことを外部に発信

#### 1. 技術ブログ記事を書く

**記事テーマ例:**
- 「AWS CDKでデータレイクを構築してみた」
- 「Lambda vs Glue ETL: いつどちらを使うべきか」
- 「Athenaのパーティション最適化実践」
- 「DynamoDB CustomResourceで自動シードデータ投入」
- 「S3イベント通知でCurated層を自動生成する方法」

**構成例:**
1. 背景・目的
2. アーキテクチャ図（このREADMEのMermaid図を使用）
3. 実装のポイント
4. ハマったポイント
5. まとめ・今後の改善点

---

#### 2. 社内/コミュニティで発表

**スライド構成例:**
1. 自己紹介
2. プロジェクト概要（このREADMEをベース）
3. 実際にデモ（AWS Consoleで動作を見せる）
4. コスト比較（DynamoDB vs Aurora）
5. 学んだこと・質疑応答

---

#### 3. GitHubで改善PRを作る

**改善アイデア:**
- [ ] テストコード追加（Jest, pytest）
- [ ] CI/CD構築（GitHub Actions）
- [ ] コスト可視化（AWS Cost Explorer連携）
- [ ] エラー通知（SNS連携）
- [ ] バックアップ自動化（S3 Versioning, Aurora Snapshot）
- [ ] 監視ダッシュボード（CloudWatch Dashboard）

**手順:**
1. Issueを作成
2. ブランチ作成
3. 実装
4. Pull Request作成
5. 自分でマージ（または他の人にレビュー依頼）

---

## 推奨学習スケジュール

### 4週間プラン

#### Week 1: 環境構築と動作確認
- [ ] Day 1-2: デプロイ → 動作確認
- [ ] Day 3-4: AWS Console で各サービス確認
- [ ] Day 5-6: CloudWatch Logs でログ解析
- [ ] Day 7: 振り返りと疑問点整理

#### Week 2: ソースコード読解
- [ ] Day 8-9: `bin/stock-etl.ts` + Lambda関数3つ
- [ ] Day 10-11: CDKスタック（S3, Lambda, Curated）
- [ ] Day 12-13: CDKスタック（DynamoDB, Glue, Athena）
- [ ] Day 14: コードレビュー・メモ作成

#### Week 3: カスタマイズ実践
- [ ] Day 15-16: 銘柄リスト変更 → デプロイ → 動作確認
- [ ] Day 17-18: スケジュール時刻変更
- [ ] Day 19-20: 新しいビュー追加
- [ ] Day 21: 振り返りとブログ下書き

#### Week 4: アウトプットとSA試験対策
- [ ] Day 22-23: ブログ記事執筆
- [ ] Day 24-25: SA試験の該当範囲を問題集で復習
- [ ] Day 26-27: このプロジェクトの改善点を洗い出し
- [ ] Day 28: 次の学習計画を立てる

---

## よくある質問（FAQ）

### Q1: デプロイ時にエラーが出た

**A:** 以下を確認してください：

```bash
# AWS認証情報確認
aws sts get-caller-identity

# CDKバージョン確認
cdk --version
# → 2.120.0 を推奨

# Node.js バージョン確認
node --version
# → v18以上を推奨

# npm依存関係再インストール
rm -rf node_modules package-lock.json
npm install
```

---

### Q2: Athenaでテーブルが見つからない

**A:** Glue Crawlerを実行してください：

```bash
# Crawler実行
aws glue start-crawler --name stock-data-processed-crawler

# ステータス確認
aws glue get-crawler --name stock-data-processed-crawler

# テーブル一覧確認
aws glue get-tables --database-name processed_db
```

---

### Q3: Lambda実行でタイムアウトエラー

**A:** タイムアウト設定を延長してください：

```typescript
// lib/lambda-stack.ts
timeout: cdk.Duration.minutes(5),  // 2分 → 5分に変更
```

---

### Q4: コストが心配

**A:** 以下で抑えられます：

- **無料枠を活用**: DynamoDB構成（デフォルト）を使用
- **手動実行のみ**: スケジューラーを無効化（デフォルト）
- **こまめに削除**: 不要なデータは自動削除ポリシーで対応済み
- **リージョン選択**: `ap-northeast-1`（東京）を使用

**概算:**
- DynamoDB構成: **月額 $0**（無料枠内）
- Aurora構成: **月額 ~$100**

---

### Q5: 日本株データが取得できない

**A:** yfinanceの銘柄コード形式を確認：

```typescript
// 正しい形式
const stockTickers = ['7203.T', '6758.T'];  // .T を付ける

// 誤った形式
const stockTickers = ['7203', '6758'];  // これではダメ
```

---

## 参考リンク

### AWS公式ドキュメント
- [AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [Amazon Athena User Guide](https://docs.aws.amazon.com/athena/latest/ug/what-is.html)
- [AWS Glue Developer Guide](https://docs.aws.amazon.com/glue/latest/dg/what-is-glue.html)

### SAA試験対策
- [AWS認定ソリューションアーキテクト – アソシエイト試験ガイド](https://aws.amazon.com/jp/certification/certified-solutions-architect-associate/)
- [AWS Well-Architected Framework](https://aws.amazon.com/jp/architecture/well-architected/)

### 外部ライブラリ
- [yfinance Documentation](https://pypi.org/project/yfinance/)
- [pandas Documentation](https://pandas.pydata.org/docs/)

---

## まとめ

このプロジェクトは**実務パターン**を再現した学習教材です。

- AWS CDKによるInfrastructure as Code
- データレイク3層構造（業界標準）
- コスト最適化を意識した設計
- SAA試験の頻出パターン網羅

**推奨学習順序:**
1. デプロイ → 動作確認
2. ソースコード読解
3. カスタマイズ実践
4. アウトプット

**継続的に改善しながら学んでいきましょう！**
