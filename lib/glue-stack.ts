import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * GlueStackProps: Glueスタックに必要なプロパティ
 */
export interface GlueStackProps extends cdk.StackProps {
  rawBucket: s3.Bucket;                         // 生データバケット（CSV）
  processedBucket: s3.Bucket;                   // 加工済みデータバケット（Parquet）
  glueRole: iam.Role;                           // Glue実行ロール
  auroraCluster: rds.DatabaseCluster;           // Auroraクラスター（マスターデータ）
  auroraSecret: secretsmanager.ISecret;         // Aurora認証情報
  s3EventNotificationEnabled?: boolean;         // S3イベント通知有効/無効
}

/**
 * GlueStack: AWS Glueでデータ変換とカタログ化
 * 
 * このスタックでは:
 * 1. Glue Database: データカタログ用のデータベース
 * 2. Glue ETL Job: CSV→Parquet変換 + AuroraマスターJOIN
 * 3. Glue Crawler: 加工済みデータのスキーマ自動検出
 * 4. S3イベント通知 (オプション): CSVアップロード時に自動実行
 * 
 * ETLプロセス:
 * 1. S3 rawバケットからCSVデーータを読み込み
 * 2. AuroraマスターデータとLEFT JOIN（sector, exchange情報を付与）
 * 3. Parquet形式に変換してパーティション化
 * 4. S3 processedバケットに保存
 */
export class GlueStack extends cdk.Stack {
  public readonly glueDatabase: glue.CfnDatabase;
  public readonly glueJob: glue.CfnJob;
  public readonly glueCrawler: glue.CfnCrawler;

