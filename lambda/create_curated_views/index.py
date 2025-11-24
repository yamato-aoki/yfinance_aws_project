import json
import boto3
import time
from typing import Dict, List

athena_client = boto3.client('athena')
s3_client = boto3.client('s3')

# Curated views SQL definitions
SQL_VIEWS = [
    {
        "name": "sector_daily_summary",
        "sql": """
CREATE OR REPLACE TABLE curated_db.sector_daily_summary
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/sector_daily_summary/'
) AS
SELECT 
    sector,
    date,
    COUNT(*) as ticker_count,
    ROUND(AVG(close), 2) as avg_close,
    ROUND(AVG(volume), 0) as avg_volume,
    ROUND(MIN(low), 2) as sector_min,
    ROUND(MAX(high), 2) as sector_max
FROM processed_db.stock_prices_parquet
GROUP BY sector, date
ORDER BY date DESC, sector
"""
    },
    {
        "name": "ticker_monthly_summary",
        "sql": """
CREATE OR REPLACE TABLE curated_db.ticker_monthly_summary
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/ticker_monthly_summary/'
) AS
SELECT 
    ticker,
    sector,
    DATE_TRUNC('month', date) as month,
    ROUND(AVG(close), 2) as monthly_avg_close,
    ROUND(MAX(high), 2) as monthly_high,
    ROUND(MIN(low), 2) as monthly_low,
    ROUND(SUM(volume), 0) as total_volume,
    COUNT(*) as trading_days
FROM processed_db.stock_prices_parquet
GROUP BY ticker, sector, DATE_TRUNC('month', date)
ORDER BY ticker, month DESC
"""
    },
    {
        "name": "sector_performance_ranking",
        "sql": """
CREATE OR REPLACE TABLE curated_db.sector_performance_ranking
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/sector_performance_ranking/'
) AS
WITH daily_returns AS (
  SELECT 
    ticker,
    sector,
    date,
    close,
    volume,
    LAG(close) OVER (PARTITION BY ticker ORDER BY date) as prev_close,
    AVG(close) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20
  FROM processed_db.stock_prices_parquet
),
ranked_data AS (
  SELECT 
    sector,
    ticker,
    date,
    close,
    ROUND(((close - prev_close) / prev_close * 100), 2) as daily_return,
    volume,
    ROUND(((close - ma20) / ma20 * 100), 2) as deviation_from_ma20,
    RANK() OVER (PARTITION BY sector, date ORDER BY ((close - prev_close) / prev_close) DESC) as return_rank,
    RANK() OVER (PARTITION BY sector, date ORDER BY volume DESC) as volume_rank
  FROM daily_returns
  WHERE prev_close IS NOT NULL
)
SELECT 
  sector,
  ticker,
  date,
  close,
  daily_return,
  volume,
  deviation_from_ma20,
  return_rank,
  volume_rank,
  ROUND((volume * 100.0 / SUM(volume) OVER (PARTITION BY sector, date)), 2) as volume_share_pct
FROM ranked_data
ORDER BY date DESC, sector, return_rank
"""
    },
    {
        "name": "cross_sector_comparison",
        "sql": """
CREATE OR REPLACE TABLE curated_db.cross_sector_comparison
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/cross_sector_comparison/'
) AS
WITH sector_metrics AS (
  SELECT 
    sector,
    date,
    AVG(close) as avg_close,
    AVG(volume) as avg_volume,
    LAG(AVG(close)) OVER (PARTITION BY sector ORDER BY date) as prev_avg_close,
    AVG(AVG(close)) OVER (PARTITION BY sector ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) as ma7,
    AVG(AVG(close)) OVER (PARTITION BY sector ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as ma30
  FROM processed_db.stock_prices_parquet
  GROUP BY sector, date
)
SELECT 
  sector,
  date,
  ROUND(avg_close, 2) as avg_close,
  ROUND(avg_volume, 0) as avg_volume,
  ROUND(((avg_close - prev_avg_close) / prev_avg_close * 100), 2) as sector_daily_return_pct,
  ROUND(ma7, 2) as ma7,
  ROUND(ma30, 2) as ma30,
  CASE 
    WHEN ma7 > ma30 THEN 'Bullish'
    WHEN ma7 < ma30 THEN 'Bearish'
    ELSE 'Neutral'
  END as trend,
  ROUND((avg_volume - LAG(avg_volume) OVER (PARTITION BY sector ORDER BY date)) / LAG(avg_volume) OVER (PARTITION BY sector ORDER BY date) * 100, 2) as money_flow_indicator,
  RANK() OVER (PARTITION BY date ORDER BY ((avg_close - prev_avg_close) / prev_avg_close) DESC) as performance_rank
FROM sector_metrics
WHERE prev_avg_close IS NOT NULL
ORDER BY date DESC, performance_rank
"""
    },
    {
        "name": "volatility_analysis",
        "sql": """
CREATE OR REPLACE TABLE curated_db.volatility_analysis
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://{curated_bucket}/views/volatility_analysis/'
) AS
WITH daily_returns AS (
  SELECT 
    ticker,
    sector,
    date,
    close,
    LAG(close) OVER (PARTITION BY ticker ORDER BY date) as prev_close
  FROM processed_db.stock_prices_parquet
),
return_calcs AS (
  SELECT 
    ticker,
    sector,
    date,
    close,
    ((close - prev_close) / prev_close) as daily_return
  FROM daily_returns
  WHERE prev_close IS NOT NULL
),
volatility_metrics AS (
  SELECT 
    ticker,
    sector,
    date,
    ROUND(STDDEV(daily_return) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) * SQRT(252) * 100, 2) as volatility_20d,
    ROUND(STDDEV(daily_return) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) * SQRT(252) * 100, 2) as volatility_60d,
    ROUND(AVG(daily_return) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) * 252 * 100, 2) as annualized_return_60d,
    MAX(close) OVER (PARTITION BY ticker ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) as max_close_60d,
    close
  FROM return_calcs
)
SELECT 
  ticker,
  sector,
  date,
  volatility_20d,
  volatility_60d,
  annualized_return_60d,
  ROUND(annualized_return_60d / NULLIF(volatility_60d, 0), 2) as sharpe_ratio,
  ROUND(((max_close_60d - close) / max_close_60d * 100), 2) as max_drawdown_pct,
  CASE 
    WHEN volatility_60d < 15 THEN 'Low Risk'
    WHEN volatility_60d < 25 THEN 'Medium Risk'
    ELSE 'High Risk'
  END as risk_category
FROM volatility_metrics
WHERE volatility_60d IS NOT NULL
ORDER BY date DESC, ticker
"""
    }
]

