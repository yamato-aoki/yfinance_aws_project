-- ========================================
-- セクター間比較ビュー（セクターローテーション分析）
-- ========================================
-- 
-- セクター間のパフォーマンス比較
-- - 日次リターン
-- - 出来高トレンド
-- - 資金流入/流出の検出
--
-- 使用例:
-- - どのセクターに資金が流入しているか？
-- - セクターローテーションの兆候を検出
-- - 景気サイクルとセクターパフォーマンスの相関分析
-- ========================================

CREATE TABLE IF NOT EXISTS cross_sector_comparison
WITH (
  format = 'PARQUET',
  external_location = 's3://{CURATED_BUCKET}/cross_sector_comparison/',
  partitioned_by = ARRAY['year', 'month']
)
AS
SELECT
  sector,
  date,
  
  -- セクター別集計
  COUNT(DISTINCT ticker) as ticker_count,
  
  -- 株価指標
  AVG(close) as avg_close,
  MIN(close) as min_close,
  MAX(close) as max_close,
  STDDEV(close) as price_volatility,
  
  -- 出来高指標
  SUM(volume) as total_volume,
  AVG(volume) as avg_volume,
  
  -- 前日比計算
  LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date) as prev_avg_close,
  
  ((AVG(close) - LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date)) / 
   LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date) * 100) as sector_daily_return_pct,
  
  -- 出来高変化率
  ((SUM(volume) - LAG(SUM(volume), 1) OVER (PARTITION BY sector ORDER BY date)) / 
   LAG(SUM(volume), 1) OVER (PARTITION BY sector ORDER BY date) * 100) as volume_change_pct,
  
  -- 全セクター比較
  RANK() OVER (PARTITION BY date ORDER BY 
    ((AVG(close) - LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date)) / 
     LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date)) DESC
  ) as performance_rank,
  
  -- 資金流入指標（出来高×株価変化率）
  (SUM(volume) * 
   ((AVG(close) - LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date)) / 
    LAG(AVG(close), 1) OVER (PARTITION BY sector ORDER BY date))) as money_flow_indicator,
  
  -- 移動平均（7日、30日）
  AVG(AVG(close)) OVER (
    PARTITION BY sector 
    ORDER BY date 
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) as ma7,
  
  AVG(AVG(close)) OVER (
    PARTITION BY sector 
    ORDER BY date 
    ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
  ) as ma30,
  
  year,
  month
FROM stock_data_processed
WHERE sector IS NOT NULL
GROUP BY sector, date, year, month
ORDER BY date DESC, performance_rank;
