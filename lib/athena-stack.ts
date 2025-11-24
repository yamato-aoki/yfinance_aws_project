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
      description: 'Athenaによる株価データ分析用ワークグループ',
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
      description: '株価データとマスター情報のJOIN',
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

    // Query 2: セクター別ビュー（パーティションプルーニング活用）
    // sector階層パーティションを活用した効率的なクエリ
    new athena.CfnNamedQuery(this, 'SectorViewQuery', {
      name: 'sector_wise_view',
      description: 'パーティションプルーニングによるコスト最適化セクタービュー',
      database: props.glueDatabase.ref,
      queryString: `
-- セクター別ビュー（Technology セクターの例）
-- sector パーティションを使用することでスキャン量を削減

CREATE OR REPLACE VIEW technology_sector_stocks AS
SELECT 
  sector,
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
  exchange,
  country
FROM stock_data
WHERE sector = 'Technology'  -- パーティションプルーニングが働く
  AND year >= 2024;

-- 使い方:
-- SELECT * FROM technology_sector_stocks WHERE ticker = 'AAPL';
      `.trim(),
      workGroup: workgroup.name,
    });

    // Query 3: セクター別日次集計
    // 各セクターの日次統計を集計（IoTデバイス別集計と同じパターン）
    new athena.CfnNamedQuery(this, 'SectorDailySummaryQuery', {
      name: 'sector_daily_summary',
      description: 'セクター別日次サマリー（IoTデバイス集計パターン類似）',
      database: props.glueDatabase.ref,
      queryString: `
-- セクター別日次集計（IoT実装パターン）
-- region/device/timestamp と同じ階層構造

SELECT 
  sector,
  date,
  COUNT(DISTINCT ticker) as num_stocks,
  AVG(close) as avg_close_price,
  SUM(volume) as total_volume,
  MIN(low) as sector_min_price,
  MAX(high) as sector_max_price,
  STDDEV(close) as price_volatility
FROM stock_data
WHERE year = 2024
  AND month = '11'
GROUP BY sector, date
ORDER BY sector, date DESC;

-- 特定セクターのみ集計（パーティションプルーニング）
-- WHERE sector = 'Technology' を追加すると他セクターはスキャンされない
      `.trim(),
      workGroup: workgroup.name,
    });

    // Query 4: セクター間比較クエリ（QuickSight向け）
    // 複数セクターのパフォーマンスを比較
    new athena.CfnNamedQuery(this, 'SectorComparisonQuery', {
      name: 'sector_comparison',
      description: 'QuickSightダッシュボード用セクター横断パフォーマンス比較',
      database: props.glueDatabase.ref,
      queryString: `
-- セクター間パフォーマンス比較
-- QuickSightでセクター別ダッシュボードを作成する際に使用

SELECT 
  sector,
  COUNT(DISTINCT ticker) as num_companies,
  AVG(close) as avg_price,
  AVG(volume) as avg_volume,
  SUM(volume) as total_volume,
  MIN(date) as data_start_date,
  MAX(date) as data_end_date,
  COUNT(*) as total_records
FROM stock_data
WHERE year = 2024
GROUP BY sector
ORDER BY total_volume DESC;

-- 使用例:
-- 1. Technology vs Consumer_Cyclical の比較
-- 2. 各セクターの取引量ランキング
-- 3. QuickSightでセクター別KPIダッシュボード作成
      `.trim(),
      workGroup: workgroup.name,
    });

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にAthenaコンソールURLとリソース情報を出力
    new cdk.CfnOutput(this, 'WorkGroupName', {
      value: workgroup.name!,
      description: 'Athenaワークグループ名',
      exportName: 'AthenaWorkGroupName',
    });

    new cdk.CfnOutput(this, 'QueryResultsLocation', {
      value: `s3://${athenaResultsBucket.bucketName}/query-results/`,
      description: 'Athenaクエリ結果S3保存先',
      exportName: 'AthenaResultsLocation',
    });

    new cdk.CfnOutput(this, 'AthenaConsoleUrl', {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/athena/home?region=${cdk.Aws.REGION}#/query-editor`,
      description: 'AthenaコンソールURL',
    });
  }
}
