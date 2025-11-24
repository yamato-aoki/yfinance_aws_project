import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * S3Stack: ストックデータパイプライン用のS3バケット群を作成
 * 
 * このスタックでは3つのバケットを作成します:
 * 1. rawBucket: Lambda関数が取得した生データ（CSV形式）を保存
 * 2. processedBucket: Glue ETLジョブで加工したデータ（Parquet形式）を保存
 * 3. athenaResultsBucket: Athenaクエリの実行結果を保存
 * 
 * コスト最適化のため、各バケットにライフサイクルポリシーを設定しています。
 */
export class S3Stack extends cdk.Stack {
  // 他のスタックから参照可能なように public で宣言
  public readonly rawBucket: s3.Bucket;
  public readonly processedBucket: s3.Bucket;
  public readonly curatedBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // 1. Raw Data Bucket（生データバケット）
    // ========================================
    // Lambda関数がyfinanceから取得したCSVファイルを保存
    // 階層構造: raw/{ticker}/{year}/{month}/{day}/stock_data.csv
    this.rawBucket = new s3.Bucket(this, 'StockDataRawBucket', {
      bucketName: `stock-data-raw-${cdk.Aws.ACCOUNT_ID}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 本番環境では RETAIN を推奨
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'DeleteOldRawData',
          enabled: true,
          expiration: cdk.Duration.days(90), // 90日後に削除
        },
      ],
    });

    // ========================================
    // 2. Processed Data Bucket（加工済みデータバケット）
    // ========================================
    // Glue ETLジョブで加工したParquetファイルを保存
    // Aurora マスターデータとJOINした結果を含む
    // 階層構造: processed/ticker={ticker}/year={year}/month={month}/day={day}/
    this.processedBucket = new s3.Bucket(this, 'StockDataProcessedBucket', {
      bucketName: `stock-data-processed-${cdk.Aws.ACCOUNT_ID}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // ========================================
    // 3. Curated Data Bucket（集計ビューバケット）
    // ========================================
    // Athenaで作成したセクター別集計ビュー等を保存
    // ビジネス分析・ダッシュボード用の最終データ
    this.curatedBucket = new s3.Bucket(this, 'StockDataCuratedBucket', {
      bucketName: `stock-data-curated-${cdk.Aws.ACCOUNT_ID}`,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // ========================================
    // 4. Athena Results Bucket（クエリ結果バケット）
    // ========================================
    // Athenaクエリの実行結果を保存（一時的なデータ）
    // 7日後に自動削除される設定
    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `stock-athena-results-${cdk.Aws.ACCOUNT_ID}`,
      versioned: false,
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
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にバケット名を確認できるように出力
    // 他のスタックから参照可能な Export Name も設定
    new cdk.CfnOutput(this, 'RawBucketName', {
      value: this.rawBucket.bucketName,
      description: 'S3 bucket for raw stock data (CSV)',
      exportName: 'StockDataRawBucketName',
    });

    new cdk.CfnOutput(this, 'ProcessedBucketName', {
      value: this.processedBucket.bucketName,
      description: 'S3 bucket for processed stock data (Parquet)',
      exportName: 'StockDataProcessedBucketName',
    });

    new cdk.CfnOutput(this, 'CuratedBucketName', {
      value: this.curatedBucket.bucketName,
      description: 'S3 bucket for curated data (Aggregated views)',
      exportName: 'StockDataCuratedBucketName',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value: athenaResultsBucket.bucketName,
      description: 'S3 bucket for Athena query results',
      exportName: 'AthenaResultsBucketName',
    });
  }
}
