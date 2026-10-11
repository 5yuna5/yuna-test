#!/usr/bin/env node
/**
 * 한도 정합성 알럿 (limit-integrity-alert)
 *
 * 발급 시점엔 한도가 정상이었는데 실제 부여한도가 0원이 되어 고객이 카드를 못 쓴 사고
 * (기러기둥지 15403 신한 — 2026-08-20 12:00 배치가 사유 기록 없이 0원화) 재발 방지용.
 *
 * ① 보증금 법인: 계약서 값(승인 보증금) = 입금액 = 현재 부여한도
 * ② 전체 발급 법인: 발급 시 승인한도 = 현재 부여한도 (내부 CardLimit / 카드사 DW 총한도)
 *
 * 결과는 구글시트(탭: 보증금 / 발급 / 해소 / 가이드)에 upsert하고 슬랙에 요약을 보낸다.
 *
 * Usage:
 *   node index.js              # 시트 갱신 + 슬랙 발송
 *   node index.js --dry-run    # 콘솔 출력만 (시트·슬랙 미반영)
 *   node index.js --no-slack   # 시트만 갱신
 *   node index.js --force      # 슬랙 멱등성 가드 무시
 *   node index.js --channel C0XXX --no-thread   # 테스트 채널로 바로 발송
 */

// 로컬: pm 레포의 CRM 봇 .env 재사용 / GHA: Secrets 환경변수
require('dotenv').config({ path: require('path').join(__dirname, '../../pm/context/card/operations/crm-slack-bot/.env'), quiet: true });

const { BigQuery } = require('@google-cloud/bigquery');
const { WebClient } = require('@slack/web-api');
const { google } = require('googleapis');
const path = require('path');

// ─── Config ───
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';
const SPREADSHEET_ID = '1jqRXfZl8X8JKBNMaZOWpKAJ_9eQntRDYE_tc4l2MFSU';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
const DEFAULT_CHANNEL = 'C068EG4N7QA'; // 온보딩 퍼널별 고객 터치 알림 채널
const PARENT_BOT_ID = 'B0A1F2E9KPX'; // 온보딩 퍼널별 고객 터치 알림 봇
const BOT_USERNAME = '한도 정합성 알림';

const ISSUE_LOOKBACK_DAYS = 180; // 발급 승인한도 대조 대상: 최근 N일 발급분
const PLACEHOLDER_LIMIT = 10000; // 롯데 1만원 플레이스홀더 한도는 제외

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_SLACK = args.includes('--no-slack');
const FORCE = args.includes('--force');
const NO_THREAD = args.includes('--no-thread');
const channelIdx = args.indexOf('--channel');
const CHANNEL = channelIdx >= 0 ? args[channelIdx + 1] : DEFAULT_CHANNEL;

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({ keyFile: KEYFILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }),
});

// 판정 코드 — 심각도 순서 = 정렬 순서
const CODES = {
  DEP_ZERO: { label: '🔴 보증금있음·한도0원', sev: 1 },
  ISS_ZERO: { label: '🔴 사유없는 0원화', sev: 1 },
  DEC_NOT_APPLIED: { label: '🔴 하향신청 카드사 미반영', sev: 1 },
  MISMATCH: { label: '🔴 내부한도≠카드사한도', sev: 2 },
  NO_FILE: { label: '🔴 계약서 파일 없음', sev: 2 },
  NOT_REFLECTED: { label: '🟠 카드사 한도 미반영', sev: 3 },
  ISS_DROP: { label: '🟠 사유없는 감소', sev: 3 },
  DEP_UNREFUNDED: { label: '🟠 탈회·보증금 미반환', sev: 3 },
  DEP_REFUND_UNRECORDED: { label: '🟠 보증금 반환·상계 완료, 시스템 미기록', sev: 3 },
  DEP_REFUND_PENDING: { label: '🟠 보증금 반환 요청 후 미처리', sev: 3 },
  DEP_IN_DIFF: { label: '🟠 보증금 잔액<계약값', sev: 3 },
  OVER_DEP: { label: '🟡 한도>보증금잔액(확인)', sev: 4 },
  EXPLAINED: { label: '⚪ 사유 확인됨', sev: 9 }, // 슬랙·CRM에 사유가 있는 변동 — 시트에만 남기고 알림 제외
};

// ─── BigQuery ───
async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

// 공통 CTE. 함정 메모:
// - CardLimit_current 뷰는 행이 대량 누락 → CardLimit 원본을 id별 최신으로 dedup
// - DW corp_id = 사업자번호, ODS idxCorp ↔ dw_dimension.corporation.gowid_corp_idx
// - 내부 currentLimitAmount는 카드사 total_granted_limit(일반+퓨얼)과 대응 (normal 아님)
const COMMON_CTE = `
  dwd AS (
    SELECT MAX(date_id) AS d FROM \`gowid-prd.dw_metric.limit__date__corporation_card_company\`
    WHERE date_id >= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 7 DAY)
  ),
  cc AS (SELECT card_company_id, card_company_code FROM \`gowid-prd.dw_dimension.card_company\`),
  corp AS (
    SELECT c.corp_id, c.gowid_corp_idx, c.corp_name
    FROM \`gowid-prd.dw_dimension.corporation\` c
    WHERE c.gowid_corp_idx IS NOT NULL
      AND c.corp_id != 2618125793 -- 고위드 자사
      AND NOT REGEXP_CONTAINS(IFNULL(c.corp_name, ''), r'고위드')
  ),
  deleted AS (
    SELECT idx FROM (
      SELECT idx, isDeleted FROM \`gowid-prd.ods_stream_gowid.Corp\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY idx ORDER BY datastream_metadata.source_timestamp DESC) = 1
    )
    WHERE isDeleted = 1
  ),
  cl_raw AS (
    SELECT * FROM \`gowid-prd.ods_stream_gowid.CardLimit\`
    QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updatedAt DESC, datastream_metadata.source_timestamp DESC) = 1
  ),
  cl AS (
    SELECT idxCorp, cardCompany,
      SUM(approvedLimitAmount) AS cl_approved,
      SUM(currentLimitAmount) AS cl_current,
      MAX(isIssued) AS is_issued,
      MAX(updatedAt) AS cl_updated_at,
      ARRAY_AGG(lastChangedType IGNORE NULLS ORDER BY updatedAt DESC LIMIT 1)[SAFE_OFFSET(0)] AS last_changed_type
    FROM cl_raw
    WHERE isDeleted = 0 AND isTerminated = 0
    GROUP BY 1, 2
  ),
  dw AS (
    SELECT corp_id, card_company_id, total_granted_limit AS dw_total
    FROM \`gowid-prd.dw_metric.limit__date__corporation_card_company\`
    WHERE date_id = (SELECT d FROM dwd)
  )`;

