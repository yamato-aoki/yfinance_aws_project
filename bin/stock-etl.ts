#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3Stack } from '../lib/s3-stack';
import { IamStack } from '../lib/iam-stack';
import { AuroraStack } from '../lib/aurora-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { SchedulerStack } from '../lib/scheduler-stack';
import { GlueStack } from '../lib/glue-stack';
import { AthenaStack } from '../lib/athena-stack';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { LambdaTransformStack } from '../lib/lambda-transform-stack';

/**
 * stock-etl.ts: AWS CDKアプリケーションのエントリーポイント
 * 
 * このファイルでは2つの構成を切り替えられます:
 * 
 * 【構成A: 有料版】Aurora + Glue ETL Job（実務パターン）
 * - コスト: Aurora ~$100/月 + Glue ~$10/実行
 * - 用途: 大規模データ処理、本番環境
 * 
 * 【構成B: 無料版】DynamoDB + Lambda（学習・検証用）
 * - コスト: 無料枠内で運用可能
 * - 用途: 学習、小規模データ処理
 * 
 * スタック構成:
 * 1. S3Stack: データ保存用バケット（共通）
 * 2. IamStack: IAMロールと権限設定（共通）
 * 3. LambdaStack: yfinanceデータ取得関数（共通）
 * 4. SchedulerStack: 定期実行スケジューラー（共通）
 * 
 * 【有料版のみ】
 * 5. AuroraStack: マスターデータ用データベース
 * 6. GlueStack: ETLジョブとデータカタログ
 * 
 * 【無料版のみ】
 * 5. DynamoDBStack: マスターデータ用テーブル
 * 6. LambdaTransformStack: CSV→Parquet変換関数
 * 
 * 【共通】
 * 7. AthenaStack: データ分析環境
 * 
 * デプロイ方法:
 * - 全スタック: npx cdk deploy --all
 * - 個別スタック: npx cdk deploy <StackName>
 */

const app = new cdk.App();

// ========================================
// 環境設定
// ========================================
// AWSアカウントとリージョンを環境変数から取得
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
};

// ========================================
// プロジェクト設定
// ========================================
// プロジェクト名と取得対象銘柄の定義
const projectName = 'YFinanceStockETL';
const stockTickers = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA']; // デフォルトの銘柄リスト（必要に応じて変更可能）

// ========================================
// 構成選択（有料版 or 無料版）
// ========================================
// true: DynamoDB + Lambda（無料枠）
// false: Aurora + Glue ETL Job（有料）
const useFreeTier = true;

// ========================================
// 1. S3バケットスタック
// ========================================
// 全スタックの基礎となるS3バケットを作成
const s3Stack = new S3Stack(app, 'S3Stack', {
  env,
  stackName: `${projectName}-S3Stack`,
  description: 'S3 buckets for raw and processed stock data',
});

// ========================================
// 2. IAMロールスタック
// ========================================
// LambdaとGlue用の実行ロールを作成
// S3バケットへのアクセス権限を設定
const iamStack = new IamStack(app, 'IamStack', {
  env,
  stackName: `${projectName}-IamStack`,
  description: 'IAM roles for Lambda, Glue, and other services',
  rawBucket: s3Stack.rawBucket,
  processedBucket: s3Stack.processedBucket,
});

// ========================================
// 3. Lambdaスタック（共通）
// ========================================
// yfinanceから株式データを取得する関数を作成
// 毎日前日の株価データをS3に保存
const lambdaStack = new LambdaStack(app, 'LambdaStack', {
  env,
  stackName: `${projectName}-LambdaStack`,
  description: 'Lambda function to fetch stock data from yfinance',
  rawBucket: s3Stack.rawBucket,
  lambdaRole: iamStack.lambdaRole,
  stockTickers,
});

// ========================================
// 4. Schedulerスタック（共通）
// ========================================
// EventBridge Schedulerで毎日定時にLambdaを実行
// デフォルトでは無効（コスト節約のため）
const schedulerStack = new SchedulerStack(app, 'SchedulerStack', {
  env,
  stackName: `${projectName}-SchedulerStack`,
  description: 'EventBridge Scheduler to trigger Lambda daily (disabled by default)',
  lambdaFunction: lambdaStack.fetchStockFunction,
  scheduleEnabled: false, // 学習環境では無効、本番環境ではtrueに変更
});

