"""
Lambda Function: Stock Data Fetcher
株価データ取得Lambda関数

機能:
    - yfinance APIを使用して前日の株価データを取得
    - 取得したデータをCSV形式でS3 rawバケットに保存
    - 階層構造: raw/{ticker}/{YYYY}/{MM}/{DD}/{ticker}_{YYYY-MM-DD}.csv

必要な環境変数:
    RAW_BUCKET_NAME: S3 rawバケット名
    STOCK_TICKERS: カンマ区切りの銘柄リスト (例: AAPL,MSFT,GOOGL)

依存ライブラリ:
    - yfinance: Lambda Layerとして追加が必要
    - boto3: Lambda実行環境に標準で含まれる

実行タイミング:
    - EventBridge Schedulerによる定期実行（デフォルト: 毎日0:00 UTC）
    - 手動実行: aws lambda invoke --function-name FetchStockDataFunction response.json
"""
import json
import os
import boto3
from datetime import datetime, timedelta
import csv
from io import StringIO

# yfinance は Lambda Layer または Deployment Package に含める必要があります
# Lambda Layerの作成方法は PRACTICAL_GUIDE.md を参照
try:
    import yfinance as yf
except ImportError:
    print("WARNING: yfinance not installed. Please add it to Lambda Layer or deployment package.")
    yf = None


# S3クライアントの初期化（Lambda関数外で1回だけ実行）
s3_client = boto3.client('s3')