// ① 보증금: 법인별 최신 승인 보증금 신청 1건
async function fetchDeposit() {
  return query(`
  WITH ${COMMON_CTE},
  da AS (
    SELECT * FROM \`gowid-prd.ods_stream_gowid.DepositApplication\`
    QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updatedAt DESC) = 1
  ),
  last_da AS (
    SELECT * FROM da WHERE reviewAction = 'APPROVE'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY idxCorp ORDER BY createdAt DESC) = 1
  ),
  dmr AS (
    SELECT * FROM \`gowid-prd.ods_stream_gowid.DepositManagement\`
    QUALIFY ROW_NUMBER() OVER (PARTITION BY idx ORDER BY updatedAt DESC) = 1
  ),
  dm_app AS (
    SELECT depositApplicationId, SUM(IF(depositType = 'DEPOSIT', inputAmount, 0)) AS deposit_in
    FROM dmr GROUP BY 1
  ),
  dm_corp AS (
    SELECT idxCorp,
      ARRAY_AGG(depositAmount ORDER BY createdAt DESC, idx DESC LIMIT 1)[OFFSET(0)] AS deposit_balance,
      LOGICAL_OR(depositType != 'DEPOSIT') AS has_withdrawal,
      MAX(createdAt) AS last_deposit_change_at
    FROM dmr GROUP BY 1
  ),
  lim AS (
    SELECT cl.idxCorp,
      SUM(cl.cl_current) AS cl_current,
      STRING_AGG(FORMAT('%s:%t', cl.cardCompany, cl.cl_current), ' / ' ORDER BY cl.cardCompany) AS cl_str,
      MAX(cl.cl_updated_at) AS cl_updated_at
    FROM cl GROUP BY 1
  ),
  dwc AS (
    SELECT corp.gowid_corp_idx AS idxCorp, SUM(dw.dw_total) AS dw_total,
      STRING_AGG(FORMAT('%s:%t', cc.card_company_code, dw.dw_total), ' / ' ORDER BY cc.card_company_code) AS dw_str
    FROM dw JOIN corp USING (corp_id) JOIN cc USING (card_company_id)
    GROUP BY 1
  )
  SELECT
    d.idxCorp AS idx, corp.corp_name, CAST(corp.corp_id AS STRING) AS bzno,
    d.approvedDepositAmount AS contract_amount,
    d.contractFilePath IS NOT NULL AS has_contract_file,
    CAST(d.depositDate AS STRING) AS deposit_date,
    dm_app.deposit_in, dm_corp.deposit_balance, IFNULL(dm_corp.has_withdrawal, FALSE) AS has_withdrawal,
    CAST(dm_corp.last_deposit_change_at AS STRING) AS last_deposit_change_at,
    lim.cl_current, lim.cl_str, CAST(lim.cl_updated_at AS STRING) AS cl_updated_at,
    dwc.dw_total, dwc.dw_str,
    d.idxCorp IN (SELECT idx FROM deleted) AS is_deleted,
    CAST((SELECT d FROM dwd) AS STRING) AS dw_date
  FROM last_da d
  JOIN corp ON corp.gowid_corp_idx = d.idxCorp
  LEFT JOIN dm_app ON dm_app.depositApplicationId = d.id
  LEFT JOIN dm_corp ON dm_corp.idxCorp = d.idxCorp
  LEFT JOIN lim ON lim.idxCorp = d.idxCorp
  LEFT JOIN dwc ON dwc.idxCorp = d.idxCorp
  `);
}

// ② 발급: 법인×카드사. 내부 CardLimit 기준 + 발급 승인한도 + 카드사 현재 + 감액 기록
async function fetchIssuance() {
  return query(`
  WITH ${COMMON_CTE},
  iss AS (
    SELECT corp_id, card_company_id, granted_limit, issued_at
    FROM \`gowid-prd.dw_fact.card_issuance\`
    WHERE NOT is_deleted AND issued_at IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY corp_id, card_company_id ORDER BY issued_at DESC) = 1
  ),
  dw_hist AS (
    SELECT corp_id, card_company_id,
      MAX(IF(total_granted_limit > 0, date_id, NULL)) AS last_positive_date
    FROM \`gowid-prd.dw_metric.limit__date__corporation_card_company\`
    WHERE date_id >= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL ${ISSUE_LOOKBACK_DAYS + 7} DAY)
    GROUP BY 1, 2
  ),
  -- 발급 승인한도 = 발급일 전후 CardLimit에 확정된 승인값.
  -- card_issuance.granted_limit은 고객 신청 한도와 같아서 쓰면 안 됨 (예: 에드믹바이오 신청 1,000만 / 승인 300만).
  -- CardLimit은 발급 시 신청값으로 잠깐 기록됐다가 1초 뒤 카드사 승인값으로 덮이므로 마지막 행을 쓴다.
  cl_hist AS (
    SELECT idxCorp, cardCompany, updatedAt, approvedLimitAmount, datastream_metadata.source_timestamp AS ts
    FROM \`gowid-prd.ods_stream_gowid.CardLimit\`
    WHERE isDeleted = 0 AND approvedLimitAmount > 0
  ),
  iss_appr AS (
    SELECT corp.gowid_corp_idx AS idxCorp, cc.card_company_code AS cardCompany,
      ARRAY_AGG(h.approvedLimitAmount ORDER BY h.updatedAt DESC, h.ts DESC LIMIT 1)[OFFSET(0)] AS issued_approved
    FROM iss
    JOIN corp USING (corp_id)
    JOIN cc USING (card_company_id)
    JOIN cl_hist h ON h.idxCorp = corp.gowid_corp_idx AND h.cardCompany = cc.card_company_code
      AND DATE(h.updatedAt) BETWEEN DATE_SUB(DATE(iss.issued_at, 'Asia/Seoul'), INTERVAL 3 DAY)
                                AND DATE_ADD(DATE(iss.issued_at, 'Asia/Seoul'), INTERVAL 1 DAY)
    GROUP BY 1, 2
  ),
  -- 카드사별 카드 상태. 롯데는 2026-02-10~11 카드 3,400장(417개 법인) 일괄 해지 후
  -- 6/25부터 유효 카드 없는 회원의 한도 데이터를 보내지 않음 → 내부 CardLimit만 남는 건이 생김
  cards AS (
    SELECT corp_id, card_company_id, COUNT(*) AS card_cnt, COUNTIF(is_valid) AS valid_cnt, MAX(DATE(closed_at)) AS last_closed
    FROM \`gowid-prd.dw_dimension.card\`
    GROUP BY 1, 2
  ),
  -- 체크카드 법인: 체크카드 거래가 있으면 신용한도가 없는 게 정상 (예: 지푸드 신한 체크카드)
  chk AS (
    SELECT DISTINCT corp_id, card_company_id FROM \`gowid-prd.dw_fact.check_card_transaction\`
    WHERE date_id >= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 180 DAY)
  ),
  ld AS (
    SELECT idxCorp, cardCompany, MAX(createdAt) AS last_decrease_at
    FROM (
      SELECT * FROM \`gowid-prd.ods_stream_gowid.LimitDecrease\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updatedAt DESC) = 1
    )
    WHERE isDeleted = 0 AND status = 'SUCCESS'
    GROUP BY 1, 2
  )
  SELECT
    cl.idxCorp AS idx, corp.corp_name, CAST(corp.corp_id AS STRING) AS bzno, cl.cardCompany AS card_company,
    CAST(DATE(iss.issued_at, 'Asia/Seoul') AS STRING) AS issued_date,
    DATE_DIFF(CURRENT_DATE('Asia/Seoul'), DATE(iss.issued_at, 'Asia/Seoul'), DAY) AS days_since_issued,
    iss.granted_limit AS requested_limit,
    ia.issued_approved AS issued_limit,
    cl.cl_approved, cl.cl_current, cl.last_changed_type,
    CAST(cl.cl_updated_at AS STRING) AS cl_updated_at,
    DATETIME_DIFF(CURRENT_DATETIME('Asia/Seoul'), cl.cl_updated_at, HOUR) AS hours_since_cl_update,
    dw.corp_id IS NOT NULL AS has_dw_row, dw.dw_total,
    CAST(h.last_positive_date AS STRING) AS dw_last_positive_date,
    CAST(DATE(ld.last_decrease_at) AS STRING) AS last_decrease_date,
    ld.last_decrease_at IS NOT NULL AND ld.last_decrease_at >= DATETIME(iss.issued_at, 'Asia/Seoul') AS decreased_after_issue,
    chk.corp_id IS NOT NULL AS is_check_card,
    cards.card_cnt, cards.valid_cnt, CAST(cards.last_closed AS STRING) AS last_closed,
    CAST((SELECT d FROM dwd) AS STRING) AS dw_date
  FROM cl
  JOIN cc ON cc.card_company_code = cl.cardCompany
  JOIN corp ON corp.gowid_corp_idx = cl.idxCorp
  LEFT JOIN iss ON iss.corp_id = corp.corp_id AND iss.card_company_id = cc.card_company_id
  LEFT JOIN dw ON dw.corp_id = corp.corp_id AND dw.card_company_id = cc.card_company_id
  LEFT JOIN dw_hist h ON h.corp_id = corp.corp_id AND h.card_company_id = cc.card_company_id
  LEFT JOIN ld ON ld.idxCorp = cl.idxCorp AND ld.cardCompany = cl.cardCompany
  LEFT JOIN iss_appr ia ON ia.idxCorp = cl.idxCorp AND ia.cardCompany = cl.cardCompany
  LEFT JOIN chk ON chk.corp_id = corp.corp_id AND chk.card_company_id = cc.card_company_id
  LEFT JOIN cards ON cards.corp_id = corp.corp_id AND cards.card_company_id = cc.card_company_id
  WHERE cl.is_issued = 1
    AND cl.cardCompany != 'SAMSUNG' -- 삼성 제휴 중단: 카드사 한도 데이터 없음
    AND cl.idxCorp NOT IN (SELECT idx FROM deleted)
  `);
}

