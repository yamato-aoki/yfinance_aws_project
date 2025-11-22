-- Aurora MySQL 銘柄マスターテーブル作成スクリプト
-- Database: stockdb

-- 銘柄マスターテーブル
CREATE TABLE IF NOT EXISTS stocks (
    ticker VARCHAR(10) PRIMARY KEY COMMENT '銘柄コード (例: AAPL, MSFT)',
    name VARCHAR(255) NOT NULL COMMENT '銘柄名',
    sector VARCHAR(100) COMMENT 'セクター (例: Technology, Finance)',
    exchange VARCHAR(50) COMMENT '取引所 (例: NASDAQ, NYSE)',
    country VARCHAR(50) DEFAULT 'USA' COMMENT '国',
    is_active BOOLEAN DEFAULT TRUE COMMENT 'アクティブフラグ',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '作成日時',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新日時',
    INDEX idx_sector (sector),
    INDEX idx_exchange (exchange),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='株式銘柄マスターテーブル';


-- サンプルデータの挿入
INSERT INTO stocks (ticker, name, sector, exchange, country) VALUES
    ('AAPL', 'Apple Inc.', 'Technology', 'NASDAQ', 'USA'),
    ('MSFT', 'Microsoft Corporation', 'Technology', 'NASDAQ', 'USA'),
    ('GOOGL', 'Alphabet Inc.', 'Technology', 'NASDAQ', 'USA'),
    ('AMZN', 'Amazon.com Inc.', 'Consumer Cyclical', 'NASDAQ', 'USA'),
    ('TSLA', 'Tesla Inc.', 'Automotive', 'NASDAQ', 'USA'),
    ('META', 'Meta Platforms Inc.', 'Technology', 'NASDAQ', 'USA'),
    ('NVDA', 'NVIDIA Corporation', 'Technology', 'NASDAQ', 'USA'),
    ('JPM', 'JPMorgan Chase & Co.', 'Finance', 'NYSE', 'USA'),
    ('BAC', 'Bank of America Corporation', 'Finance', 'NYSE', 'USA'),
    ('WFC', 'Wells Fargo & Company', 'Finance', 'NYSE', 'USA'),
    ('JNJ', 'Johnson & Johnson', 'Healthcare', 'NYSE', 'USA'),
    ('PFE', 'Pfizer Inc.', 'Healthcare', 'NYSE', 'USA'),
    ('XOM', 'Exxon Mobil Corporation', 'Energy', 'NYSE', 'USA'),
    ('CVX', 'Chevron Corporation', 'Energy', 'NYSE', 'USA'),
    ('WMT', 'Walmart Inc.', 'Consumer Defensive', 'NYSE', 'USA')
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    sector = VALUES(sector),
    exchange = VALUES(exchange),
    country = VALUES(country),
    updated_at = CURRENT_TIMESTAMP;


-- セクター別サマリービュー（オプション）
CREATE OR REPLACE VIEW v_stocks_by_sector AS
SELECT 
    sector,
    COUNT(*) as stock_count,
    COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_count,
    GROUP_CONCAT(ticker ORDER BY ticker SEPARATOR ', ') as tickers
FROM stocks
GROUP BY sector
ORDER BY stock_count DESC;


-- 取引所別サマリービュー（オプション）
CREATE OR REPLACE VIEW v_stocks_by_exchange AS
SELECT 
    exchange,
    COUNT(*) as stock_count,
    COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_count,
    GROUP_CONCAT(ticker ORDER BY ticker SEPARATOR ', ') as tickers
FROM stocks
GROUP BY exchange
ORDER BY stock_count DESC;


-- テーブル情報確認用クエリ
-- SELECT * FROM stocks ORDER BY sector, ticker;
-- SELECT * FROM v_stocks_by_sector;
-- SELECT * FROM v_stocks_by_exchange;
