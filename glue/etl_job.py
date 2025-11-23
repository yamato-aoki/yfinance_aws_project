"""
AWS Glue ETL Job: Stock Data CSV to Parquet Converter
株価データのETL処理スクリプト

機能:
    1. S3 rawバケットからCSVファイルを読み込み
    2. Aurora DBから銘柄マスターデータを取得してJOIN
    3. 日付パーティション用のカラムを追加
    4. Parquet形式に変換して圧縮
    5. S3 processedバケットにパーティション化して保存

パーティション構造:
    processed/sector={sector}/ticker={ticker}/year={YYYY}/month={MM}/day={DD}/

必要なGlueジョブパラメータ:
    --RAW_BUCKET: 生データバケット名
    --PROCESSED_BUCKET: 加工済みデータバケット名
    --DATABASE_NAME: Glueデータベース名
    --AURORA_SECRET_ARN: Aurora認証情報のSecrets Manager ARN
    --AURORA_ENDPOINT: Auroraクラスターのエンドポイント
    --S3_INPUT_PATH (オプション): 特定ファイルのパス（S3イベントトリガー時）

実行方法:
    1. 手動実行: AWS Glue Console > Jobs > Run Job
    2. AWS CLI: aws glue start-job-run --job-name stock-data-csv-to-parquet
    3. S3イベントトリガー: CSVアップロード時に自動実行（オプション）

依存ライブラリ:
    - PySpark: Glue実行環境に標準で含まれる
    - boto3: AWS SDK for Python
    - MySQL JDBC Driver: Aurora接続用（Glue Connectionで設定）
"""
import sys
import json
from datetime import datetime
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import functions as F
from pyspark.sql.types import StringType, IntegerType, DoubleType, TimestampType
import boto3


# ========================================
# 1. ジョブパラメータの取得
# ========================================
# Glueジョブに渡される必須パラメータを取得
args = getResolvedOptions(
    sys.argv,
    [
        'JOB_NAME',
        'RAW_BUCKET',
        'PROCESSED_BUCKET',
        'DATABASE_NAME',
        'AURORA_SECRET_ARN',
        'AURORA_ENDPOINT',
    ]
)

# オプショナルパラメータ（S3イベントトリガー時に使用）
# 特定のファイルを処理したい場合に指定
s3_input_path = None
if '--S3_INPUT_PATH' in sys.argv:
    s3_input_path = getResolvedOptions(sys.argv, ['S3_INPUT_PATH'])['S3_INPUT_PATH']


# ========================================
# 2. Spark/Glueコンテキストの初期化
# ========================================
# SparkとGlueの実行環境を初期化
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

# ロガーの取得（CloudWatch Logsに出力される）
logger = glueContext.get_logger()
logger.info(f"Starting Glue ETL Job: {args['JOB_NAME']}")
logger.info(f"Raw Bucket: {args['RAW_BUCKET']}")
logger.info(f"Processed Bucket: {args['PROCESSED_BUCKET']}")


def get_aurora_master_data():
    """
    Auroraから銘柄マスターデータを取得
    
    処理内容:
        1. Secrets ManagerからAurora認証情報を取得
        2. JDBC接続でAuroraのstocksテーブルを読み込み
        3. Spark DataFrameとして返却
    
    Returns:
        pyspark.sql.DataFrame: 銘柄マスターデータ（ticker, sector, exchange, country）
        None: エラー発生時（マスターデータなしで処理を継続）
    
    必要な設定:
        - Glue JobがVPC内で実行されること（Aurora接続のため）
        - Security GroupでAuroraへのアクセスが許可されていること
        - MySQL JDBC Driverが利用可能であること
    """
    try:
        # ========================================
        # Secrets Managerから認証情報を取得
        # ========================================
        secrets_client = boto3.client('secretsmanager')
        secret_value = secrets_client.get_secret_value(SecretId=args['AURORA_SECRET_ARN'])
        secret = json.loads(secret_value['SecretString'])
        
        # ========================================
        # JDBC接続情報の構築
        # ========================================
        jdbc_url = f"jdbc:mysql://{args['AURORA_ENDPOINT']}:3306/stockdb"
        connection_properties = {
            "user": secret['username'],
            "password": secret['password'],
            "driver": "com.mysql.cj.jdbc.Driver"  # MySQL Connector/J 8.x
        }
        
        # ========================================
        # Auroraからstocksテーブルを読み込み
        # ========================================
        # ========================================
        # Auroraからstocksテーブルを読み込み
        # ========================================
        # JDBCを使用してAuroraのテーブルをSpark DataFrameとして読み込み
        # sector列を含む銘柄マスターデータを取得（パーティションキーとして使用）
        master_df = spark.read.jdbc(
            url=jdbc_url,
            table="stocks",  # sql/create_stocks_table.sqlで作成したテーブル
            properties=connection_properties
        ).select("ticker", "sector", "exchange", "country")  # 必要なカラムのみ選択
        
        logger.info(f"Loaded {master_df.count()} records from Aurora master table")
        return master_df
        
    except Exception as e:
        # エラーが発生してもETL処理を継続（マスターデータなしで実行）
        logger.warn(f"Could not load Aurora master data: {str(e)}")
        logger.warn("Continuing without master data join...")
        return None


