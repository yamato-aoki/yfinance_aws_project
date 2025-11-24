-- ========================================
-- Aurora 初期セットアップ用 SQL
-- ========================================
-- 
-- 本番構成（Aurora Serverless v2）を選択した場合の
-- マスターデータベース初期化スクリプト
--
-- 実行方法:
-- 1. AWS Console → RDS → Query Editor で実行
-- 2. または MySQL クライアントで接続:
--    mysql -h <aurora-endpoint> -u admin -p stock_data_db < sql/aurora_setup.sql
--
-- 注意:
-- - Secrets Manager に保存されたパスワードを使用
-- - VPC 内からの接続、または Bastion 経由で実行
-- ========================================

USE stock_data_db;

-- ========================================
-- 1. 銘柄マスターテーブル作成
-- ========================================

CREATE TABLE IF NOT EXISTS stocks (
  ticker VARCHAR(10) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sector VARCHAR(100),
  exchange VARCHAR(50),
  country VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sector (sector),
  INDEX idx_exchange (exchange),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================
-- 2. シードデータ投入
-- ========================================

INSERT INTO stocks (ticker, name, sector, exchange, country, is_active) VALUES
  ('AAPL', 'Apple Inc.', 'Technology', 'NASDAQ', 'US', TRUE),
  ('GOOGL', 'Alphabet Inc.', 'Technology', 'NASDAQ', 'US', TRUE),
  ('MSFT', 'Microsoft Corporation', 'Technology', 'NASDAQ', 'US', TRUE),
  ('TSLA', 'Tesla Inc.', 'Automotive', 'NASDAQ', 'US', TRUE),
  ('AMZN', 'Amazon.com Inc.', 'Consumer_Cyclical', 'NASDAQ', 'US', TRUE)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  sector = VALUES(sector),
  exchange = VALUES(exchange),
  country = VALUES(country),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;

-- ========================================
-- 3. データ確認
-- ========================================

SELECT 
  ticker,
  name,
  sector,
  exchange,
  country,
  is_active,
  created_at
FROM stocks
ORDER BY ticker;

-- ========================================
-- 完了メッセージ
-- ========================================
-- Aurora マスターデータベースのセットアップが完了しました
-- 
-- 次のステップ:
-- 1. Glue ETL Job を実行して Processed データを作成
-- 2. Glue Crawler を実行してカタログ化
-- 3. Athena でクエリ実行
-- ========================================
