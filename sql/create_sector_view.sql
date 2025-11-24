-- ========================================
-- セクター別集計ビュー作成クエリ
-- ========================================
-- 
-- このクエリは Athena で実行し、セクター別の株価統計を集計した
-- Curated 層のテーブルを作成します（CTAS: CREATE TABLE AS SELECT）
-- 
-- 実行前の準備:
-- 1. Glue Crawler で stock_data_processed テーブルが作成されていること
-- 2. S3 Curated バケットが存在すること
--
-- 実行方法:
-- このファイルの {CURATED_BUCKET} を実際のバケット名に置き換えて実行
--
-- 使用例:
-- aws athena start-query-execution \
--   --query-string "$(cat sql/create_sector_view.sql)" \
--   --result-configuration "OutputLocation=s3://stock-athena-results-{ACCOUNT_ID}/" \
--   --query-execution-context "Database=stock_data_db"
-- ========================================

CREATE TABLE IF NOT EXISTS sector_daily_summary
WITH (
  format = 'PARQUET',
  external_location = 's3://{CURATED_BUCKET}/sector_daily_summary/',
  partitioned_by = ARRAY['year', 'month']
)
AS
SELECT
  sector,
  date,
  COUNT(DISTINCT ticker) as ticker_count,
  AVG(close) as avg_close_price,
  MIN(close) as min_close_price,
  MAX(close) as max_close_price,
  SUM(volume) as total_volume,
  AVG(volume) as avg_volume,
  STDDEV(close) as price_volatility,
  year,
  month
FROM stock_data_processed
WHERE sector IS NOT NULL
GROUP BY sector, date, year, month
ORDER BY date DESC, sector;