// ─── 판정 ───
const num = (v) => (v === null || v === undefined ? null : Number(v));

function classifyDeposit(r) {
  const contract = num(r.contract_amount) || 0;
  const depIn = num(r.deposit_in);
  const bal = num(r.deposit_balance) || 0;
  const lim = num(r.cl_current) || 0;
  const dwTotal = num(r.dw_total);

  // 보증금 반환 완료 → 대조 대상 아님
  if (r.has_withdrawal && bal === 0) return null;

  const codes = [];
  const notes = [];
  // 탈회 법인: 한도 대조 대신 보증금 반환 여부만 본다
  if (r.is_deleted) {
    if (bal === 0) return null;
    codes.push('DEP_UNREFUNDED');
    notes.push(`탈회 법인인데 보증금 ${fmtAmt(bal)} 잔액 남음 — 반환 처리 확인`);
  }
  if (bal > 0 && lim === 0 && !r.is_deleted) {
    codes.push('DEP_ZERO');
    notes.push(`보증금 ${fmtAmt(bal)} 보유 중인데 한도 0원`);
  }
  // 입금/한도 변경 직후 1일은 카드사 반영 대기로 보고 유예
  const recentChange = hoursSince(r.last_deposit_change_at) < 24 || hoursSince(r.cl_updated_at) < 24;
  if (lim > 0 && (dwTotal ?? 0) !== lim && !recentChange) {
    codes.push('MISMATCH');
    notes.push(`내부 ${fmtAmt(lim)} vs 카드사 ${fmtAmt(dwTotal ?? 0)}`);
  }
  if (!r.has_contract_file) {
    codes.push('NO_FILE');
    notes.push('DepositApplication 계약서 파일 없음');
  }
  // 입금은 법인 단위 보증금 잔액으로 본다. 같은 법인이 보증금 신청을 여러 번 하면 입금이 이전 신청 건에
  // 연결돼 있을 수 있어서(예: 케이이음 3/11 신청 건으로 입금, 8/5 신청 건엔 연결 없음) 신청 건 단위로 보면 오판한다.
  // 잔액이 계약값보다 크면 추가 입금(정상)이므로 작을 때만 본다.
  if (!r.is_deleted && !r.has_withdrawal && bal < contract) {
    codes.push('DEP_IN_DIFF');
    notes.push(`계약 ${fmtAmt(contract)} vs 보증금 잔액 ${fmtAmt(bal)}`);
  }
  if (lim > bal && bal > 0) {
    codes.push('OVER_DEP');
    notes.push(`한도 ${fmtAmt(lim)} > 보증금잔액 ${fmtAmt(bal)} (일반 신용한도 혼합 여부 확인)`);
  }
  if (!codes.length) return null;
  return {
    key: r.bzno,
    tab: 'deposit',
    code: codes[0],
    codes,
    raw: { bal, lim, contract },
    corp_name: r.corp_name,
    bzno: r.bzno,
    card_company: r.cl_str || '-',
    cells: [
      contract, r.has_contract_file ? 'O' : 'X', depIn, bal, lim, dwTotal, r.deposit_date || '',
    ],
    note: notes.join(' · '),
  };
}

function classifyIssuance(r) {
  const issued = num(r.issued_limit);
  const clCur = num(r.cl_current) || 0;
  const dwTotal = num(r.dw_total);
  const days = num(r.days_since_issued);
  const clStale = (num(r.hours_since_cl_update) ?? 999) >= 24;

  // 체크카드만 쓰는 카드사는 신용한도가 없어서 대조 대상이 아님
  if (r.is_check_card && !r.has_dw_row) return null;

  const codes = [];
  const notes = [];

  // 발급 승인한도 → 현재 (최근 N일 발급분, 발급 후 감액 기록이 없는 변동만)
  if (issued > 0 && days !== null && days <= ISSUE_LOOKBACK_DAYS && days >= 2 && !r.decreased_after_issue) {
    const cur = dwTotal ?? clCur;
    if (cur === 0) {
      codes.push('ISS_ZERO');
      notes.push(`발급 승인 ${fmtAmt(issued)} → 현재 0원, 감액 기록 없음` +
        (r.dw_last_positive_date ? ` (카드사 마지막 정상일 ${r.dw_last_positive_date})` : ' (카드사 한도 반영 이력 없음)'));
    } else if (cur < issued && r.card_company !== 'BC') {
      // BC는 카드사 한도가 카드별 한도 합으로 잡혀 소폭 변동이 잦음 → 0원화만 본다
      codes.push('ISS_DROP');
      notes.push(`발급 승인 ${fmtAmt(issued)} → 현재 ${fmtAmt(cur)}, 감액 기록 없음`);
    }
  }
  // 내부 ↔ 카드사
  if (clCur > PLACEHOLDER_LIMIT && clStale) {
    if (!r.has_dw_row) {
      if (days === null || days >= 3) {
        codes.push('NOT_REFLECTED');
        notes.push(`내부 ${fmtAmt(clCur)}인데 카드사 한도 데이터 없음` +
          (r.dw_last_positive_date ? ` (카드사 마지막 정상일 ${r.dw_last_positive_date})` : ''));
      }
    } else if (dwTotal !== clCur) {
      codes.push('MISMATCH');
      notes.push(`내부 ${fmtAmt(clCur)} vs 카드사 ${fmtAmt(dwTotal)}`);
    }
  }
  if (!codes.length) return null;
  codes.sort((a, b) => CODES[a].sev - CODES[b].sev);
  return {
    key: `${r.bzno}|${r.card_company}`,
    tab: 'issuance',
    code: codes[0],
    codes,
    raw: { clCur, dwTotal, issued, clApproved: num(r.cl_approved), cardCnt: num(r.card_cnt) || 0, validCnt: num(r.valid_cnt) || 0, lastClosed: r.last_closed },
    corp_name: r.corp_name,
    bzno: r.bzno,
    card_company: r.card_company,
    cells: [
      r.issued_date || '', issued, num(r.cl_approved), clCur, dwTotal,
      r.dw_last_positive_date || '', r.last_decrease_date || '',
    ],
    note: notes.join(' · '),
  };
}

