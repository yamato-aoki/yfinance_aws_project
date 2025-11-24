-- ========================================
-- ボラティリティ分析ビュー（リスク指標）
-- ========================================
-- 
-- 各銘柄とセクターのボラティリティ（変動性）を分析
-- - 標準偏差（リスク）
-- - ベータ値（市場感応度）
-- - シャープレシオ（リスク調整後リターン）
--
-- 使用例:
-- - リスク許容度に応じた銘柄選択
-- - ポートフォリオのリスク管理
-- - ボラティリティトレーディング戦略
-- ========================================

CREATE TABLE IF NOT EXISTS volatility_analysis
WITH (
  format = 'PARQUET',
  external_location = 's3://{CURATED_BUCKET}/volatility_analysis/',
  partitioned_by = ARRAY['year', 'month']
)
AS
WITH daily_returns AS (
  SELECT
    ticker,
    sector,
    date,
    close,
    ((close - LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date)) / 
     LAG(close, 1) OVER (PARTITION BY ticker ORDER BY date)) as daily_return,
    year,
    month
  FROM stock_data_processed
  WHERE close IS NOT NULL
),
rolling_stats AS (
  SELECT
    ticker,
    sector,
    date,
    close,
    daily_return,
    
    -- 20日間のボラティリティ（標準偏差）
    STDDEV(daily_return) OVER (
      PARTITION BY ticker 
      ORDER BY date 
      ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
    ) as volatility_20d,
    
    -- 60日間のボラティリティ
    STDDEV(daily_return) OVER (
      PARTITION BY ticker 
      ORDER BY date 
      ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
    ) as volatility_60d,
    
    -- 平均リターン（20日）
    AVG(daily_return) OVER (
      PARTITION BY ticker 
      ORDER BY date 
      ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
    ) as avg_return_20d,
    
    -- 最大ドローダウン（20日）
    close - MAX(close) OVER (
      PARTITION BY ticker 
      ORDER BY date 
      ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
    ) as max_drawdown_20d,
    
    year,
    month
  FROM daily_returns
)
SELECT
  ticker,
  sector,
  date,
  close,
  daily_return,
  
  -- ボラティリティ指標
  volatility_20d,
  volatility_60d,
  (volatility_20d * SQRT(252)) as annualized_volatility,  -- 年率換算
  
  -- リターン指標
  avg_return_20d,
  (avg_return_20d * 252) as annualized_return,  -- 年率換算
  
  -- リスク調整後リターン（簡易シャープレシオ）
  CASE 
    WHEN volatility_20d > 0 THEN avg_return_20d / volatility_20d
    ELSE NULL
  END as sharpe_ratio_approx,
  
  -- 最大ドローダウン
  max_drawdown_20d,
  (max_drawdown_20d / close * 100) as max_drawdown_pct,
  
  -- ボラティリティランク（セクター内）
  RANK() OVER (PARTITION BY sector, date ORDER BY volatility_20d DESC) as volatility_rank_in_sector,
  
  -- リスクカテゴリ分類
  CASE
    WHEN volatility_20d < 0.01 THEN 'Low'
    WHEN volatility_20d < 0.02 THEN 'Medium'
    WHEN volatility_20d < 0.03 THEN 'High'
    ELSE 'Very High'
  END as risk_category,
  
  year,
  month
FROM rolling_stats
WHERE volatility_20d IS NOT NULL
ORDER BY date DESC, volatility_20d DESC;
