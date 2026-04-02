'use strict';
const { createClient } = require('@supabase/supabase-js');

const OPS_URL = process.env.SUPABASE_OPS_URL || 'https://okiipcxxaywvcmeecqvx.supabase.co';
let _client = null;

function getClient() {
  if (!_client) {
    const key = process.env.SUPABASE_OPS_SERVICE_KEY;
    if (!key) throw new Error('SUPABASE_OPS_SERVICE_KEY 환경변수가 없습니다.');
    _client = createClient(OPS_URL, key);
  }
  return _client;
}

module.exports = { getClient };