// ─── 사유 수집 (슬랙·CRM) ───
// 판정된 법인마다 내부 커뮤니케이션 기록에서 사유를 찾아 재판정한다.
// - 슬랙: 사용자 토큰(SLACK_USER_TOKEN)이 있으면 search.messages로 전 채널 검색,
//   없으면 봇이 읽을 수 있는 #bot-법인카드_한도상향신청정보만 본다.
// - CRM: ods_stream_crm.contact 최근 컨택 중 한도·보증금 관련 내용
const REASON_LOOKBACK_DAYS = 365; // 슬랙 (보증금 반환은 1년 전 건도 있음 — 예: 티박스 25-12 반환)
const CRM_LOOKBACK_DAYS = 365; // 보증금 반환 요청은 오래된 건도 있어 길게
const LIMIT_UP_CHANNEL = 'C04HH37DZM3'; // #bot-법인카드_한도상향신청정보
const FINANCE_CHANNEL_NAME = 'help-재무-법무'; // 보증금 반환 요청·완료가 오가는 채널
const userSlack = process.env.SLACK_USER_TOKEN ? new WebClient(process.env.SLACK_USER_TOKEN) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coreName = (n) => String(n || '').replace(/\(.*?\)/g, '').replace(/주식회사|유한회사|\(주\)|㈜|법무법인|농업회사법인/g, '').trim();
const fmtBzno = (b) => `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`;
const toAmount = (str) => (str ? Number(String(str).replace(/[^\d]/g, '')) : null);
const daysSinceDate = (d) => Math.floor((Date.now() - new Date(`${d}T00:00:00+09:00`).getTime()) / 86400000);
// 슬랙 마크업(멘션·인용·코드) 제거 후 자르기
const clip = (t, n = 120) => String(t || '')
  .replace(/<!subteam\^[^>]+>|<@[^>]+>|<!here>|<!channel>/g, '')
  .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
  .replace(/&gt;|>|`|\*/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, n);
const REFUND_GRACE_DAYS = 7; // 보증금 반환은 영업일 3~4일 소요 → 요청 후 7일까지는 진행 중으로 본다
// 여러 법인을 한꺼번에 나열하는 리포트성 메시지는 사유로 쓰지 않는다
const BULK_MSG = /Daily Report|현황\(|위험 법인 발생|확인 필요 건|이메일 발송|문자 발송|최종 계좌잔고|담당 \d+건|조정예정 스케줄/;

function normCard(t) {
  if (/롯데|LOTTE/.test(t)) return 'LOTTE';
  if (/신한|SHINHAN/.test(t)) return 'SHINHAN';
  if (/비씨|BC/.test(t)) return 'BC';
  if (/국민|KB/.test(t)) return 'KB';
  return null;
}

// 메시지가 이 법인 얘기인지: 사업자번호가 있거나, 법인명이 단어 경계로 등장
function mentionsCorp(text, corp) {
  if (text.includes(corp.bzno) || text.includes(fmtBzno(corp.bzno))) return true;
  // 다른 사업자번호가 적힌 메시지는 이름이 비슷해도 다른 법인 (예: '엔엠' vs '더씨엔엠')
  if (/\d{3}-\d{2}-\d{5}|\(\d{10}\)/.test(text)) return false;
  const core = coreName(corp.corp_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return core.length >= 2 && new RegExp(`(^|[^가-힣])${core}([^가-힣]|$)`).test(text);
}

// 슬랙 메시지 → 사유 이벤트
function parseEvent(raw, date, link) {
  const t = String(raw || '').replace(/&gt;/g, '>').replace(/\*/g, '').replace(/\s+/g, ' ');
  const base = { date, link, text: clip(t, 160) };
  const structured = /한도 하향 신청|한도조정예정|심사 결과|부여 한도|승인 완료 알림/.test(t);
  if (!structured && (BULK_MSG.test(t) || t.length > 500)) return null;
  if (/한도 하향 신청|한도조정예정/.test(t)) {
    const m = t.match(/하향 한도:\s*([\d,]+)원/) || t.match(/[\d,]+\s*→\s*([\d,]+)/);
    const why = (t.match(/(?:하향 사유|사유):\s*([^\s·>]+)/) || [])[1] || '';
    return { ...base, type: 'DEC', card: normCard((t.match(/카드사:\s*(\S+)/) || [])[1] || t), to: toAmount(m && m[1]), why, offset: /상계/.test(t) };
  }
  // 상향 심사완료 봇 메시지는 본문에 제목이 없고 '심사 결과 … 부여 한도'만 있음
  if (/한도상향 심사완료/.test(t) || (/심사 결과/.test(t) && /부여 한도/.test(t) && /APPROVAL/.test(t))) {
    const m = t.match(/부여 한도:\s*([\d,]+)/);
    return { ...base, type: 'UP', card: normCard((t.match(/카드사:\s*(\S+)/) || [])[1] || ''), to: toAmount(m && m[1]) };
  }
  if (/승인 완료 알림/.test(t)) return { ...base, type: 'ISSUED', card: normCard((t.match(/카드종류:\s*(\S+)/) || [])[1] || '') };
  if (/보증금/.test(t) && /(반환|지급)\s*완료|상계/.test(t)) return { ...base, type: 'REFUND_DONE' };
  if (/보증금/.test(t) && /반환/.test(t) && /요청|기안|상신/.test(t)) return { ...base, type: 'REFUND_REQ' };
  if (/해지|탈회|철회|드랍/.test(t)) return { ...base, type: 'EXIT' };
  if (/한도|보증금/.test(t)) return { ...base, type: 'NOTE' };
  return null;
}

const kstDateOfTs = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

async function collectSlackEvents(corps) {
  const events = new Map(corps.map((c) => [c.bzno, []]));
  const after = new Date(Date.now() - REASON_LOOKBACK_DAYS * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (userSlack) {
    for (const c of corps) {
      const queries = [`"${coreName(c.corp_name)}" after:${after}`];
      if (c.isDeposit) queries.push(`"${coreName(c.corp_name)}" in:#${FINANCE_CHANNEL_NAME}`);
      for (const q of queries) try {
        const res = await userSlack.search.messages({ query: q, sort: 'timestamp', sort_dir: 'desc', count: 30 });
        for (const m of res.messages?.matches || []) {
          if (m.username === BOT_USERNAME || /한도 정합성/.test(m.text || '')) continue;
          if (!mentionsCorp(m.text || '', c)) continue;
          const ev = parseEvent(m.text, kstDateOfTs(m.ts), m.permalink);
          if (!ev) continue;
          ev.threadTs = (String(m.permalink).match(/thread_ts=([\d.]+)/) || [])[1] || m.ts;
          ev.channelName = m.channel?.name;
          events.get(c.bzno).push(ev);
        }
      } catch (err) {
        console.error(`[Slack] ${c.corp_name} 검색 실패: ${err.data?.error || err.message}`);
      } finally {
        await sleep(3200); // search.messages Tier 2 (~20회/분)
      }
    }
    await linkRefundReplies(events);
    return { events, source: '슬랙 전체 검색' };
  }
  // 폴백: 봇이 읽을 수 있는 상향 심사 채널만
  let cursor;
  const oldest = String(Date.now() / 1000 - REASON_LOOKBACK_DAYS * 86400);
  do {
    const res = await slack.conversations.history({ channel: LIMIT_UP_CHANNEL, oldest, limit: 200, cursor });
    for (const m of res.messages || []) {
      for (const c of corps) {
        if (!mentionsCorp(m.text || '', c)) continue;
        const ev = parseEvent(m.text, kstDateOfTs(m.ts), `https://gowid.slack.com/archives/${LIMIT_UP_CHANNEL}/p${m.ts.replace('.', '')}`);
        if (ev) events.get(c.bzno).push(ev);
      }
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return { events, source: '상향 심사 채널(봇)' };
}

// 보증금 반환 요청 글의 스레드에 달린 "반환 완료" 답글 연결.
// 재무팀 완료 답글엔 법인명이 없어서(예: "반환 완료하였습니다") 법인명 검색으로는 안 잡힌다 → 스레드 ts로 매칭
async function linkRefundReplies(events) {
  for (const list of events.values()) {
    for (const req of list.filter((e) => e.type === 'REFUND_REQ' && e.threadTs && e.channelName)) {
      const from = new Date(Number(req.threadTs) * 1000 - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const to = new Date(Number(req.threadTs) * 1000 + 90 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      for (const kw of ['반환', '지급']) {
        try {
          const res = await userSlack.search.messages({ query: `${kw} in:#${req.channelName} after:${from} before:${to}`, sort: 'timestamp', sort_dir: 'asc', count: 100 });
          const m = (res.messages?.matches || []).find((x) =>
            /(반환|지급)\s*완료|상계/.test(x.text || '') && (String(x.permalink).match(/thread_ts=([\d.]+)/) || [])[1] === req.threadTs && x.ts !== req.threadTs);
          if (m) {
            list.push({ type: 'REFUND_DONE', date: kstDateOfTs(m.ts), link: m.permalink, text: `반환 요청 스레드에 완료 답글: ${clip(m.text, 100)}` });
            break;
          }
        } catch (err) {
          console.error(`[Slack] 반환 스레드 확인 실패: ${err.data?.error || err.message}`);
        }
        await sleep(3200);
      }
    }
  }
}

async function collectCrm(bznos) {
  if (!bznos.length) return new Map();
  const [rows] = await bq.query({
    location: LOCATION,
    params: { b: bznos.map(Number) },
    query: `
      WITH m AS (SELECT corp_id, gowid_corp_idx FROM \`gowid-prd.dw_dimension.corporation\` WHERE corp_id IN UNNEST(@b))
      SELECT CAST(COALESCE(m1.corp_id, m2.corp_id) AS STRING) AS bzno,
        CAST(DATE(c.contacted_at) AS STRING) AS d, c.content
      FROM \`gowid-prd.ods_stream_crm.contact\` c
      LEFT JOIN m m1 ON c.idx_corp_id = m1.corp_id
      LEFT JOIN m m2 ON c.idx_corp_id = m2.gowid_corp_idx
      WHERE c.is_deleted = 0 AND COALESCE(m1.corp_id, m2.corp_id) IS NOT NULL
        AND c.contacted_at >= DATETIME_SUB(CURRENT_DATETIME('Asia/Seoul'), INTERVAL ${CRM_LOOKBACK_DAYS} DAY)
        AND REGEXP_CONTAINS(c.content, r'한도|보증금|해지|탈회|반환|부결|하향|상향|연체|상계|철회')
      ORDER BY c.contacted_at DESC`,
  });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.bzno)) map.set(r.bzno, []);
    const t = String(r.content || '');
    const type = /보증금/.test(t) && /(반환|지급)\s*완료|상계/.test(t) ? 'REFUND_DONE'
      : /보증금[^.]{0,40}반환/.test(t) ? 'REFUND_REQ'
        : /해지|탈회|철회/.test(t) ? 'EXIT' : 'NOTE';
    map.get(r.bzno).push({ type, date: r.d, text: clip(t, 160), link: '', src: 'CRM' });
  }
  return map;
}