def lambda_handler(event, context):
    """
    Lambda handler function - 株価データ取得のメイン処理
    
    処理フロー:
        1. 環境変数から設定を読み込み
        2. 前日の日付を計算
        3. 各銘柄のデータをyfinanceから取得
        4. CSV形式に変換してS3にアップロード
        5. 処理結果をレスポンスとして返却
    
    Args:
        event: Lambda実行イベント（EventBridge Schedulerからの呼び出し時は空のdict）
        context: Lambda実行コンテキスト
    
    Returns:
        dict: 処理結果（statusCode, body, 成功/失敗件数）
    
    環境変数:
        RAW_BUCKET_NAME: S3 rawバケット名（必須）
        STOCK_TICKERS: カンマ区切りの銘柄リスト（デフォルト: AAPL,MSFT,GOOGL）
    """
    
    # ========================================
    # 1. 環境変数から設定を取得
    # ========================================
    raw_bucket = os.environ.get('RAW_BUCKET_NAME')
    tickers_str = os.environ.get('STOCK_TICKERS', 'AAPL,MSFT,GOOGL')
    
    if not raw_bucket:
        return {
            'statusCode': 400,
            'body': json.dumps('RAW_BUCKET_NAME environment variable not set')
        }
    
    if yf is None:
        return {
            'statusCode': 500,
            'body': json.dumps('yfinance library not available')
        }
    
    # 銘柄リストをパース（カンマ区切りの文字列を配列に変換）
    tickers = [t.strip() for t in tickers_str.split(',')]
    
    # ========================================
    # 2. 前日の日付を取得
    # ========================================
    # 株式市場は当日のデータが取得できないため、前日のデータを取得
    yesterday = datetime.now() - timedelta(days=1)
    date_str = yesterday.strftime('%Y-%m-%d')
    
    print(f"株価データ取得開始: {date_str}")
    print(f"対象銘柄: {tickers}")
    
    # 処理結果を格納する配列
    results = []   # 成功した銘柄のリスト
    errors = []    # エラーが発生した銘柄のリスト
    
    # ========================================
    # 3. 各銘柄のデータを取得
    # ========================================
    for ticker in tickers:
        try:
            print(f"{ticker} のデータ取得中...")
            
            # ========================================
            # 3-1. yfinanceでデータ取得
            # ========================================
            stock = yf.Ticker(ticker)
            
            # 前日のデータを取得（休日対応のため2日分取得して最新を使用）
            # period='2d': 直近2日間のデータを取得
            hist = stock.history(period='2d')
            
            if hist.empty:
                print(f"{ticker}: データが取得できませんでした")
                errors.append(f"{ticker}: データなし")
                continue
            
            # ========================================
            # 3-2. データの加工
            # ========================================
            # 最新の1行を取得（pandas DataFrameの最後の行）
            latest_data = hist.iloc[-1]
            data_date = latest_data.name.strftime('%Y-%m-%d')
            
            # CSV形式のデータを作成（dict形式）
            csv_data = {
                'ticker': ticker,
                'date': data_date,
                'open': latest_data['Open'],
                'high': latest_data['High'],
                'low': latest_data['Low'],
                'close': latest_data['Close'],
                'volume': int(latest_data['Volume']),
                'fetched_at': datetime.now().isoformat()  # Lambda実行時刻
            }
            
            # ========================================
            # 3-3. CSV文字列を生成
            # ========================================
            # StringIOを使用してメモリ上でCSV文字列を作成
            csv_buffer = StringIO()
            csv_writer = csv.DictWriter(csv_buffer, fieldnames=csv_data.keys())
            csv_writer.writeheader()  # ヘッダー行を書き込み
            csv_writer.writerow(csv_data)  # データ行を書き込み
            csv_content = csv_buffer.getvalue()
            
            # ========================================
            # 3-4. S3にアップロード
            # ========================================
            # 階層構造: raw/{ticker}/{YYYY}/{MM}/{DD}/{ticker}_{YYYY-MM-DD}.csv
            # この構造によりGlueのパーティション化が容易になる
            date_parts = data_date.split('-')  # ['YYYY', 'MM', 'DD']
            # S3オブジェクトキーの構築: raw/{ticker}/{YYYY}/{MM}/{DD}/{ticker}_{date}.csv
            s3_key = f"raw/{ticker}/{date_parts[0]}/{date_parts[1]}/{date_parts[2]}/{ticker}_{data_date}.csv"
            
            # S3にCSVファイルをアップロード
            s3_client.put_object(
                Bucket=raw_bucket,
                Key=s3_key,
                Body=csv_content,
                ContentType='text/csv'
            )
            
            print(f"アップロード成功: s3://{raw_bucket}/{s3_key}")
            results.append({
                'ticker': ticker,
                'date': data_date,
                's3_key': s3_key,
                'status': 'success'
            })
            
        except Exception as e:
            # エラーハンドリング: 個別銘柄のエラーで全体処理を停止しない
            error_msg = f"{ticker}: {str(e)}"
            print(f"{ticker} の処理中にエラー: {str(e)}")
            errors.append(error_msg)
            results.append({
                'ticker': ticker,
                'status': 'error',
                'error': str(e)
            })
    
    # ========================================
    # 4. 処理結果のサマリーを作成
    # ========================================
    response_body = {
        'date': date_str,
        'processed_tickers': len(results),
        'successful': len([r for r in results if r['status'] == 'success']),
        'failed': len(errors),
        'results': results,
        'errors': errors
    }
    
    print(f"処理完了: 成功 {response_body['successful']}件, 失敗 {response_body['failed']}件")
    
    # ========================================
    # 5. レスポンスを返却
    # ========================================
    # Lambda実行結果をJSON形式で返却
    # EventBridge Schedulerからの呼び出しでもCloudWatch Logsに記録される
    return {
        'statusCode': 200,
        'body': json.dumps(response_body, default=str)
    }


# ========================================
# ローカルテスト用のエントリーポイント
# ========================================
# ローカル環境でテスト実行する場合: python index.py
if __name__ == '__main__':
    # テスト用の環境変数設定
    os.environ['RAW_BUCKET_NAME'] = 'test-bucket'
    os.environ['STOCK_TICKERS'] = 'AAPL,MSFT'
    
    # Lambda関数を実行
    result = lambda_handler({}, None)
    print(json.dumps(json.loads(result['body']), indent=2))
