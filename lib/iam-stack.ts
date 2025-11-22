import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * IamStackProps: IAMスタックに必要なプロパティ
 * S3バケットへのアクセス権限を設定するため、S3Stackから渡される
 */
export interface IamStackProps extends cdk.StackProps {
  rawBucket: s3.Bucket;         // 生データバケット
  processedBucket: s3.Bucket;   // 加工済みデータバケット
}

/**
 * IamStack: Lambda関数とGlue ETLジョブ用のIAMロールを作成
 * 
 * このスタックでは2つのIAMロールを作成します:
 * 1. lambdaRole: Lambda関数がyfinanceからデータを取得してS3に保存するためのロール
 * 2. glueRole: Glue ETLジョブがS3からデータを読み込み、Auroraに接続して加工するためのロール
 * 
 * 最小権限の原則に従い、必要な権限のみを付与しています。
 */
export class IamStack extends cdk.Stack {
  // 他のスタックから参照可能なように public で宣言
  public readonly lambdaRole: iam.Role;
  public readonly glueRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // ========================================
    // 1. Lambda Execution Role（Lambda実行ロール）
    // ========================================
    // Lambda関数がyfinanceからデータを取得してS3に書き込むためのロール
    // 基本的なCloudWatch Logsへの書き込み権限も含む
    this.lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: 'StockDataFetchLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for stock data fetch Lambda function',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Lambda関数にrawBucketへの書き込み権限を付与
    // grantWrite()は s3:PutObject, s3:PutObjectAcl などの権限を自動で設定
    props.rawBucket.grantWrite(this.lambdaRole);

    // ========================================
    // 2. Glue Execution Role（Glue実行ロール）
    // ========================================
    // Glue ETLジョブがS3からデータを読み込み、Auroraに接続して加工するためのロール
    // Glue Crawlerもこのロールを使用してデータカタログを更新
    this.glueRole = new iam.Role(this, 'GlueExecutionRole', {
      roleName: 'StockDataGlueETLRole',
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      description: 'Execution role for Glue ETL jobs and Crawler',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    // GlueにS3バケットへのアクセス権限を付与
    // rawBucket: 読み取り専用（CSV入力データ）
    // processedBucket: 読み書き可能（Parquet出力データ）
    props.rawBucket.grantRead(this.glueRole);
    props.processedBucket.grantReadWrite(this.glueRole);

    // ========================================
    // 3. Glue CloudWatch Logs 権限
    // ========================================
    // GlueジョブのログをCloudWatch Logsに出力するための権限
    this.glueRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: ['arn:aws:logs:*:*:/aws-glue/*'],
      })
    );

    // ========================================
    // 4. Glue Secrets Manager 権限（Aurora認証情報取得用）
    // ========================================
    // GlueジョブがAuroraに接続するための認証情報をSecrets Managerから取得
    this.glueRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:StockDatabase*`],
      })
    );

    // ========================================
    // 5. Glue VPC 権限（Aurora接続用）
    // ========================================
    // GlueジョブがVPC内のAuroraクラスターに接続するためのネットワーク権限
    // ENI（Elastic Network Interface）の作成・削除などを含む
    this.glueRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:DescribeVpcEndpoints',
          'ec2:DescribeSubnets',
          'ec2:DescribeVpcAttribute',
          'ec2:DescribeRouteTables',
          'ec2:DescribeSecurityGroups',
        ],
        resources: ['*'],
      })
    );

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にロールARNを確認できるように出力
    new cdk.CfnOutput(this, 'LambdaRoleArn', {
      value: this.lambdaRole.roleArn,
      description: 'Lambda execution role ARN',
      exportName: 'LambdaExecutionRoleArn',
    });

    new cdk.CfnOutput(this, 'GlueRoleArn', {
      value: this.glueRole.roleArn,
      description: 'Glue execution role ARN',
      exportName: 'GlueExecutionRoleArn',
    });
  }
}
