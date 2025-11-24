"""
Lambda Function: CSV to Parquet Transformer with DynamoDB Join
CSV → Parquet変換 + DynamoDB銘柄マスターJOIN（無課金構成）

機能:
    1. S3イベントでCSVファイルを検知
    2. DynamoDBから銘柄マスター情報を取得
    3. pandasでCSV読み込み → マスターデータとJOIN
    4. セクター階層パーティション（sector/ticker/year/month/day）でParquet保存
    5. Glue ETL Jobの無料枠代替版

環境変数:
    PROCESSED_BUCKET: 加工済みデータバケット名
    DYNAMODB_TABLE: DynamoDB銘柄マスターテーブル名

依存ライブラリ:
    - pandas: データ処理
    - pyarrow: Parquet書き込み
    - boto3: AWS SDK

制約:
    - タイムアウト: 最大15分
    - メモリ: 最大10GB
    - 小〜中規模データ向け（大規模はGlue ETL推奨）
"""
import os
import json
import urllib.parse
from datetime import datetime
import boto3
import pandas as pd

# AWS クライアント初期化
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

# 環境変数
PROCESSED_BUCKET = os.environ['PROCESSED_BUCKET']
DYNAMODB_TABLE = os.environ['DYNAMODB_TABLE']


def lambda_handler(event, context):
    """
    Lambda ハンドラー関数
    
    Args:
        event: S3イベント通知
        context: Lambda実行コンテキスト
    
    Returns:
        dict: 処理結果
    """
    try:
        # ========================================
        # 1. S3イベントからファイル情報を取得
        # ========================================
        for record in event['Records']:
            # S3バケット名とキーを取得
            bucket = record['s3']['bucket']['name']
            key = urllib.parse.unquote_plus(record['s3']['object']['key'])
            
            print(f"ファイル処理中: s3://{bucket}/{key}")
            
            # ========================================
            # 2. CSVファイルをS3から読み込み
            # ========================================
            response = s3_client.get_object(Bucket=bucket, Key=key)
            df = pd.read_csv(response['Body'])
            
            print(f"CSV読み込み完了: {len(df)}行")
            
            # ========================================
            # 3. DynamoDBから銘柄マスターデータを取得
            # ========================================
            master_data = get_stock_master_data()
            
            # ========================================
            # 4. データ変換処理
            # ========================================
            # 4-1. 日付パーティション用カラムを追加
            df['date_parsed'] = pd.to_datetime(df['date'])
            df['year'] = df['date_parsed'].dt.year
            df['month'] = df['date_parsed'].dt.month.astype(str).str.zfill(2)
            df['day'] = df['date_parsed'].dt.day.astype(str).str.zfill(2)
            
            # 4-2. DynamoDBマスターデータとJOIN
            if master_data:
                master_df = pd.DataFrame(master_data)
                df = df.merge(master_df, on='ticker', how='left')
            else:
                # マスターデータがない場合はデフォルト値
                df['sector'] = 'Unknown'
                df['exchange'] = None
                df['country'] = None
            
            # 4-3. NULLのsectorを"Unknown"に置換
            df['sector'] = df['sector'].fillna('Unknown')
            
            # 4-4. スペースをアンダースコアに置換（パーティション名用）
            df['sector'] = df['sector'].str.replace(' ', '_')
            
            # 4-5. メタデータ追加
            df['ingested_at'] = datetime.now().isoformat()
            df['source_file'] = key.split('/')[-1]
            
            # 4-6. カラム順序を整理
            df = df[[
                'sector', 'ticker', 'year', 'month', 'day', 'date',
                'open', 'high', 'low', 'close', 'volume',
                'exchange', 'country', 'ingested_at', 'source_file'
            ]]
            
            # ========================================
            # 5. Parquet形式でS3に保存（セクター階層パーティション）
            # ========================================
            # tickerとdateから出力パスを決定
            ticker = df['ticker'].iloc[0]
            sector = df['sector'].iloc[0]
            year = df['year'].iloc[0]
            month = df['month'].iloc[0]
            day = df['day'].iloc[0]
            
            # 出力パス: processed/sector={sector}/ticker={ticker}/year={year}/month={month}/day={day}/
            output_key = f"processed/sector={sector}/ticker={ticker}/year={year}/month={month}/day={day}/data.parquet"
            
            # Parquetに変換してS3に保存
            parquet_buffer = df.to_parquet(compression='snappy', index=False)
            s3_client.put_object(
                Bucket=PROCESSED_BUCKET,
                Key=output_key,
                Body=parquet_buffer
            )
            
            print(f"Parquet保存完了: s3://{PROCESSED_BUCKET}/{output_key}")
            print(f"レコード数: {len(df)}, セクター: {sector}, 銘柄: {ticker}")
        
        return {
            'statusCode': 200,
            'body': json.dumps('Successfully transformed CSV to Parquet')
            }
        
    except Exception as e:
        print(f"エラー: {str(e)}")
        raise
def get_stock_master_data():
    """
    DynamoDBから銘柄マスターデータを全件取得
    
    Returns:
        list: 銘柄マスターデータのリスト
    """
    try:
        table = dynamodb.Table(DYNAMODB_TABLE)
        response = table.scan()
        items = response['Items']
        
        # ページネーション対応
        while 'LastEvaluatedKey' in response:
            response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response['Items'])
        
        print(f"DynamoDBからマスターデータを読み込み: {len(items)}件")
        return items
        
    except Exception as e:
        print(f"警告: DynamoDBマスターデータの読み込み失敗: {str(e)}")
        return None