// 사유를 붙이고 판정을 다시 매긴다
function applyReasons(it, slackEvents, crmEvents) {
  const evs = [...(slackEvents || []), ...(crmEvents || [])].sort((a, b) => b.date.localeCompare(a.date));
  const sameCard = (e) => !e.card || it.tab === 'deposit' || e.card === it.card_company;
  const pick = (type) => evs.find((e) => e.type === type && sameCard(e));
  const setReason = (e, prefix = '') => {
    if (!e) return;
    it.reason = `${prefix}${e.date} ${e.src === 'CRM' ? '[CRM] ' : ''}${e.text}`;
    it.reasonLink = e.link || '';
  };
  const explain = (e, why) => { it.code = 'EXPLAINED'; it.note = `${why} · 원판정: ${it.note}`; setReason(e); };
  const { raw } = it;

  if (it.tab === 'issuance') {
    const dec = pick('DEC');
    const up = pick('UP');
    const exit = pick('EXIT');
    if (dec && dec.to !== null) {
      if ((raw.dwTotal ?? 0) === dec.to) return explain(dec, `${dec.why || ''} 하향 신청 반영됨`.trim());
      if (raw.clCur === dec.to) {
        it.code = 'DEC_NOT_APPLIED';
        it.note = `${dec.date} 하향 신청(${dec.why || '사유 미기재'}) → ${fmtAmt(dec.to)} · 내부는 반영, 카드사는 ${fmtAmt(raw.dwTotal)} 그대로`;
        return setReason(dec);
      }
    }
    if (up && up.to === raw.clCur && daysSinceDate(up.date) <= 5) return explain(up, '상향 승인 직후 카드사 반영 대기');
    const issuedEv = pick('ISSUED');
    if (it.code === 'NOT_REFLECTED' && issuedEv && daysSinceDate(issuedEv.date) <= 5) return explain(issuedEv, '신규 발급 직후 카드사 반영 대기');
    // 그 카드사 카드가 전부 해지됨 → 고객 사용 영향 없음, 내부 한도 기록만 남은 상태
    if (['NOT_REFLECTED', 'ISS_ZERO', 'MISMATCH'].includes(it.code) && raw.cardCnt > 0 && raw.validCnt === 0) {
      it.code = 'EXPLAINED';
      it.note = `카드 ${raw.cardCnt}장 전부 해지(마지막 ${raw.lastClosed || '-'}) — 내부 한도 기록만 남음 · 원판정: ${it.note}`;
      return setReason(evs.find((e) => e.src === 'CRM') || evs[0]);
    }
    // 발급 후 조정됐지만 내부 승인·현재·카드사가 모두 같은 값 → 정상 (예: 플러피팔레트 전문 9,500만 → 9,000만 정정)
    if (it.code === 'ISS_DROP' && raw.clApproved === raw.clCur && raw.clCur === raw.dwTotal && raw.clCur > 0) {
      it.code = 'EXPLAINED';
      it.note = `발급 후 ${fmtAmt(raw.clCur)}로 조정, 내부·카드사 일치 · 원판정: ${it.note}`;
      return setReason(evs[0]);
    }
    if (exit && ['ISS_ZERO', 'NOT_REFLECTED'].includes(it.code)) return explain(exit, '해지·탈회·철회 관련 대화 있음');
    return setReason(dec || up || exit || evs.find((e) => e.src === 'CRM') || evs[0]);
  }

  // 보증금
  const done = evs.find((e) => e.type === 'REFUND_DONE' || e.offset);
  const req = evs.find((e) => e.type === 'REFUND_REQ');
  if (['DEP_ZERO', 'DEP_UNREFUNDED'].includes(it.code) && raw.bal > 0) {
    if (done) return explain(done, `보증금 반환·상계 완료 (시스템 잔액 ${fmtAmt(raw.bal)} 미기록)`);
    if (req && daysSinceDate(req.date) <= REFUND_GRACE_DAYS) {
      it.code = 'EXPLAINED';
      it.note = `${req.date} 보증금 반환 진행 중 (${daysSinceDate(req.date)}일 차) · 원판정: ${it.note}`;
      return setReason(req);
    }
    if (req) {
      it.code = 'DEP_REFUND_PENDING';
      it.note = `${req.date} 반환 요청 후 ${daysSinceDate(req.date)}일 경과 · 보증금 잔액 ${fmtAmt(raw.bal)}`;
      return setReason(req);
    }
  }
  if (it.code === 'OVER_DEP' && it.codes.length === 1) {
    const up = evs.find((e) => e.type === 'UP');
    if (up) return explain(up, `일반 한도 상향 승인(${up.card || ''} ${fmtAmt(up.to)})`);
  }
  return setReason(done || req || evs.find((e) => e.src === 'CRM') || evs[0]);
}

