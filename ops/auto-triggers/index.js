'use strict';
require('dotenv').config();

const { runCvtTrigger } = require('./triggers/cvt');
const { runLmtTrigger } = require('./triggers/lmt');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const start = new Date().toISOString();
  console.log(`[auto-triggers] 시작 ${start} | dry-run: ${DRY_RUN}`);
  console.log('[auto-triggers] ⚠️  발송 대상을 대기 큐에 적재합니다. 실제 발송은 담당자 승인 후 진행됩니다.');

  // CVT: 한도산출→카드신청 미진입
  try {
    const cvt = await runCvtTrigger(DRY_RUN);
    console.log('[CVT] 결과:', JSON.stringify(cvt));
  } catch (err) {
    console.error('[CVT] 실패:', err.message);
  }

  // LMT: 전자서명 미제출 에스컬레이션
  try {
    const lmt = await runLmtTrigger(DRY_RUN);
    console.log('[LMT] 결과:', JSON.stringify(lmt));
  } catch (err) {
    console.error('[LMT] 실패:', err.message);
  }

  console.log(`[auto-triggers] 완료 ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('[auto-triggers] 치명적 오류:', err.message);
  process.exit(1);
});
