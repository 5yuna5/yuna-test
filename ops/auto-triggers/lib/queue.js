'use strict';
const { getClient } = require('./supabase');

/**
 * 발송 대기 큐에 적재 (pending 상태)
 * 담당자가 card-squad 메시지센터에서 승인해야 실제 발송됨
 */
async function enqueue(items) {
  if (!items.length) return { inserted: 0 };
  const supabase = getClient();

  const rows = items.map(item => ({
    brn: item.brn,
    corp_name: item.corp_name || null,
    trigger_type: item.trigger_type,
    channel: item.channel || 'email',
    subject: item.subject || '',
    body: item.body || '',
    metadata: item.metadata || {},
    status: 'pending',
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('message_queue').insert(rows);
  if (error) {
    console.error('[QUEUE] 적재 오류:', error.message);
    throw error;
  }
  return { inserted: rows.length };
}

/**
 * 오늘 이미 적재된 동일 trigger_type 건이 있는지 확인 (중복 방지)
 */
async function alreadyQueued(brn, triggerType) {
  const supabase = getClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('message_queue')
    .select('id')
    .eq('brn', brn)
    .eq('trigger_type', triggerType)
    .gte('created_at', today)
    .limit(1);
  return (data || []).length > 0;
}

module.exports = { enqueue, alreadyQueued };