  constructor(scope: Construct, id: string, props: GlueStackProps) {
    super(scope, id, props);

    // s3EventNotificationEnabledのデフォルト値をfalseに設定
    const s3NotificationEnabled = props.s3EventNotificationEnabled ?? false;

    // ========================================
    // 1. Glue Database作成
    // ========================================
    // Athenaでクエリするためのデータカタログ
    this.glueDatabase = new glue.CfnDatabase(this, 'StockDataDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'stock_data_db',
        description: '株価データ分析用データベース',
      },
    });

    // ========================================
    // 2. Glue ETLスクリプト用バケット
    // ========================================
    // glue/etl_job.py を自動アップロードするためのバケット
    // CDKデプロイ時にローカルのスクリプトを自動的にS3にアップロード
    const glueScriptBucket = new s3.Bucket(this, 'GlueScriptBucket', {
      bucketName: `glue-scripts-${cdk.Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ========================================
    // 2-2. Glueスクリプトを自動デプロイ
    // ========================================
    // ローカルの glue/ ディレクトリをS3にアップロード
    // CDKデプロイ時に自動実行される（手動アップロード不要）
    new s3deploy.BucketDeployment(this, 'DeployGlueScripts', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../glue'))],
      destinationBucket: glueScriptBucket,
      destinationKeyPrefix: 'glue/', // S3上のパス: glue/etl_job.py
    });

    // ========================================
    // 3. Glue ETL Job作成
    // ========================================
    // CSVデータをParquetに変換し、AuroraマスターとJOINするETLジョブ
    // PySparkを使用してパーティション化されたデータを生成
    this.glueJob = new glue.CfnJob(this, 'StockDataETLJob', {
      name: 'stock-data-csv-to-parquet',
      description: 'Convert CSV stock data to Parquet with partitioning',
      role: props.glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${glueScriptBucket.bucketName}/glue/etl_job.py`,
        pythonVersion: '3',
      },
      glueVersion: '4.0',
      maxRetries: 1,
      timeout: 60,
      maxCapacity: 2.0,
      defaultArguments: {
        '--job-language': 'python',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': `s3://${glueScriptBucket.bucketName}/spark-logs/`,
        '--RAW_BUCKET': props.rawBucket.bucketName,
        '--PROCESSED_BUCKET': props.processedBucket.bucketName,
        '--DATABASE_NAME': this.glueDatabase.ref,
        '--AURORA_SECRET_ARN': props.auroraSecret.secretArn,
        '--AURORA_ENDPOINT': props.auroraCluster.clusterEndpoint.hostname,
      },
    });

    this.glueJob.node.addDependency(this.glueDatabase);

    // ========================================
    // 4. Glue Crawler作成
    // ========================================
    // 加工済みデータのスキーマを自動検出してGlueカタログに登録
    // Athenaでクエリを実行する前にCrawlerを実行する必要がある
    this.glueCrawler = new glue.CfnCrawler(this, 'StockDataCrawler', {
      name: 'stock-data-processed-crawler',
      description: 'Parquet形式の処理済み株価データをカタログ化するクローラー',
      role: props.glueRole.roleArn,
      databaseName: this.glueDatabase.ref,
      targets: {
        s3Targets: [
          {
            path: `s3://${props.processedBucket.bucketName}/`,
          },
        ],
      },
      schemaChangePolicy: {
        updateBehavior: 'UPDATE_IN_DATABASE',
        deleteBehavior: 'LOG',
      },
      configuration: JSON.stringify({
        Version: 1.0,
        CrawlerOutput: {
          Partitions: { AddOrUpdateBehavior: 'InheritFromTable' },
        },
      }),
    });

    this.glueCrawler.node.addDependency(this.glueDatabase);

    // ========================================
    // 5. S3イベント通知（オプション）
    // ========================================
    // CSVファイルがS3にアップロードされた際に自動でGlueジョブを起動
    // デフォルトでは無効（コスト節約のため手動実行を推奨）
    if (s3NotificationEnabled) {
      // Lambdaを使用してGlueジョブをトリガー
      const triggerGlueRole = new iam.Role(this, 'TriggerGlueJobRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });

      triggerGlueRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['glue:StartJobRun'],
          resources: [
            `arn:aws:glue:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:job/${this.glueJob.name}`,
          ],
        })
      );

      const triggerGlueFunction = new lambda.Function(this, 'TriggerGlueJobFunction', {
        functionName: 'TriggerGlueJobOnS3Event',
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: 'index.lambda_handler',
        code: lambda.Code.fromInline(`
import json
import boto3
import os

glue_client = boto3.client('glue')

def lambda_handler(event, context):
    job_name = os.environ['GLUE_JOB_NAME']
    
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        
        print(f"New file detected: s3://{bucket}/{key}")
        
        # Start Glue Job
        response = glue_client.start_job_run(
            JobName=job_name,
            Arguments={
                '--S3_INPUT_PATH': f's3://{bucket}/{key}'
            }
        )
        
        print(f"Started Glue job run: {response['JobRunId']}")
    
    return {
        'statusCode': 200,
        'body': json.dumps('Glue job triggered successfully')
    }
        `),
        role: triggerGlueRole,
        environment: {
          GLUE_JOB_NAME: this.glueJob.name!,
        },
        timeout: cdk.Duration.minutes(1),
      });

      // Add S3 event notification
      props.rawBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(triggerGlueFunction),
        { suffix: '.csv' }
      );
    }

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にリソース名と状態を確認できるように出力
    // Glueスクリプトのアップロード先も表示
    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: this.glueDatabase.ref,
      description: 'Glueデータベース名',
      exportName: 'GlueDatabaseName',
    });

    new cdk.CfnOutput(this, 'GlueJobName', {
      value: this.glueJob.name!,
      description: 'Glue ETLジョブ名',
      exportName: 'GlueJobName',
    });

    new cdk.CfnOutput(this, 'GlueCrawlerName', {
      value: this.glueCrawler.name!,
      description: 'Glueクローラー名',
      exportName: 'GlueCrawlerName',
    });

    new cdk.CfnOutput(this, 'S3NotificationStatus', {
      value: s3NotificationEnabled ? 'ENABLED' : 'DISABLED',
      description: 'Glueジョブトリガー用S3イベント通知ステータス',
    });

    new cdk.CfnOutput(this, 'GlueScriptLocation', {
      value: `s3://${glueScriptBucket.bucketName}/glue/etl_job.py`,
      description: 'GlueETLスクリプトのアップロード先',
    });
  }
}
