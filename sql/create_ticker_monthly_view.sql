-- ========================================
-- 銘柄別月次サマリービュー作成クエリ
-- ========================================
-- 
-- 各銘柄の月次統計（始値・終値・高値・安値・出来高）を集計
-- 
-- 実行方法:
-- {CURATED_BUCKET} を実際のバケット名に置き換えて実行
-- ========================================

CREATE TABLE IF NOT EXISTS ticker_monthly_summary
WITH (
  format = 'PARQUET',
  external_location = 's3://{CURATED_BUCKET}/ticker_monthly_summary/',
  partitioned_by = ARRAY['year', 'month']
)
AS
SELECT
  ticker,
  sector,
  exchange,
  country,
  MIN(date) as month_start_date,
  MAX(date) as month_end_date,
  COUNT(*) as trading_days,
  
  -- 月初・月末の株価
  MIN_BY(open, date) as month_open_price,
  MAX_BY(close, date) as month_close_price,
  
  -- 月間の高値・安値
  MAX(high) as month_high,
  MIN(low) as month_low,
  
  -- 平均株価と出来高
  AVG(close) as avg_close_price,
  SUM(volume) as total_volume,
  AVG(volume) as avg_volume,
  
  -- 月間リターン（%）
  ((MAX_BY(close, date) - MIN_BY(open, date)) / MIN_BY(open, date) * 100) as monthly_return_pct,
  
  year,
  month
FROM stock_data_processed
WHERE ticker IS NOT NULL
GROUP BY ticker, sector, exchange, country, year, month
ORDER BY year DESC, month DESC, ticker;