async function attachReasons(items) {
  const corps = [...new Map(items.map((it) => [it.bzno, { bzno: it.bzno, corp_name: it.corp_name, isDeposit: it.tab === 'deposit' }])).values()];
  const [{ events, source }, crm] = await Promise.all([collectSlackEvents(corps), collectCrm(corps.map((c) => c.bzno))]);
  for (const it of items) applyReasons(it, events.get(it.bzno), crm.get(it.bzno));
  return source;
}

// ─── Utils ───
function hoursSince(dtStr) {
  if (!dtStr) return 999;
  // BQ DATETIME(KST 기준 문자열) — KST로 해석
  const t = new Date(String(dtStr).replace(' ', 'T').slice(0, 19) + '+09:00').getTime();
  return (Date.now() - t) / 3600000;
}

function fmtAmt(v) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  if (n === 0) return '0원';
  const eok = Math.floor(n / 1e8);
  const man = Math.round((n % 1e8) / 1e4);
  if (eok && man) return `${eok}억${man.toLocaleString()}만`;
  if (eok) return `${eok}억`;
  return `${man.toLocaleString()}만`;
}

function todayKstDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function tsToKstDate(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

const sortItems = (items) =>
  items.sort((a, b) => CODES[a.code].sev - CODES[b.code].sev || a.corp_name.localeCompare(b.corp_name, 'ko'));

// ─── Google Sheets ───
// rowKey: 시트 행 → 매칭 키. 보증금 탭 카드사 열은 한도 문자열이라 매일 바뀌므로 사업자번호만 사용
const TABS = {
  deposit: {
    name: '보증금',
    rowKey: (row) => row[3],
    headers: ['최초감지일', '판정', '법인명', '사업자번호', '카드사별 내부한도',
      '계약값(승인보증금)', '계약서', '입금액(해당 신청 건)', '보증금잔액', '내부한도 합계', '카드사한도 합계', '보증금 입금일',
      '상세', '사유(슬랙·CRM 자동)', '근거 링크', '진척사항', '메모'],
    money: [5, 7, 8, 9, 10],
  },
  issuance: {
    name: '발급',
    rowKey: (row) => `${row[3]}|${row[4]}`,
    headers: ['최초감지일', '판정', '법인명', '사업자번호', '카드사',
      '발급일', '발급 승인한도(카드사 확정)', '내부 승인한도', '내부 현재한도', '카드사 현재한도', '카드사 마지막 정상일', '마지막 감액일',
      '상세', '사유(슬랙·CRM 자동)', '근거 링크', '진척사항', '메모'],
    money: [6, 7, 8, 9],
  },
};
const RESOLVED_TAB = '해소';
const RESOLVED_HEADERS = ['해소일', '구분', '마지막 판정', '법인명', '사업자번호', '카드사', '최초감지일', '진척사항', '메모', '해소 사유', '근거 링크'];
const MANUAL_COLS = 2; // 마지막 2열(진척사항, 메모)은 수기 입력 — 갱신 시 보존

async function getSheetMap() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return Object.fromEntries(res.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
}

async function ensureTab(name, sheetMap) {
  if (sheetMap[name] !== undefined) return sheetMap[name];
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
  });
  const id = res.data.replies[0].addSheet.properties.sheetId;
  sheetMap[name] = id;
  return id;
}

async function readTab(name) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${name}'!A1:Z` });
  return res.data.values || [];
}

// 기존 행 → 매칭 키별 { firstSeen, code, corp_name, card_company, manual }
// 수기 열(진척사항·메모)은 헤더 이름으로 찾는다 — 열 구성이 바뀌어도 수기 입력이 밀리지 않게
function indexExisting(tab, values) {
  const [header = [], ...rows] = values;
  const progIdx = header.indexOf('진척사항');
  const memoIdx = header.indexOf('메모');
  const map = new Map();
  for (const row of rows) {
    if (!row[3]) continue;
    map.set(tab.rowKey(row), {
      firstSeen: row[0] || '',
      code: row[1] || '',
      corp_name: row[2] || '',
      bzno: row[3],
      card_company: row[4] || '',
      manual: [progIdx >= 0 ? row[progIdx] || '' : '', memoIdx >= 0 ? row[memoIdx] || '' : ''],
    });
  }
  return map;
}

async function writeTab(tab, sheetId, items, existing, today) {
  const rows = items.map((it) => {
    const prev = existing.get(it.key);
    it.isNew = !prev;
    const firstSeen = prev ? prev.firstSeen : today;
    const manual = prev ? prev.manual : ['', ''];
    return [firstSeen, CODES[it.code].label, it.corp_name, it.bzno, it.card_company,
      ...it.cells.map((v) => (v === null || v === undefined ? '' : v)), it.note, it.reason || '', it.reasonLink || '', ...manual];
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `'${tab.name}'!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tab.name}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [tab.headers, ...rows] },
  });
  await formatTab(sheetId, tab.headers.length, rows.length, tab.money);
}

async function formatTab(sheetId, colCount, rowCount, moneyCols) {
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount + 1, 2), startColumnIndex: colCount - MANUAL_COLS, endColumnIndex: colCount },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 0.95, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    },
    ...moneyCols.map((c) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    })),
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount } } },
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
}

async function appendResolved(resolved) {
  if (!resolved.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${RESOLVED_TAB}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: resolved },
  });
}

async function ensureResolvedHeader() {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `'${RESOLVED_TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [RESOLVED_HEADERS] },
  });
}

