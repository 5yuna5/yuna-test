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
  MISMATCH: { label: '🔴 내부한도≠카드사한도', sev: 2 },
  NO_FILE: { label: '🔴 계약서 파일 없음', sev: 2 },
  NOT_REFLECTED: { label: '🟠 카드사 한도 미반영', sev: 3 },
  ISS_DROP: { label: '🟠 사유없는 감소', sev: 3 },
  DEP_UNREFUNDED: { label: '🟠 탈회·보증금 미반환', sev: 3 },
  DEP_IN_DIFF: { label: '🟠 계약값≠입금액', sev: 3 },
  OVER_DEP: { label: '🟡 한도>보증금잔액(확인)', sev: 4 },
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
    SELECT idx FROM \`gowid-prd.ods_stream_gowid.Corp\`
    WHERE isDeleted = 1
    QUALIFY ROW_NUMBER() OVER (PARTITION BY idx ORDER BY datastream_metadata.source_timestamp DESC) = 1
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
    iss.granted_limit AS issued_limit,
    cl.cl_approved, cl.cl_current, cl.last_changed_type,
    CAST(cl.cl_updated_at AS STRING) AS cl_updated_at,
    DATETIME_DIFF(CURRENT_DATETIME('Asia/Seoul'), cl.cl_updated_at, HOUR) AS hours_since_cl_update,
    dw.corp_id IS NOT NULL AS has_dw_row, dw.dw_total,
    CAST(h.last_positive_date AS STRING) AS dw_last_positive_date,
    CAST(DATE(ld.last_decrease_at) AS STRING) AS last_decrease_date,
    ld.last_decrease_at IS NOT NULL AND ld.last_decrease_at >= DATETIME(iss.issued_at, 'Asia/Seoul') AS decreased_after_issue,
    CAST((SELECT d FROM dwd) AS STRING) AS dw_date
  FROM cl
  JOIN cc ON cc.card_company_code = cl.cardCompany
  JOIN corp ON corp.gowid_corp_idx = cl.idxCorp
  LEFT JOIN iss ON iss.corp_id = corp.corp_id AND iss.card_company_id = cc.card_company_id
  LEFT JOIN dw ON dw.corp_id = corp.corp_id AND dw.card_company_id = cc.card_company_id
  LEFT JOIN dw_hist h ON h.corp_id = corp.corp_id AND h.card_company_id = cc.card_company_id
  LEFT JOIN ld ON ld.idxCorp = cl.idxCorp AND ld.cardCompany = cl.cardCompany
  WHERE cl.is_issued = 1
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
  if ((depIn ?? 0) !== contract) {
    codes.push('DEP_IN_DIFF');
    notes.push(`계약 ${fmtAmt(contract)} vs 입금기록 ${depIn === null ? '없음' : fmtAmt(depIn)}`);
  }
  if (lim > bal && bal > 0) {
    codes.push('OVER_DEP');
    notes.push(`한도 ${fmtAmt(lim)} > 보증금잔액 ${fmtAmt(bal)} (일반 신용한도 혼합 여부 확인)`);
  }
  if (!codes.length) return null;
  return {
    key: r.bzno,
    code: codes[0],
    codes,
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

  const codes = [];
  const notes = [];

  // 발급 승인한도 → 현재 (최근 N일 발급분, 발급 후 감액 기록이 없는 변동만)
  if (issued > 0 && days !== null && days <= ISSUE_LOOKBACK_DAYS && days >= 2 && !r.decreased_after_issue) {
    const cur = dwTotal ?? clCur;
    if (cur === 0) {
      codes.push('ISS_ZERO');
      notes.push(`발급 승인 ${fmtAmt(issued)} → 현재 0원, 감액 기록 없음` +
        (r.dw_last_positive_date ? ` (카드사 마지막 정상일 ${r.dw_last_positive_date})` : ' (카드사 한도 반영 이력 없음)'));
    } else if (cur < issued) {
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
    code: codes[0],
    codes,
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
      '계약값(승인보증금)', '계약서', '입금액', '보증금잔액', '내부한도 합계', '카드사한도 합계', '보증금 입금일',
      '상세', '진척사항', '메모'],
    money: [5, 7, 8, 9, 10],
  },
  issuance: {
    name: '발급',
    rowKey: (row) => `${row[3]}|${row[4]}`,
    headers: ['최초감지일', '판정', '법인명', '사업자번호', '카드사',
      '발급일', '발급 승인한도', '내부 승인한도', '내부 현재한도', '카드사 현재한도', '카드사 마지막 정상일', '마지막 감액일',
      '상세', '진척사항', '메모'],
    money: [6, 7, 8, 9],
  },
};
const RESOLVED_TAB = '해소';
const RESOLVED_HEADERS = ['해소일', '구분', '마지막 판정', '법인명', '사업자번호', '카드사', '최초감지일', '진척사항', '메모'];
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${name}'!A2:Z` });
  return res.data.values || [];
}