// ========================================
// 構成分岐: 有料版 or 無料版
// ========================================
let glueDatabase: any;
let glueCrawler: any;

if (useFreeTier) {
  // ========================================
  // 【無料版】DynamoDB + Lambda構成
  // ========================================
  console.log('Using FREE-TIER configuration: DynamoDB + Lambda');
  
  // 5-A. DynamoDBスタック
  const dynamodbStack = new DynamoDBStack(app, 'DynamoDBStack', {
    env,
    stackName: `${projectName}-DynamoDBStack`,
    description: 'DynamoDB table for stock master data (free-tier)',
  });
  
  // 6-A. Lambda変換スタック
  const lambdaTransformStack = new LambdaTransformStack(app, 'LambdaTransformStack', {
    env,
    stackName: `${projectName}-LambdaTransformStack`,
    description: 'Lambda function to transform CSV to Parquet with DynamoDB join (free-tier)',
    rawBucket: s3Stack.rawBucket,
    processedBucket: s3Stack.processedBucket,
    stockMasterTable: dynamodbStack.stockMasterTable,
    s3EventEnabled: false, // デフォルト無効
  });
  
  // 依存関係
  dynamodbStack.addDependency(s3Stack);
  lambdaTransformStack.addDependency(dynamodbStack);
  
  // Glue Crawler（カタログ用、Jobは不要）
  const glueStack = new GlueStack(app, 'GlueStack', {
    env,
    stackName: `${projectName}-GlueStack`,
    description: 'Glue database and crawler for stock data catalog (free-tier, no ETL job)',
    rawBucket: s3Stack.rawBucket,
    processedBucket: s3Stack.processedBucket,
    glueRole: iamStack.glueRole,
    // Aurora関連は不要（DynamoDB使用）
    auroraCluster: undefined as any,
    auroraSecret: undefined as any,
    s3EventNotificationEnabled: false,
  });
  
  glueStack.addDependency(lambdaTransformStack);
  glueDatabase = glueStack.glueDatabase;
  glueCrawler = glueStack.glueCrawler;
  
} else {
  // ========================================
  // 【有料版】Aurora + Glue ETL Job構成
  // ========================================
  console.log('Using PAID configuration: Aurora + Glue ETL Job');
  
  // 5-B. Auroraスタック
  const auroraStack = new AuroraStack(app, 'AuroraStack', {
    env,
    stackName: `${projectName}-AuroraStack`,
    description: 'Aurora cluster for stock master data (paid)',
  });
  
  // 6-B. Glueスタック
  const glueStack = new GlueStack(app, 'GlueStack', {
    env,
    stackName: `${projectName}-GlueStack`,
    description: 'Glue database, ETL job, and crawler for stock data processing (paid)',
    rawBucket: s3Stack.rawBucket,
    processedBucket: s3Stack.processedBucket,
    glueRole: iamStack.glueRole,
    auroraCluster: auroraStack.cluster,
    auroraSecret: auroraStack.databaseCredentials,
    s3EventNotificationEnabled: false,
  });
  
  // 依存関係
  glueStack.addDependency(iamStack);
  glueStack.addDependency(auroraStack);
  
  glueDatabase = glueStack.glueDatabase;
  glueCrawler = glueStack.glueCrawler;
}

// ========================================
// 7. Athenaスタック（共通）
// ========================================
// データ分析用のWorkGroupとNamed Queriesを作成
// QuickSightやSQLクライアントからクエリを実行可能
const athenaStack = new AthenaStack(app, 'AthenaStack', {
  env,
  stackName: `${projectName}-AthenaStack`,
  description: 'Athena workgroup and views for stock data analysis',
  processedBucket: s3Stack.processedBucket,
  glueDatabase: glueDatabase,
  glueCrawler: glueCrawler,
});

// ========================================
// 共通の依存関係設定
// ========================================
iamStack.addDependency(s3Stack);
lambdaStack.addDependency(iamStack);
schedulerStack.addDependency(lambdaStack);

// ========================================
// タグ付け
// ========================================
// 全リソースにプロジェクト名と環境情報をタグ付け
// コスト配分やリソース管理に便利
cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('Environment', 'Learning');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

app.synth();