def lambda_handler(event, context):
    """
    S3 Processed bucket へのオブジェクト作成をトリガーに
    Curated views を自動生成する Lambda 関数
    """
    print(f"Event: {json.dumps(event)}")
    
    # 環境変数から設定取得
    curated_bucket = context.function_name.split('-')[-2]  # 簡易的な取得
    # より確実な方法: 環境変数を使用
    import os
    curated_bucket = os.environ.get('CURATED_BUCKET', curated_bucket)
    database_name = os.environ.get('DATABASE_NAME', 'curated_db')
    output_location = os.environ.get('ATHENA_OUTPUT', f's3://{curated_bucket}/athena-results/')
    
    results = []
    
    for view_def in SQL_VIEWS:
        view_name = view_def['name']
        sql = view_def['sql'].format(curated_bucket=curated_bucket)
        
        print(f"Creating view: {view_name}")
        
        try:
            # Athena クエリ実行
            response = athena_client.start_query_execution(
                QueryString=sql,
                QueryExecutionContext={'Database': database_name},
                ResultConfiguration={'OutputLocation': output_location}
            )
            
            query_execution_id = response['QueryExecutionId']
            print(f"Query execution ID: {query_execution_id}")
            
            # クエリ完了待機
            status = wait_for_query_completion(query_execution_id)
            
            results.append({
                'view_name': view_name,
                'query_execution_id': query_execution_id,
                'status': status
            })
            
        except Exception as e:
            print(f"Error creating view {view_name}: {str(e)}")
            results.append({
                'view_name': view_name,
                'status': 'FAILED',
                'error': str(e)
            })
    
    # 結果サマリー
    success_count = sum(1 for r in results if r['status'] == 'SUCCEEDED')
    print(f"\nCompleted: {success_count}/{len(SQL_VIEWS)} views created successfully")
    
    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': f'{success_count}/{len(SQL_VIEWS)} Curated views created',
            'results': results
        })
    }

def wait_for_query_completion(query_execution_id: str, max_wait: int = 300) -> str:
    """
    Athena クエリの完了を待機
    
    Args:
        query_execution_id: クエリ実行ID
        max_wait: 最大待機時間（秒）
    
    Returns:
        クエリステータス（SUCCEEDED/FAILED/CANCELLED）
    """
    waited = 0
    while waited < max_wait:
        response = athena_client.get_query_execution(
            QueryExecutionId=query_execution_id
        )
        
        status = response['QueryExecution']['Status']['State']
        
        if status in ['SUCCEEDED', 'FAILED', 'CANCELLED']:
            if status == 'FAILED':
                reason = response['QueryExecution']['Status'].get('StateChangeReason', 'Unknown')
                print(f"Query failed: {reason}")
            return status
        
        time.sleep(2)
        waited += 2
    
    return 'TIMEOUT'
