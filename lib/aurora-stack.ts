import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * AuroraStack: 株式マスターデータ用のAurora Serverless v2クラスターを作成
 * 
 * このスタックでは以下を作成します:
 * 1. VPC: Auroraクラスターを配置するネットワーク環境
 * 2. Aurora Serverless v2: 株式マスターデータ（ticker, sector, exchangeなど）を格納
 * 3. Secrets Manager: Aurora認証情報を安全に管理
 * 
 * コスト最適化:
 * - Serverless v2を使用（0.5-1 ACU）
 * - 学習環境のため削除保護は無効、削除時はスナップショット作成
 */
export class AuroraStack extends cdk.Stack {
  // 他のスタックから参照可能なように public で宣言
  public readonly cluster: rds.DatabaseCluster;
  public readonly databaseCredentials: secretsmanager.ISecret;
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // 1. VPC作成（Auroraクラスター用）
    // ========================================
    // 3つのサブネットタイプを持つVPCを作成:
    // - Public: インターネットゲートウェイ経由でインターネットアクセス可能
    // - Private: NATゲートウェイ経由でインターネットアクセス可能（Lambda用）
    // - Isolated: インターネットアクセス不可（Aurora用、最もセキュア）
    this.vpc = new ec2.Vpc(this, 'StockDatabaseVpc', {
      vpcName: 'StockDatabaseVpc',
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ========================================
    // 2. セキュリティグループ（Auroraアクセス制御）
    // ========================================
    // VPC内からのMySQL接続（ポート3306）のみを許可
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Aurora cluster',
      allowAllOutbound: true,
    });

    // VPC内からのMySQL接続を許可（Glueジョブからの接続用）
    // セキュリティのため、VPC外からの接続は不可
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(3306),
      'Allow MySQL access from VPC'
    );

    // ========================================
    // 3. データベース認証情報（Secrets Managerで管理）
    // ========================================
    // ユーザー名を指定し、パスワードは自動生成してSecrets Managerに保存
    // GlueジョブはこのSecretを使用してAuroraに接続
    const dbUsername = 'admin';
    const dbCredentials = rds.Credentials.fromGeneratedSecret(dbUsername, {
      secretName: 'StockDatabaseCredentials',
    });

    // ========================================
    // 4. Aurora Serverless v2 クラスター作成
    // ========================================
    // 株式マスターデータ（ticker, sector, exchangeなど）を格納
    // Serverless v2を使用して自動スケーリング（0.5-1 ACU）
    this.cluster = new rds.DatabaseCluster(this, 'StockMasterCluster', {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_04_0,
      }),
      clusterIdentifier: 'stock-master-cluster',
      defaultDatabaseName: 'stockdb',
      credentials: dbCredentials,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: true,
      }),
      readers: [],
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      storageEncrypted: true,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '03:00-04:00',
      },
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT, // 学習環境なので SNAPSHOT
      deletionProtection: false,
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
    });

    this.databaseCredentials = this.cluster.secret!;

    // ========================================
    // 5. データベース初期化について
    // ========================================
    // stocksテーブルの作成は sql/create_stocks_table.sql を使用して手動で実行します
    // 自動化する場合はCustom Resource Lambdaを使用する方法もあります
    // 注: 学習環境のため、ここではシンプルに構造のみ作成

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後に接続情報を確認できるように出力
    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: 'Aurora cluster endpoint',
      exportName: 'AuroraClusterEndpoint',
    });

    new cdk.CfnOutput(this, 'ClusterIdentifier', {
      value: this.cluster.clusterIdentifier,
      description: 'Aurora cluster identifier',
      exportName: 'AuroraClusterIdentifier',
    });

    new cdk.CfnOutput(this, 'SecretArn', {
      value: this.databaseCredentials.secretArn,
      description: 'Aurora credentials secret ARN',
      exportName: 'AuroraSecretArn',
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: 'stockdb',
      description: 'Aurora database name',
      exportName: 'AuroraDatabaseName',
    });
  }
}