// 기존 행 → 매칭 키별 { firstSeen, code, corp_name, card_company, manual }
function indexExisting(tab, rows) {
  const n = tab.headers.length;
  const map = new Map();
  for (const row of rows) {
    if (!row[3]) continue;
    map.set(tab.rowKey(row), {
      firstSeen: row[0] || '',
      code: row[1] || '',
      corp_name: row[2] || '',
      bzno: row[3],
      card_company: row[4] || '',
      manual: [row[n - 2] || '', row[n - 1] || ''],
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
      ...it.cells.map((v) => (v === null || v === undefined ? '' : v)), it.note, ...manual];
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESOLVED_TAB}'!A1:A1` });
  if (!res.data.values) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `'${RESOLVED_TAB}'!A1`, valueInputOption: 'RAW',
      requestBody: { values: [RESOLVED_HEADERS] },
    });
  }
}

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
    ['제외', '발급 이후 시스템/수동 감액(LimitDecrease 성공) 기록이 있는 변동, 1만원 플레이스홀더, 해지 카드'],
    [''],
    ['판정', '의미 / 조치'],
    [CODES.ISS_ZERO.label, '발급 승인됐는데 현재 0원이고 감액 기록 없음 → 카드 사용 불가. 최우선 확인'],
    [CODES.DEP_ZERO.label, '보증금을 받아두고 한도가 0원 → 사용 불가 또는 보증금 반환 누락'],
    [CODES.MISMATCH.label, '고위드 내부 한도와 카드사 실제 한도가 다름 → 카드사 반영 누락/역반영 확인'],
    [CODES.NO_FILE.label, '보증금 승인됐는데 계약서 파일이 시스템에 없음'],
    [CODES.NOT_REFLECTED.label, '발급 3일 지났는데 카드사 한도 데이터가 없음'],
    [CODES.ISS_DROP.label, '발급 승인보다 현재 한도가 낮고 감액 기록 없음'],
    [CODES.DEP_UNREFUNDED.label, '탈회했는데 보증금 잔액이 남아 있음 → 반환 처리 누락 확인'],
    [CODES.DEP_IN_DIFF.label, '계약 금액과 입금 기록 금액이 다름'],
    [CODES.OVER_DEP.label, '한도가 보증금 잔액보다 큼 — 일반 신용한도가 함께 부여된 경우면 정상'],
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

  const resolved = [];
  for (const [tab, sheetId, items] of [[TABS.deposit, depId, depItems], [TABS.issuance, issId, issItems]]) {
    const existing = indexExisting(tab, await readTab(tab.name));
    await writeTab(tab, sheetId, items, existing, today);

    // 어제 있었는데 오늘 사라진 건 → 해소 탭으로
    const currentKeys = new Set(items.map((it) => it.key));
    for (const [key, prev] of existing) {
      if (currentKeys.has(key)) continue;
      resolved.push([today, tab.name, prev.code, prev.corp_name, prev.bzno, prev.card_company, prev.firstSeen, ...prev.manual]);
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
    for (const it of items) m[it.code] = (m[it.code] || 0) + 1;
    return Object.entries(m).sort((a, b) => CODES[a[0]].sev - CODES[b[0]].sev)
      .map(([c, n]) => `${CODES[c].label} ${n}`).join('  ·  ') || '이상 없음 :white_check_mark:';
  };
  const line = (it) => `${it.isNew ? ':new: ' : ''}*${it.corp_name}* ${it.card_company !== '-' && !it.card_company.includes(':') ? `(${it.card_company}) ` : ''}— ${it.note}`;
  const urgent = (items) => items.filter((it) => it.isNew || CODES[it.code].sev <= 2); // 신규 + 🔴 전체

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
    elements: [{ type: 'mrkdwn', text: `<${SHEET_URL}|전체 목록·진척 관리 시트>  ·  어제 대비 해소 ${resolvedCount}건  ·  카드사 한도 기준일 ${dwDate}` }],
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
  const depItems = sortItems(depRows.map(classifyDeposit).filter(Boolean));
  const issItems = sortItems(issRows.map(classifyIssuance).filter(Boolean));
  console.log(`보증금: 대상 ${depRows.length}개 법인 → 판정 ${depItems.length}건`);
  console.log(`발급: 대상 ${issRows.length}개 법인×카드사 → 판정 ${issItems.length}건`);

  if (DRY_RUN) {
    for (const [title, items] of [['① 보증금', depItems], ['② 발급', issItems]]) {
      console.log(`\n=== ${title} ===`);
      for (const it of items) console.log(`${CODES[it.code].label}\t${it.corp_name}\t${it.card_company}\t${it.note}`);
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
  const summary = `한도 정합성 점검: 보증금 ${depItems.length}건, 발급 ${issItems.length}건`;
  console.log('💬 슬랙 발송 중...');
  await postSlack(blocks, summary);
  console.log('✅ 완료');
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