// 해소 탭에 이미 '사유 확인'으로 옮겨진 건 (매일 중복 추가 방지). 키 = 구분|사업자번호|카드사
async function readResolvedExplainedKeys() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESOLVED_TAB}'!A2:F` });
  return new Set((res.data.values || []).filter((r) => String(r[2] || '').startsWith('⚪')).map((r) => resolvedKey(r[1], r[4], r[5])));
}
// 보증금 탭의 카드사 열은 한도 문자열이라 매일 바뀜 → 사업자번호만으로 키를 만든다
const resolvedKey = (tabName, bzno, cc) => `${tabName}|${bzno}|${tabName === TABS.deposit.name ? '' : cc}`;

async function writeGuide(sheetId, dwDate) {
  const lines = [
    ['한도 정합성 점검 — 사용 가이드'],
    [''],
    ['목적', '한도가 단계 사이에서 끊긴 법인을 매일 찾아 운영이 선제 조치하기 위함 (예: 발급 땐 정상 → 실제 부여한도 0원)'],
    ['갱신', '매일 KST 09시대 자동 (GitHub Actions). 진척사항·메모(파란 열)는 갱신해도 보존됨'],
    ['카드사 한도 기준일', `${dwDate} (dw_metric.limit__date__corporation_card_company 최신일)`],
    [''],
    ['[보증금 탭] 계약서 값 = 입금액 = 현재 한도'],
    ['계약값', 'DepositApplication.approvedDepositAmount (모두싸인 계약서 금액 대체값 — 계약서 금액 자체는 DB에 없음)'],
    ['입금액', 'DepositManagement 입금(DEPOSIT) 합계 (해당 신청 건)'],
    ['보증금잔액', 'DepositManagement 최신 잔액 (추가 입금 반영)'],
    ['내부한도 / 카드사한도', '고위드 CardLimit 현재한도 합계 / 카드사 실제 총부여한도 합계'],
    ['제외', '보증금 반환 완료 법인, 고위드 자사 (탈회 법인은 보증금 잔액이 남은 경우만 표시)'],
    [''],
    ['[발급 탭] 발급 시 승인한도 = 현재 한도'],
    ['대상', `최근 ${ISSUE_LOOKBACK_DAYS}일 발급분은 발급 승인한도와 대조, 전체 발급 법인은 내부한도와 카드사한도 대조`],
    ['발급 승인한도', '발급일 카드사가 확정한 승인값 (CardLimit 기록). 고객 신청 한도가 아님'],
    ['제외', '발급 이후 감액(LimitDecrease 성공) 기록이 있는 변동, 1만원 플레이스홀더, 해지 카드, 삼성(제휴 중단), BC 소폭 감소(카드별 한도 합 구조)'],
    [''],
    ['[사유 열] 슬랙·CRM 자동 수집'],
    ['출처', `슬랙 검색(최근 ${REASON_LOOKBACK_DAYS}일: 한도 하향 신청·상향 심사완료·보증금 반환/상계·해지/탈회/철회) + CRM 컨택(최근 ${CRM_LOOKBACK_DAYS}일)`],
    ['재판정', '사유가 확인되면 ⚪로 내려 알림에서 빼고 시트에만 남김. 하향 신청 후 카드사가 그대로면 🔴 하향신청 카드사 미반영'],
    [''],
    ['판정', '의미 / 조치'],
    [CODES.ISS_ZERO.label, '발급 승인됐는데 현재 0원이고 감액 기록 없음 → 카드 사용 불가. 최우선 확인'],
    [CODES.DEP_ZERO.label, '보증금을 받아두고 한도가 0원 → 사용 불가 또는 보증금 반환 누락'],
    [CODES.MISMATCH.label, '고위드 내부 한도와 카드사 실제 한도가 다름 → 카드사 반영 누락/역반영 확인'],
    [CODES.NO_FILE.label, '보증금 승인됐는데 계약서 파일이 시스템에 없음'],
    [CODES.NOT_REFLECTED.label, '발급 3일 지났는데 카드사 한도 데이터가 없음'],
    [CODES.ISS_DROP.label, '발급 승인보다 현재 한도가 낮고 감액 기록 없음'],
    [CODES.DEC_NOT_APPLIED.label, '슬랙에 한도 하향 신청이 있고 내부는 반영됐는데 카드사 한도는 그대로 → 카드사 처리 확인 (리스크 노출)'],
    [CODES.DEP_UNREFUNDED.label, '탈회했는데 보증금 잔액이 남아 있음 → 반환 처리 누락 확인'],
    [CODES.DEP_REFUND_UNRECORDED.label, '슬랙·CRM상 반환/상계는 끝났는데 시스템 보증금 잔액이 남아 있음 → DepositManagement 기록 정리'],
    [CODES.DEP_REFUND_PENDING.label, `보증금 반환 요청 후 ${REFUND_GRACE_DAYS}일 넘게 시스템 잔액 그대로 → 반환 진행 여부 확인`],
    [CODES.DEP_IN_DIFF.label, '계약 금액과 입금 기록 금액이 다름'],
    [CODES.OVER_DEP.label, '한도가 보증금 잔액보다 큼 — 일반 신용한도가 함께 부여된 경우면 정상'],
    [CODES.EXPLAINED.label, '슬랙·CRM에서 사유가 확인된 건 (상향 승인, 하향 반영, 해지·탈회, 반환 진행 중). 알림 제외, 사유 열 확인'],
    [''],
    ['해소 탭', '전날까지 있다가 사라진 건이 해소일과 함께 자동 이동 (진척사항·메모 보존)'],
  ];
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `'가이드'!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `'가이드'!A1`, valueInputOption: 'RAW', requestBody: { values: lines },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 13 } } }, fields: 'userEnteredFormat.textFormat' } },
        { repeatCell: { range: { sheetId, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 720 }, fields: 'pixelSize' } },
      ],
    },
  });
}

async function syncSheet(depItems, issItems, dwDate) {
  const today = todayKstDate();
  const sheetMap = await getSheetMap();
  const guideId = await ensureTab('가이드', sheetMap);
  const depId = await ensureTab(TABS.deposit.name, sheetMap);
  const issId = await ensureTab(TABS.issuance.name, sheetMap);
  await ensureTab(RESOLVED_TAB, sheetMap);
  await ensureResolvedHeader();

  // 진짜 이상 건만 본 탭에 남기고, 사유가 확인된 건(⚪)은 해소 탭으로 보낸다
  const resolved = [];
  const explainedDone = await readResolvedExplainedKeys();
  for (const [tab, sheetId, allItems] of [[TABS.deposit, depId, depItems], [TABS.issuance, issId, issItems]]) {
    const items = allItems.filter((it) => it.code !== 'EXPLAINED');
    const explained = new Map(allItems.filter((it) => it.code === 'EXPLAINED').map((it) => [it.key, it]));
    const existing = indexExisting(tab, await readTab(tab.name));
    await writeTab(tab, sheetId, items, existing, today);

    const currentKeys = new Set(items.map((it) => it.key));
    for (const [key, prev] of existing) {
      if (currentKeys.has(key)) continue;
      const ex = explained.get(key);
      const cc = ex ? ex.card_company : prev.card_company;
      resolved.push([today, tab.name, ex ? CODES.EXPLAINED.label : prev.code, prev.corp_name, prev.bzno, cc, prev.firstSeen, ...prev.manual,
        ex ? `${ex.note}${ex.reason ? ` / ${ex.reason}` : ''}` : '판정에서 빠짐 (한도·보증금 데이터 정상화)', ex?.reasonLink || '']);
      if (ex) explainedDone.add(resolvedKey(tab.name, prev.bzno, cc));
      explained.delete(key);
    }
    // 시트에 올라온 적 없는 사유 확인 건도 기록 (이미 옮긴 건 제외)
    for (const ex of explained.values()) {
      const k = resolvedKey(tab.name, ex.bzno, ex.card_company);
      if (explainedDone.has(k)) continue;
      resolved.push([today, tab.name, CODES.EXPLAINED.label, ex.corp_name, ex.bzno, ex.card_company, today, '', '',
        `${ex.note}${ex.reason ? ` / ${ex.reason}` : ''}`, ex.reasonLink || '']);
      explainedDone.add(k);
    }
  }
  await appendResolved(resolved);
  await writeGuide(guideId, dwDate);
  return resolved.length;
}

// ─── Slack ───
function buildBlocks(depItems, issItems, resolvedCount, dwDate) {
  const today = todayKstDate();
  const countBy = (items) => {
    const m = {};
    for (const it of items) if (it.code !== 'EXPLAINED') m[it.code] = (m[it.code] || 0) + 1;
    return Object.entries(m).sort((a, b) => CODES[a[0]].sev - CODES[b[0]].sev)
      .map(([c, n]) => `${CODES[c].label} ${n}`).join('  ·  ') || '이상 없음 :white_check_mark:';
  };
  const line = (it) => `${it.isNew ? ':new: ' : ''}*${it.corp_name}* ${it.tab === 'issuance' ? `(${it.card_company}) ` : ''}— ${it.note}` +
    (it.reasonLink ? ` <${it.reasonLink}|근거>` : '');
  const urgent = (items) => items.filter((it) => it.code !== 'EXPLAINED' && (it.isNew || CODES[it.code].sev <= 2)); // 신규 + 🔴 전체

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `:mag: 한도 정합성 점검 (${today.slice(5).replace('-', '/')})` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*① 보증금* (계약서 값 = 입금액 = 현재 한도)\n${countBy(depItems)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*② 발급* (발급 승인한도 = 현재 한도)\n${countBy(issItems)}` } },
  ];

  const focus = [...urgent(depItems), ...urgent(issItems)];
  if (focus.length) {
    const MAX = 15;
    const text = focus.slice(0, MAX).map(line).join('\n') + (focus.length > MAX ? `\n…외 ${focus.length - MAX}건 (시트 참고)` : '');
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*신규 감지 + 🔴 최우선 건*\n${text}` } });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${SHEET_URL}|전체 목록·진척 관리 시트>  ·  ⚪ 슬랙·CRM에서 사유 확인되어 알림 제외 ${[...depItems, ...issItems].filter((it) => it.code === 'EXPLAINED').length}건  ·  어제 대비 해소 ${resolvedCount}건  ·  카드사 한도 기준일 ${dwDate}` }],
  });
  return blocks;
}

