import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

/**
 * AthenaStackProps: Athenaスタックに必要なプロパティ
 */
export interface AthenaStackProps extends cdk.StackProps {
  processedBucket: s3.Bucket;      // 加工済みデータバケット（Parquet）
  glueDatabase: glue.CfnDatabase;  // Glueデータベース
  glueCrawler: glue.CfnCrawler;    // Glue Crawler
}

/**
 * AthenaStack: AWS Athenaでデータ分析
 * 
 * このスタックでは:
 * 1. Athena WorkGroup: クエリ実行環境とコスト管理
 * 2. Named Queries: 再利用可能なクエリテンプレート
 * 
 * ユースケース:
 * - セクター別の株価分析
 * - 月次集計レポート
 * - QuickSightと連携したダッシュボード作成
 * 
 * 注意:
 * - Crawler実行後にテーブル名が決定されるため、Named Queriesはテンプレートとして提供
 * - 実際のテーブル名に合わせて修正が必要
 */
export class AthenaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AthenaStackProps) {
    super(scope, id, props);

    // ========================================
    // 1. Athenaクエリ結果用バケット
    // ========================================
    // クエリ実行結果を保存するバケット（7日後に自動削除）
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaQueryResultsBucket', {
      bucketName: `athena-query-results-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldQueryResults',
          enabled: true,
          expiration: cdk.Duration.days(7),
        },
      ],
    });

    // ========================================
    // 2. Athena WorkGroup作成
    // ========================================
    // クエリ実行環境を定義し、コスト管理とログ収集を設定
    const workgroup = new athena.CfnWorkGroup(this, 'StockDataWorkGroup', {
      name: 'stock-data-analytics',
      description: 'Workgroup for stock data analysis with Athena',
      state: 'ENABLED',
      workGroupConfiguration: {
        resultConfiguration: {
          outputLocation: `s3://${athenaResultsBucket.bucketName}/query-results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3',
          },
        },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        engineVersion: {
          selectedEngineVersion: 'AUTO',
        },
      },
    });

    // ========================================
    // 3. Named Queries（クエリテンプレート）
    // ========================================
    // 再利用可能なクエリテンプレートを作成
    // Crawler実行後にテーブル名を修正して使用してください

    // Query 1: マスターデータとの結合ビュー
    new athena.CfnNamedQuery(this, 'StockDataWithMasterQuery', {
      name: 'stock_data_with_master',
      description: 'Join stock data with master information from Aurora',
      database: props.glueDatabase.ref,
      queryString: `
-- This is a sample query. Adjust table names after Glue Crawler runs.
-- Table name will be based on your S3 structure, likely 'stock_data' or similar

-- Example: Create view joining stock data with master
-- Note: Aurora master join requires Athena Federated Query or data sync to S3
-- For learning purposes, this shows the structure

CREATE OR REPLACE VIEW stock_data_enriched AS
SELECT 
  ticker,
  date,
  year,
  month,
  day,
  open,
  high,
  low,
  close,
  volume,
  -- sector, exchange, country would come from Aurora master join
  ingested_at,
  source_file
FROM stock_data  -- Adjust table name after crawler runs
WHERE year >= 2024;
      `.trim(),
      workGroup: workgroup.name,
    });

    // Query 2: Techセクターの日次集計ビュー
    // 特定セクターの株価動向を分析するためのテンプレート
    new athena.CfnNamedQuery(this, 'TechSectorViewQuery', {
      name: 'tech_sector_daily_summary',
      description: 'Daily summary for Tech sector stocks',
      database: props.glueDatabase.ref,
      queryString: `
-- Tech sector daily summary
-- Adjust ticker list based on your master data

CREATE OR REPLACE VIEW tech_sector_daily AS
SELECT 
  date,
  COUNT(DISTINCT ticker) as num_stocks,
  AVG(close) as avg_close_price,
  SUM(volume) as total_volume,
  MIN(low) as min_price,
  MAX(high) as max_price
FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL')  -- Tech sector tickers
  AND year >= 2024
GROUP BY date
ORDER BY date DESC;
      `.trim(),
      workGroup: workgroup.name,
    });

    // Query 3: セクター別UNION ALLビューテンプレート
    // QuickSightで複数セクターを一括でクエリするためのパターン
    new athena.CfnNamedQuery(this, 'SectorUnionViewQuery', {
      name: 'sector_wise_union_template',
      description: 'Template for creating sector-wise UNION ALL views',
      database: props.glueDatabase.ref,
      queryString: `
-- Sector-wise union template (Tech sector example)
-- This allows QuickSight to query all Tech sector stocks as a single dataset

CREATE OR REPLACE VIEW tech_sector_all_stocks AS
SELECT 
  'Tech' as sector,
  ticker,
  date,
  year,
  month,
  day,
  open,
  high,
  low,
  close,
  volume,
  ingested_at
FROM stock_data
WHERE ticker IN ('AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA')
  AND year >= 2024

UNION ALL

-- Add more sectors as needed
-- SELECT 'Finance' as sector, ticker, date, ... FROM stock_data WHERE ticker IN (...)
;
      `.trim(),
      workGroup: workgroup.name,
    });

    // Query 4: 月次集計クエリ
    // 銘柄ごとの月次統計を集計するテンプレート
    new athena.CfnNamedQuery(this, 'MonthlyAggregationQuery', {
      name: 'monthly_stock_summary',
      description: 'Monthly aggregation of stock prices',
      database: props.glueDatabase.ref,
      queryString: `
-- Monthly summary by ticker
SELECT 
  ticker,
  year,
  month,
  COUNT(*) as trading_days,
  AVG(close) as avg_close,
  MIN(low) as month_low,
  MAX(high) as month_high,
  SUM(volume) as total_volume
FROM stock_data
WHERE year >= 2024
GROUP BY ticker, year, month
ORDER BY ticker, year DESC, month DESC;
      `.trim(),
      workGroup: workgroup.name,
    });

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にAthenaコンソールURLとリソース情報を出力
    new cdk.CfnOutput(this, 'WorkGroupName', {
      value: workgroup.name!,
      description: 'Athena workgroup name',
      exportName: 'AthenaWorkGroupName',
    });

    new cdk.CfnOutput(this, 'QueryResultsLocation', {
      value: `s3://${athenaResultsBucket.bucketName}/query-results/`,
      description: 'Athena query results S3 location',
      exportName: 'AthenaResultsLocation',
    });

    new cdk.CfnOutput(this, 'AthenaConsoleUrl', {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/athena/home?region=${cdk.Aws.REGION}#/query-editor`,
      description: 'Athena console URL',
    });
  }
}
