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

/**
 * stock-etl.ts: AWS CDKアプリケーションのエントリーポイント
 * 
 * このファイルでは7つのスタックを作成し、依存関係を設定します:
 * 
 * スタック構成:
 * 1. S3Stack: データ保存用バケット（基礎インフラ）
 * 2. IamStack: IAMロールと権限設定
 * 3. AuroraStack: マスターデータ用データベース
 * 4. LambdaStack: yfinanceデータ取得関数
 * 5. SchedulerStack: 定期実行スケジューラー
 * 6. GlueStack: ETLジョブとデータカタログ
 * 7. AthenaStack: データ分析環境
 * 
 * 依存関係:
 * S3Stack → IamStack → LambdaStack/AuroraStack → GlueStack → AthenaStack
 *                          ↓
 *                    SchedulerStack
 * 
 * デプロイ方法:
 * - 全スタック: npx cdk deploy --all
 * - 個別スタック: npx cdk deploy <StackName>
 * - 推奨順序: S3 → IAM → Lambda → Aurora → Glue → Athena
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
// 3. Auroraスタック
// ========================================
// 株式マスターデータ用のServerless v2クラスターを作成
// VPC、セキュリティグループ、Secrets Managerも含む
const auroraStack = new AuroraStack(app, 'AuroraStack', {
  env,
  stackName: `${projectName}-AuroraStack`,
  description: 'Aurora cluster for stock master data',
});

// ========================================
// 4. Lambdaスタック
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
// 5. Schedulerスタック
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
// 6. Glueスタック
// ========================================
// CSV→Parquet変換とAuroraマスターJOINを行うETLジョブ
// Glue Database、Crawler、オプションでS3イベント通知も含む
const glueStack = new GlueStack(app, 'GlueStack', {
  env,
  stackName: `${projectName}-GlueStack`,
  description: 'Glue database, ETL job, and crawler for stock data processing',
  rawBucket: s3Stack.rawBucket,
  processedBucket: s3Stack.processedBucket,
  glueRole: iamStack.glueRole,
  auroraCluster: auroraStack.cluster,
  auroraSecret: auroraStack.databaseCredentials,
  s3EventNotificationEnabled: false, // 学習環境では無効、手動実行を推奨
});

// ========================================
// 7. Athenaスタック
// ========================================
// データ分析用のWorkGroupとNamed Queriesを作成
// QuickSightやSQLクライアントからクエリを実行可能
const athenaStack = new AthenaStack(app, 'AthenaStack', {
  env,
  stackName: `${projectName}-AthenaStack`,
  description: 'Athena workgroup and views for stock data analysis',
  processedBucket: s3Stack.processedBucket,
  glueDatabase: glueStack.glueDatabase,
  glueCrawler: glueStack.glueCrawler,
});

// ========================================
// スタック間の依存関係設定
// ========================================
// CloudFormationが正しい順序でスタックをデプロイするように依存関係を明示
// 依存チェーン: S3 → IAM → Lambda/Aurora → Glue → Athena
iamStack.addDependency(s3Stack);
lambdaStack.addDependency(iamStack);
schedulerStack.addDependency(lambdaStack);
glueStack.addDependency(iamStack);
glueStack.addDependency(auroraStack);
athenaStack.addDependency(glueStack);

// ========================================
// タグ付け
// ========================================
// 全リソースにプロジェクト名と環境情報をタグ付け
// コスト配分やリソース管理に便利
cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('Environment', 'Learning');
cdk.Tags.of(app).add('ManagedBy', 'CDK');

app.synth();