# ========================================
# 3. 入力パスの決定
# ========================================
# バッチ処理 vs 個別ファイル処理の判定
if s3_input_path:
    # S3イベントトリガーで特定ファイルが指定された場合
    logger.info(f"Processing specific file: {s3_input_path}")
    input_path = s3_input_path
else:
    # バッチ処理：rawバケット全体を処理
    logger.info("Processing all files in raw bucket")
    input_path = f"s3://{args['RAW_BUCKET']}/raw/**/*.csv"


# ========================================
# 4. CSVデータの読み込み
# ========================================
logger.info(f"Reading CSV from: {input_path}")

try:
    # Spark DataFrameとしてCSVを読み込み
    # header=True: 1行目をカラム名として扱う
    # inferSchema=True: データ型を自動推論
    df = spark.read.csv(
        input_path,
        header=True,
        inferSchema=True
    )
    
    logger.info(f"Loaded {df.count()} rows")
    df.printSchema()  # スキーマをCloudWatch Logsに出力
    
    # ========================================
    # 5. データ変換処理
    # ========================================
    
    # ----------------------------------------
    # 5-1. 日付パーティション用のカラムを追加
    # ----------------------------------------
    # Parquet出力時のパーティションキーとして使用
    df_transformed = df.withColumn(
        "date_parsed",
        F.to_date(F.col("date"), "yyyy-MM-dd")  # 文字列をDate型に変換
    ).withColumn(
        "year",
        F.year(F.col("date_parsed")).cast(IntegerType())  # 年を抽出
    ).withColumn(
        "month",
        F.lpad(F.month(F.col("date_parsed")).cast(StringType()), 2, '0')  # 月を2桁文字列に
    ).withColumn(
        "day",
        F.lpad(F.dayofmonth(F.col("date_parsed")).cast(StringType()), 2, '0')  # 日を2桁文字列に
    )
    
    # ----------------------------------------
    # 5-2. Auroraマスターデータとのレフトジョイン
    # ----------------------------------------
    # 銘柄マスターからsector, exchange, country情報を付与
    master_df = get_aurora_master_data()
    
    if master_df is not None:
        logger.info("Joining with Aurora master data...")
        # tickerカラムでレフトジョイン（株価データにマスター情報を付与）
        df_transformed = df_transformed.join(
            master_df,
            on="ticker",
            how="left"  # 株価データを全て保持、マスターデータがない場合はNULL
        )
        logger.info("Master data join completed")
    else:
        # マスターデータがない場合はデフォルト値を設定
        logger.warn("No master data available, using default sector='Unknown'")
        df_transformed = df_transformed.withColumn("sector", F.lit("Unknown"))
        df_transformed = df_transformed.withColumn("exchange", F.lit(None).cast(StringType()))
        df_transformed = df_transformed.withColumn("country", F.lit(None).cast(StringType()))
    
    # NULLのsectorを"Unknown"に置換（JOINできなかった銘柄対策）
    df_transformed = df_transformed.withColumn(
        "sector",
        F.when(F.col("sector").isNull(), "Unknown").otherwise(F.col("sector"))
    )
    
    # スペースをアンダースコアに置換（パーティション名に使用するため）
    df_transformed = df_transformed.withColumn(
        "sector",
        F.regexp_replace(F.col("sector"), " ", "_")
    )
    
    # ----------------------------------------
    # 5-3. Glue処理日時を追加
    # ----------------------------------------
    # ETL実行時刻を記録（データ系統管理のため）
    df_transformed = df_transformed.withColumn(
        "ingested_at",
        F.lit(datetime.now().isoformat())
    )
    
    # ----------------------------------------
    # 5-4. 元ファイル名を追加
    # ----------------------------------------
    # トレーサビリティのためソースファイル名を記録
    if s3_input_path:
        source_file = s3_input_path.split('/')[-1]
    else:
        source_file = "batch_processing"
    
    df_transformed = df_transformed.withColumn(
        "source_file",
        F.lit(source_file)
    )
    
    # ----------------------------------------
    # 5-5. 最終的なカラム順序を整理
    # ----------------------------------------
    # Athenaでのクエリ効率を考慮してカラム順を最適化
    # sector, tickerをパーティションキーとして先頭に配置
    df_final = df_transformed.select(
        "sector",      # 業種（パーティションキー1）
        "ticker",      # 銘柄コード（パーティションキー2）
        "year",        # 年（パーティションキー3）
        "month",       # 月（パーティションキー4）
        "day",         # 日（パーティションキー5）
        "date",        # 日付（文字列）
        F.col("open").cast(DoubleType()),    # 始値
        F.col("high").cast(DoubleType()),    # 高値
        F.col("low").cast(DoubleType()),     # 安値
        F.col("close").cast(DoubleType()),   # 終値
        F.col("volume").cast(IntegerType()), # 出来高
        "exchange",    # 取引所（マスターから付与）
        "country",     # 国（マスターから付与）
        "ingested_at", # ETL処理日時
        "source_file"  # ソースファイル名
    )
    
    logger.info("Data transformation completed")
    logger.info(f"Final record count: {df_final.count()}")
    df_final.show(5)  # 先頭5件をCloudWatch Logsに出力
    
    # ========================================
    # 6. Parquet形式でS3に出力（セクター階層パーティション）
    # ========================================
    # パーティション構造: processed/sector={sector}/ticker={ticker}/year={YYYY}/month={MM}/day={DD}/
    # IoTパターン: region={region}/device={device}/timestamp={ts} と同じ階層構造
    # この構造により「WHERE sector='Technology'」のクエリで他セクターはスキャンされない
    output_path = f"s3://{args['PROCESSED_BUCKET']}/processed/"
    
    logger.info(f"Writing Parquet to: {output_path}")
    logger.info("Partition structure: sector/ticker/year/month/day")
    
    # Parquetで出力
    # - mode="append": 既存データに追加（上書きしない）
    # - partitionBy: 階層パーティション（sector → ticker → year → month → day）
    # - compression="snappy": Snappy圧縮を使用（読み書き速度とサイズのバランスが良い）
    df_final.write.mode("append").partitionBy(
        "sector", "ticker", "year", "month", "day"
    ).parquet(
        output_path,
        compression="snappy"  # 他の選択肢: gzip（圧縮率高）, none（圧縮なし）
    )
    
    logger.info("Successfully wrote Parquet files")
    
    # ========================================
    # 7. 処理統計の出力
    # ========================================
    # 銘柄ごとのレコード数をCloudWatch Logsに出力
    ticker_counts = df_final.groupBy("ticker").count().collect()
    for row in ticker_counts:
        logger.info(f"Ticker {row['ticker']}: {row['count']} records")
    
    # ========================================
    # 8. ジョブの終了処理
    # ========================================
    # Glueジョブを正常終了させる
    job.commit()
    logger.info("Job completed successfully")
    
except Exception as e:
    # ========================================
    # エラーハンドリング
    # ========================================
    # エラー内容をCloudWatch Logsに詳細に記録
    logger.error(f"Error processing data: {str(e)}")
    import traceback
    logger.error(traceback.format_exc())  # スタックトレースも出力
    raise  # エラーを再送出してジョブを失敗させる
