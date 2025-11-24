-- ========================================
-- セクター内パフォーマンスランキングビュー
-- ========================================
-- 
-- 各セクター内で銘柄をパフォーマンス順にランキング
-- - 日次リターン（前日比）
-- - 出来高
-- - ボラティリティ
-- でソート可能
--
-- 使用例:
-- - セクター内でどの銘柄が好調か？
-- - セクター内の資金流入先を特定
-- - アウトパフォーマー/アンダーパフォーマーの識別
-- ========================================

CREATE TABLE IF NOT EXISTS sector_performance_ranking
WITH (
  format = 'PARQUET',
  external_location = 's3://{CURATED_BUCKET}/sector_performance_ranking/',
  partitioned_by = ARRAY['year', 'month']
)
AS
SELECT
  sector,
  ticker,
  date,
  
  -- 株価情報
  open,
  close,
  high,
  low,
  volume,
  
  -- 前日比計算
  LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date) as prev_close,
  ((close - LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date)) / 
   LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date) * 100) as daily_return_pct,
  
  -- セクター内ランキング
  RANK() OVER (PARTITION BY sector, date ORDER BY 
    ((close - LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date)) / 
     LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date)) DESC
  ) as return_rank_in_sector,
  
  RANK() OVER (PARTITION BY sector, date ORDER BY volume DESC) as volume_rank_in_sector,
  
  -- セクター内シェア
  (volume * 100.0 / SUM(volume) OVER (PARTITION BY sector, date)) as volume_share_pct,
  
  -- 移動平均乖離率（20日MA）
  close - AVG(close) OVER (
    PARTITION BY ticker 
    ORDER BY date 
    ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
  ) as ma20_deviation,
  
  year,
  month
FROM stock_data_processed
WHERE close IS NOT NULL 
  AND sector IS NOT NULL
ORDER BY date DESC, sector, return_rank_in_sector;
