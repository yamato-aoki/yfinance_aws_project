import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * LambdaTransformStackProps: Lambda変換スタックに必要なプロパティ
 */
export interface LambdaTransformStackProps extends cdk.StackProps {
  rawBucket: s3.Bucket;                // 生データバケット（CSV）
  processedBucket: s3.Bucket;          // 加工済みデータバケット（Parquet）
  stockMasterTable: dynamodb.Table;    // DynamoDB銘柄マスター
  s3EventEnabled?: boolean;            // S3イベント通知有効/無効
}

/**
 * LambdaTransformStack: Lambda関数でCSV→Parquet変換（無課金構成）
 * 
 * このスタックでは:
 * 1. Lambda関数: CSV → Parquet変換 + DynamoDB JOIN
 * 2. S3イベント通知: CSVアップロード時に自動実行（オプション）
 * 3. Lambda Layer: pandas + pyarrow
 * 
 * Glue ETL Jobの代替として使用:
 * - コスト: 無料枠内（月100万リクエスト）
 * - 処理時間: 小規模データなら十分
 * - 制約: タイムアウト15分、メモリ10GB
 * 
 * データフロー:
 * 1. S3 Raw に CSV アップロード
 * 2. Lambda関数がトリガー
 * 3. DynamoDB から銘柄マスター取得
 * 4. pandas で CSV 読み込み → JOIN
 * 5. pyarrow で Parquet 変換
 * 6. S3 Processed に保存（セクター階層パーティション）
 */
export class LambdaTransformStack extends cdk.Stack {
  public readonly transformFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaTransformStackProps) {
    super(scope, id, props);

    const s3EventEnabled = props.s3EventEnabled ?? false;

    // ========================================
    // 1. Lambda実行ロール
    // ========================================
    const lambdaRole = new iam.Role(this, 'TransformLambdaRole', {
      roleName: 'StockTransformLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // S3読み書き権限
    props.rawBucket.grantRead(lambdaRole);
    props.processedBucket.grantWrite(lambdaRole);

    // DynamoDB読み取り権限
    props.stockMasterTable.grantReadData(lambdaRole);

    // ========================================
    // 2. Lambda関数作成（CSV→Parquet変換）
    // ========================================
    this.transformFunction = new lambda.Function(this, 'TransformParquetFunction', {
      functionName: 'TransformCSVtoParquetFunction',
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/transform_parquet')),
      role: lambdaRole,
      timeout: cdk.Duration.minutes(15), // 最大15分
      memorySize: 3008, // pandas/pyarrow用に多めに確保
      environment: {
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        DYNAMODB_TABLE: props.stockMasterTable.tableName,
        TZ: 'Asia/Tokyo',
      },
      description: 'Transform CSV to Parquet with DynamoDB master data join (free-tier alternative)',
    });

    // ========================================
    // 3. S3イベント通知（オプション）
    // ========================================
    if (s3EventEnabled) {
      props.rawBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(this.transformFunction),
        { prefix: 'raw/', suffix: '.csv' }
      );
    }

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.transformFunction.functionName,
      description: 'Lambda function name for CSV to Parquet transformation',
      exportName: 'TransformParquetFunctionName',
    });

    new cdk.CfnOutput(this, 'S3EventStatus', {
      value: s3EventEnabled ? 'ENABLED' : 'DISABLED',
      description: 'S3 event notification status',
    });

    new cdk.CfnOutput(this, 'Architecture', {
      value: 'Lambda + DynamoDB (Free-tier)',
      description: 'Architecture type',
    });
  }
}
