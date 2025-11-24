import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * LambdaStackProps: Lambdaスタックに必要なプロパティ
 */
export interface LambdaStackProps extends cdk.StackProps {
  rawBucket: s3.Bucket;         // 生データ保存先バケット
  lambdaRole: iam.Role;         // Lambda実行ロール
  stockTickers: string[];       // 取得対象の株式ティッカーリスト
}

/**
 * LambdaStack: yfinanceから株式データを取得するLambda関数を作成
 * 
 * このLambda関数は:
 * 1. yfinance APIを使用して前日の株式データを取得
 * 2. 取得したデータをCSV形式でS3に保存
 * 3. EventBridge Schedulerによって毎日定時実行（手動有効化が必要）
 * 
 * 注意:
 * - yfinanceライブラリはLambda Layerとして別途作成が必要
 * - タイムアウト: 5分（複数銘柄のデータ取得を考慮）
 */
export class LambdaStack extends cdk.Stack {
  // 他のスタックから参照可能なように public で宣言
  public readonly fetchStockFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    // ========================================
    // Lambda関数作成（yfinanceデータ取得）
    // ========================================
    // lambda/fetch_stock/index.py のコードを使用してLambda関数を作成
    // 環境変数でS3バケット名とティッカーリストを渡す
    this.fetchStockFunction = new lambda.Function(this, 'FetchStockDataFunction', {
      functionName: 'FetchStockDataFunction',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/fetch_stock')),
      role: props.lambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        RAW_BUCKET_NAME: props.rawBucket.bucketName,
        STOCK_TICKERS: props.stockTickers.join(','),
        TZ: 'Asia/Tokyo',
      },
      description: 'yfinanceから前日の株価データを取得してS3に保存',
    });

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後に関数名とARNを確認できるように出力
    // 手動実行コマンド: aws lambda invoke --function-name <FunctionName> response.json
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.fetchStockFunction.functionName,
      description: '株価データ取得Lambda関数名',
      exportName: 'FetchStockFunctionName',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.fetchStockFunction.functionArn,
      description: '株価データ取得Lambda関数ARN',
      exportName: 'FetchStockFunctionArn',
    });
  }
}
