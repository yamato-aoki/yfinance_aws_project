import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

interface LambdaCuratedStackProps extends cdk.StackProps {
  processedBucket: s3.IBucket;
  curatedBucket: s3.IBucket;
}

export class LambdaCuratedStack extends cdk.Stack {
  public readonly curatedViewsFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaCuratedStackProps) {
    super(scope, id, props);

    // Curated views 生成 Lambda 関数
    this.curatedViewsFunction = new lambda.Function(this, 'CreateCuratedViewsFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset('lambda/create_curated_views'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        CURATED_BUCKET: props.curatedBucket.bucketName,
        DATABASE_NAME: 'curated_db',
        ATHENA_OUTPUT: `s3://${props.curatedBucket.bucketName}/athena-results/`,
      },
      description: 'Processed bucket へのデータ作成時に Curated views を自動生成',
    });

    // Athena 実行権限
    this.curatedViewsFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartitions',
        'glue:CreateTable',
        'glue:UpdateTable',
      ],
      resources: ['*'],
    }));

    // S3 読み取り権限（Processed bucket）
    props.processedBucket.grantRead(this.curatedViewsFunction);

    // S3 書き込み権限（Curated bucket）
    props.curatedBucket.grantReadWrite(this.curatedViewsFunction);

    // S3 イベント通知設定
    // Processed bucket に Parquet ファイルが作成されたら Lambda を起動
    props.processedBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.curatedViewsFunction),
      {
        suffix: '.parquet',
      }
    );

    // Output
    new cdk.CfnOutput(this, 'CuratedViewsFunctionName', {
      value: this.curatedViewsFunction.functionName,
      description: 'Curated views 生成 Lambda 関数名',
    });

    new cdk.CfnOutput(this, 'CuratedViewsFunctionArn', {
      value: this.curatedViewsFunction.functionArn,
      description: 'Curated views 生成 Lambda 関数 ARN',
    });
  }
}
