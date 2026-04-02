'use strict';
const { queryBQ } = require('../lib/bigquery');
const { enqueue, alreadyQueued } = require('../lib/queue');

const CVT_QUERY = `
SELECT
  CAST(f.corp_id AS STRING) AS brn,
  f.corp_name,
  f.first_limit_result_at AS limit_result_at,
  f.first_card_applied_at AS card_applied_at,
  CASE WHEN f.first_limit_result_amount = 0 AND f.first_limit_result_at IS NOT NULL THEN true ELSE false END AS lz,
  COALESCE(CAST(f.first_limit_result_amount AS STRING), '미확인') AS limit_amount,
  DATETIME_DIFF(CURRENT_DATETIME('Asia/Seoul'), f.first_limit_result_at, DAY) AS elapsed_days,
  FORMAT_DATETIME('%Y-%m-%d', f.first_limit_result_at) AS result_date
FROM \`gowid-prd.mart_limit_application.card_application_funnel\` f
JOIN \`gowid-prd.dw_dimension.corporation\` corp ON f.corp_id = corp.corp_id
WHERE f.first_limit_result_at IS NOT NULL
  AND f.first_card_applied_at IS NULL
  AND (corp.assigned_am IS NULL OR corp.assigned_am = '')
ORDER BY elapsed_days DESC
LIMIT 500
`;

function classifyReason(row) {
  if (row.lz) return 'zero_limit';
  return 'normal';
}

async function runCvtTrigger(dryRun = false) {
  console.log('[CVT] 한도산출→카드신청 트리거 실행...');
  const rows = await queryBQ(CVT_QUERY);
  console.log(`[CVT] 조회 결과: ${rows.length}건`);

  const items = [];
  for (const r of rows) {
    if (!r.brn) continue;
    const reason = classifyReason(r);
    const triggerType = reason === 'zero_limit' ? 'cvt_zero_limit' : 'cvt_card_apply';
    const already = dryRun ? false : await alreadyQueued(r.brn, triggerType);
    if (already) continue;

    const subject = reason === 'zero_limit'
      ? `[고위드] ${r.corp_name || ''}님, 보증금/특별심사 안내`
      : `[고위드] ${r.corp_name || ''}님, 카드 신청을 완료해주세요`;
    const body = reason === 'zero_limit'
      ? `안녕하세요, 고위드입니다.\n\n한도 산출 결과 0원으로 확인되었습니다. 보증금 납입 또는 특별심사를 통해 카드 발급이 가능합니다.\n\n문의사항이 있으시면 언제든 연락주세요.`
      : `안녕하세요, 고위드입니다.\n\n한도 산출이 완료되었습니다 (${r.limit_amount}원). 카드 신청을 진행해주세요.\n\n카드 신청 후 발급까지 약 3~5 영업일이 소요됩니다.`;

    items.push({
      brn: r.brn,
      corp_name: r.corp_name,
      trigger_type: triggerType,
      channel: 'email',
      subject,
      body,
      metadata: { elapsed_days: r.elapsed_days, reason, result_date: r.result_date },
    });
  }

  if (dryRun) {
    console.log(`[DRY-RUN] CVT: ${items.length}건 대기 큐 적재 예정`);
    return { queued: items.length, total: rows.length };
  }

  const { inserted } = await enqueue(items);
  console.log(`[CVT] 완료: ${inserted}건 대기 큐 적재 (담당자 승인 대기)`);
  return { queued: inserted, total: rows.length };
}

module.exports = { runCvtTrigger };
