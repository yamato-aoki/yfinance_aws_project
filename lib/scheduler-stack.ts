import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * SchedulerStackProps: Schedulerスタックに必要なプロパティ
 */
export interface SchedulerStackProps extends cdk.StackProps {
  lambdaFunction: lambda.Function;   // 実行対象のLambda関数
  scheduleEnabled?: boolean;         // スケジュール有効/無効（デフォルト: false）
}

/**
 * SchedulerStack: EventBridge SchedulerでLambda関数を定期実行
 * 
 * このスタックでは:
 * 1. EventBridge Schedulerを作成して毎日定時にLambdaを実行
 * 2. デフォルトでは無効（コスト節約のため）
 * 3. 学習段階では手動実行を推奨
 * 
 * スケジュール:
 * - cron(0 0 * * ? *): 毎日 0:00 UTC (9:00 JST)
 * - 前日の株式データを取得するタイミング
 */
export class SchedulerStack extends cdk.Stack {
  public readonly schedule: scheduler.CfnSchedule;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    // scheduleEnabledのデフォルト値をfalseに設定
    const enabled = props.scheduleEnabled ?? false;

    // ========================================
    // 1. EventBridge Scheduler実行ロール
    // ========================================
    // SchedulerがLambda関数を呼び出すためのロール
    const schedulerRole = new iam.Role(this, 'SchedulerExecutionRole', {
      roleName: 'StockDataSchedulerRole',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Execution role for EventBridge Scheduler to invoke Lambda',
    });

    // SchedulerにLambda関数を呼び出す権限を付与
    props.lambdaFunction.grantInvoke(schedulerRole);

    // ========================================
    // 2. EventBridge Schedule作成
    // ========================================
    // 毎日 0:00 UTC (9:00 JST) にLambda関数を実行するスケジュール
    // デフォルトでは無効（コスト節約のため）
    this.schedule = new scheduler.CfnSchedule(this, 'DailyStockDataSchedule', {
      name: 'DailyStockDataFetch',
      description: 'Trigger Lambda daily at 9:00 AM JST to fetch previous day stock data (disabled by default)',
      scheduleExpression: 'cron(0 0 * * ? *)', // 毎日 0:00 UTC (9:00 JST)
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: {
        mode: 'OFF',
      },
      state: enabled ? 'ENABLED' : 'DISABLED', // デフォルトで無効
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
      },
    });

    // ========================================
    // CloudFormation Outputs（スタック出力）
    // ========================================
    // デプロイ後にスケジュール名と状態を確認できるように出力
    // 手動で有効化するコマンドも表示
    new cdk.CfnOutput(this, 'ScheduleName', {
      value: this.schedule.name!,
      description: 'EventBridge Schedule name',
      exportName: 'StockDataScheduleName',
    });

    new cdk.CfnOutput(this, 'ScheduleState', {
      value: enabled ? 'ENABLED' : 'DISABLED',
      description: 'EventBridge Schedule state (ENABLED/DISABLED)',
    });

    new cdk.CfnOutput(this, 'EnableScheduleCommand', {
      value: `aws scheduler update-schedule --name ${this.schedule.name} --state ENABLED --schedule-expression "cron(0 0 * * ? *)" --flexible-time-window Mode=OFF --target "Arn=${props.lambdaFunction.functionArn},RoleArn=${schedulerRole.roleArn}"`,
      description: 'Command to enable the schedule manually',
    });
  }
}
