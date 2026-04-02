'use strict';
const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');

const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';
const KEYFILE = process.env.BIGQUERY_KEY_PATH || path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');

let _bq = null;
function getClient() {
  if (!_bq) _bq = new BigQuery({ projectId: PROJECT, location: LOCATION, keyFilename: KEYFILE });
  return _bq;
}

async function queryBQ(sql) {
  try {
    const [rows] = await getClient().query({ query: sql, location: LOCATION });
    return rows;
  } catch (err) {
    console.error('[BQ] 쿼리 오류:', err.message);
    throw err;
  }
}

module.exports = { queryBQ };
