'use strict';
const { queryBQ } = require('../lib/bigquery');
const { enqueue, alreadyQueued } = require('../lib/queue');

const LMT_SQL = `
SELECT
  CAST(a.id AS STRING) AS id,
  a.corp_name,
  a.card_company_name AS card_company,
  a.application_type,
  DATETIME_DIFF(CURRENT_DATETIME('Asia/Seoul'), a.initialized_at, DAY) AS elapsed_days,
  FORMAT_DATETIME('%Y-%m-%dT%H:%M:%S', a.initialized_at) AS initialized_at,
  CAST(corp.corp_id AS STRING) AS brn,
  corp.assigned_am
FROM \`gowid-prd.mart_limit_application.application_status\` a
LEFT JOIN \`gowid-prd.dw_dimension.corporation\` corp ON a.corp_name = corp.corp_name
WHERE a.gowid_approved_at IS NOT NULL
  AND a.application_submitted_at IS NULL
  AND a.card_co_pending_at IS NULL
  AND a.gowid_rejected_at IS NULL
  AND a.card_co_rejected_at IS NULL
  AND a.canceled_at IS NULL
  AND (corp.assigned_am IS NULL OR corp.assigned_am = '')
ORDER BY elapsed_days DESC
`;

function getEscalationLevel(days) {
  if (days >= 7) return { level: 'day7', channel: 'slack', triggerType: 'lmt_day7_slack' };
  if (days >= 3) return { level: 'day3', channel: 'sms', triggerType: 'lmt_day3' };
  return { level: 'day1', channel: 'email', triggerType: 'lmt_day1' };
}

async function runLmtTrigger(dryRun = false) {
  console.log('[LMT] 전자서명 미제출 에스컬레이션 실행...');
  const rows = await queryBQ(LMT_SQL);
  console.log(`[LMT] 총 ${rows.length}건 조회`);

  let skippedNullBrn = 0;
  const items = [];
  const counts = { day1: 0, day3: 0, day7: 0 };

  for (const r of rows) {
    if (!r.brn) { skippedNullBrn++; continue; }
    const { level, channel, triggerType } = getEscalationLevel(r.elapsed_days);
    const already = dryRun ? false : await alreadyQueued(r.brn, triggerType);
    if (already) continue;
    counts[level]++;

    const subject = level === 'day7'
      ? `[에스컬레이션] ${r.corp_name} 전자서명 미제출 ${r.elapsed_days}일 경과`
      : `[고위드] ${r.corp_name}님, 전자서명을 완료해주세요`;
    const body = level === 'day7'
      ? `${r.corp_name} (${r.card_company}) — 전자서명 미제출 ${r.elapsed_days}일 경과. 담당자 직접 연락 필요.`
      : `안녕하세요, 고위드입니다.\n\n한도상향 신청이 승인되었으나 전자서명이 아직 완료되지 않았습니다. (경과 ${r.elapsed_days}일)\n\n전자서명을 완료해주시면 카드사 접수가 진행됩니다.`;

    items.push({
      brn: r.brn,
      corp_name: r.corp_name,
      trigger_type: triggerType,
      channel,
      subject,
      body,
      metadata: { elapsed_days: r.elapsed_days, card_company: r.card_company, level },
    });
  }

  console.log(`[LMT] BRN 매핑 성공 ${rows.length - skippedNullBrn}건, 스킵 ${skippedNullBrn}건`);

  if (dryRun) {
    console.log(`[DRY-RUN] LMT: day1=${counts.day1}, day3=${counts.day3}, day7=${counts.day7}`);
    return { ...counts, skippedNullBrn, total: rows.length };
  }

  const { inserted } = await enqueue(items);
  console.log(`[LMT] 완료: ${inserted}건 대기 큐 적재 (담당자 승인 대기)`);
  return { ...counts, queued: inserted, skippedNullBrn };
}

module.exports = { runLmtTrigger };
