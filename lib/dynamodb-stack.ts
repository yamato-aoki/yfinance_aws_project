import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

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
  }
}
