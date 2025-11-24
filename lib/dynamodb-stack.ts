import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

/**
 * DynamoDBStack: 銘柄マスターデータ用テーブル（無課金構成用）
 * 
 * このスタックでは:
 * 1. DynamoDB テーブル: 銘柄マスター情報を保存
 * 2. オンデマンド課金モード: 使用量に応じた従量課金
 * 3. 無料枠: 25GB + 2.5億リクエスト/月
 * 
 * Aurora代替として使用:
 * - コスト: 無料枠内で運用可能
 * - パフォーマンス: Aurora以上の速度
 * - メンテナンス: サーバーレスで管理不要
 * 
 * テーブル設計:
 * - PK: ticker (銘柄コード)
 * - Attributes: name, sector, exchange, country, is_active
 */
export class DynamoDBStack extends cdk.Stack {
  public readonly stockMasterTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // DynamoDB テーブル作成（銘柄マスター）
    // ========================================
    this.stockMasterTable = new dynamodb.Table(this, 'StockMasterTable', {
      tableName: 'stock-master',
      partitionKey: {
        name: 'ticker',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // オンデマンド（無料枠対象）
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 学習用のため削除可能に
      pointInTimeRecovery: false, // コスト削減のため無効
      encryption: dynamodb.TableEncryption.AWS_MANAGED, // AWS管理キーで暗号化
    });

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    new cdk.CfnOutput(this, 'TableName', {
      value: this.stockMasterTable.tableName,
      description: 'DynamoDB table name for stock master data',
      exportName: 'StockMasterTableName',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.stockMasterTable.tableArn,
      description: 'DynamoDB table ARN',
      exportName: 'StockMasterTableArn',
    });

    // ========================================
    // シードデータ自動投入（CustomResource）
    // ========================================
    // デプロイ時に自動的にマスターデータを投入
    // 理由:
    // 1. 手動スクリプト実行が不要になり、デプロイが完全自動化
    // 2. スタック削除時にデータも自動削除される（クリーンアップ容易）
    // 3. 初回デプロイ後すぐにパイプラインが動作可能
    
    const seedData = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../dynamodb/seed_data.json'), 'utf8')
    );

    // 各銘柄データを投入
    seedData.forEach((item: any, index: number) => {
      new cr.AwsCustomResource(this, `SeedData-${item.ticker}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: this.stockMasterTable.tableName,
            Item: {
              ticker: { S: item.ticker },
              name: { S: item.name },
              sector: { S: item.sector },
              exchange: { S: item.exchange },
              country: { S: item.country },
              is_active: { BOOL: item.is_active },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(`seed-${item.ticker}-${Date.now()}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:PutItem'],
            resources: [this.stockMasterTable.tableArn],
          }),
        ]),
      });
    });
  }
}