async function postSlack(blocks, summaryText) {
  const base = { channel: CHANNEL, username: BOT_USERNAME, icon_emoji: ':mag:', text: summaryText, blocks, unfurl_links: false, unfurl_media: false };
  if (NO_THREAD) {
    await slack.chat.postMessage(base);
    return;
  }
  const history = await slack.conversations.history({ channel: CHANNEL, limit: 30 });
  const parentMsg = history.messages.find((m) => m.bot_id === PARENT_BOT_ID);
  if (!parentMsg) throw new Error('온보딩 퍼널별 고객 터치 알림 봇 메시지를 찾을 수 없습니다.');

  // 멱등성: 오늘자 같은 이름의 답글이 이미 있으면 skip (GHA 분산 cron 중복 방지)
  if (!FORCE) {
    try {
      const replies = await slack.conversations.replies({ channel: CHANNEL, ts: parentMsg.ts });
      const dup = (replies.messages || []).find((m) =>
        (m.username === BOT_USERNAME || m.bot_profile?.name === BOT_USERNAME) && tsToKstDate(m.ts) === todayKstDate());
      if (dup) {
        console.log(`이미 오늘자 알림이 쓰레드에 있어 슬랙 발송 skip (ts=${dup.ts})`);
        return;
      }
    } catch (err) {
      // 조회 실패 시 발송 진행 (누락이 중복보다 위험)
      console.error(`중복 체크 실패 (계속 진행): ${err.message}`);
    }
  }
  await slack.chat.postMessage({ ...base, thread_ts: parentMsg.ts });
}

// ─── Main ───
async function main() {
  console.log('📥 BigQuery 조회 중...');
  const [depRows, issRows] = await Promise.all([fetchDeposit(), fetchIssuance()]);
  const dwDate = depRows[0]?.dw_date || issRows[0]?.dw_date || '-';
  const depItems = depRows.map(classifyDeposit).filter(Boolean);
  const issItems = issRows.map(classifyIssuance).filter(Boolean);
  console.log(`🔎 사유 수집 중 (판정 ${depItems.length + issItems.length}건)...`);
  const reasonSource = await attachReasons([...depItems, ...issItems]);
  console.log(`사유 출처: ${reasonSource} + CRM`);
  sortItems(depItems);
  sortItems(issItems);
  console.log(`보증금: 대상 ${depRows.length}개 법인 → 판정 ${depItems.length}건`);
  console.log(`발급: 대상 ${issRows.length}개 법인×카드사 → 판정 ${issItems.length}건`);

  if (DRY_RUN) {
    for (const [title, items] of [['① 보증금', depItems], ['② 발급', issItems]]) {
      console.log(`\n=== ${title} ===`);
      for (const it of items) console.log(`${CODES[it.code].label}\t${it.corp_name}\t${it.card_company}\t${it.note}${it.reason ? `\n\t\t└ 사유: ${it.reason}` : ''}`);
    }
    console.log('\n=== 슬랙 미리보기 (신규 여부는 시트 대조 전이라 미표시) ===');
    for (const b of buildBlocks(depItems, issItems, 0, dwDate)) {
      if (b.type === 'header') console.log(`# ${b.text.text}`);
      else if (b.type === 'section') console.log(b.text.text + '\n');
      else if (b.type === 'context') console.log(`(${b.elements[0].text})`);
    }
    return;
  }

  console.log('📝 시트 갱신 중...');
  const resolvedCount = await syncSheet(depItems, issItems, dwDate);
  console.log(`✅ 시트 갱신 완료 (해소 이동 ${resolvedCount}건)`);

  if (NO_SLACK) return;
  const blocks = buildBlocks(depItems, issItems, resolvedCount, dwDate);
  const open = (items) => items.filter((it) => it.code !== 'EXPLAINED').length;
  const summary = `한도 정합성 점검: 보증금 ${open(depItems)}건, 발급 ${open(issItems)}건`;
  console.log('💬 슬랙 발송 중...');
  await postSlack(blocks, summary);
  console.log('✅ 완료');
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
