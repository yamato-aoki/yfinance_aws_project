#!/usr/bin/env node

/**
 * Athena CTAS クエリ実行スクリプト
 * 
 * セクター別集計ビューと銘柄別月次サマリーを作成します。
 * 
 * 使い方:
 * node scripts/create-curated-views.js
 */

const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand } = require('@aws-sdk/client-athena');
const fs = require('fs');
const path = require('path');

const athena = new AthenaClient({});

// 設定
const DATABASE = 'stock_data_db';
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '123456789012'; // 実際のアカウントIDに置き換え
const ATHENA_RESULTS_BUCKET = `stock-athena-results-${ACCOUNT_ID}`;
const CURATED_BUCKET = `stock-data-curated-${ACCOUNT_ID}`;

// SQLファイルを読み込んでバケット名を置換
function loadSQL(filename) {
  const sqlPath = path.join(__dirname, '..', 'sql', filename);
  let sql = fs.readFileSync(sqlPath, 'utf8');
  sql = sql.replace(/{CURATED_BUCKET}/g, CURATED_BUCKET);
  sql = sql.replace(/{ACCOUNT_ID}/g, ACCOUNT_ID);
  return sql;
}

// クエリ実行
async function executeQuery(queryString, description) {
  console.log(`\n🔄 実行中: ${description}`);
  
  const params = {
    QueryString: queryString,
    QueryExecutionContext: {
      Database: DATABASE,
    },
    ResultConfiguration: {
      OutputLocation: `s3://${ATHENA_RESULTS_BUCKET}/`,
    },
  };

  try {
    const command = new StartQueryExecutionCommand(params);
    const response = await athena.send(command);
    const queryExecutionId = response.QueryExecutionId;
    
    console.log(`📝 クエリID: ${queryExecutionId}`);
    
    // クエリ完了を待機
    await waitForQueryCompletion(queryExecutionId);
    
    console.log(`✅ 完了: ${description}`);
    return true;
  } catch (error) {
    console.error(`❌ エラー: ${description}`);
    console.error(error.message);
    return false;
  }
}

// クエリ完了を待機
async function waitForQueryCompletion(queryExecutionId) {
  let status = 'RUNNING';
  
  while (status === 'RUNNING' || status === 'QUEUED') {
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒待機
    
    const command = new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId });
    const response = await athena.send(command);
    status = response.QueryExecution.Status.State;
    
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(`クエリが失敗しました: ${response.QueryExecution.Status.StateChangeReason}`);
    }
  }
}

// メイン処理
async function main() {
  console.log('========================================');
  console.log('Athena Curated Views 作成スクリプト');
  console.log('========================================');
  console.log(`データベース: ${DATABASE}`);
  console.log(`Curatedバケット: s3://${CURATED_BUCKET}/`);
  console.log('========================================');

  // 1. セクター別集計ビュー
  const sectorSQL = loadSQL('create_sector_view.sql');
  const sectorSuccess = await executeQuery(sectorSQL, 'セクター別集計ビュー (sector_daily_summary)');

  // 2. 銘柄別月次サマリー
  const tickerSQL = loadSQL('create_ticker_monthly_view.sql');
  const tickerSuccess = await executeQuery(tickerSQL, '銘柄別月次サマリー (ticker_monthly_summary)');

  console.log('\n========================================');
  console.log('実行結果');
  console.log('========================================');
  console.log(`セクター別集計ビュー: ${sectorSuccess ? '✅ 成功' : '❌ 失敗'}`);
  console.log(`銘柄別月次サマリー: ${tickerSuccess ? '✅ 成功' : '❌ 失敗'}`);
  console.log('========================================');
  
  if (sectorSuccess && tickerSuccess) {
    console.log('\n🎉 すべてのCuratedビューが正常に作成されました！');
    console.log(`\n📊 データ確認:
    
    SELECT * FROM sector_daily_summary LIMIT 10;
    SELECT * FROM ticker_monthly_summary LIMIT 10;
    `);
  }
}

main().catch(console.error);
