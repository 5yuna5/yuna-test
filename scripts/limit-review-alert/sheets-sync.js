#!/usr/bin/env node
/**
 * 한도 심사·반영 대기 — Google Sheets 직접 동기화
 *
 * Usage:
 *   node sheets-sync.js              # 시트 동기화
 *   node sheets-sync.js --dry-run    # 콘솔 출력만
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '../crm-slack-bot/.env') }); } catch (e) { /* CI 환경에서는 .env 없음 */ }

const { BigQuery } = require('@google-cloud/bigquery');
const { google } = require('googleapis');
const path = require('path');

// ─── Config ───
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';
const SPREADSHEET_ID = '11R_Kjl3J9ZSDHZFndUVlpm0hjtw7dWE82UuS7-Ofbkw';

const EXCLUDED_CORP_NAMES = ['고위드', 'GOWID'];
const WARN_DAYS = 5, ALERT_DAYS = 10;
const GOWID_WARN_DAYS = 3, GOWID_ALERT_DAYS = 5;

const DRY_RUN = process.argv.includes('--dry-run');

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });

// Google Sheets 인증
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ─── BigQuery ───

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

function corpExcludeWhere(alias) {
  return EXCLUDED_CORP_NAMES.map(n => `${alias}.corp_name NOT LIKE '%${n}%'`).join(' AND ');
}

// 섹션1: 카드사 심사 대기
async function fetchPending() {
  const rows = await query(`
    WITH pending AS (
      SELECT s.id, s.corp_id, s.corp_name, s.card_company_name, s.application_type,
        s.current_limit_amount, s.requested_limit_amount,
        CAST(s.initialized_at AS DATE) AS applied_date,
        (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7))
         FROM UNNEST(GENERATE_DATE_ARRAY(
           DATE_ADD(CAST(s.card_co_pending_at AS DATE), INTERVAL 1 DAY), CURRENT_DATE()
         )) AS d) AS days_elapsed,
        s.card_co_pending_at,
        cor.assigned_am AS am_name,
        COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel
      FROM \`gowid-prd.mart_limit_application.application_status\` s
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON s.corp_id = cor.corp_id
      WHERE s.application_type IN ('한도상향', '카드사 추가')
        AND s.card_co_pending_at IS NOT NULL AND s.card_co_approved_at IS NULL
        AND s.card_co_rejected_at IS NULL AND s.gowid_rejected_at IS NULL AND s.canceled_at IS NULL
        AND ${corpExcludeWhere('s')}
    ),
    before_pending AS (
      SELECT p.id, MAX(l.total_granted_limit) AS limit_before
      FROM pending p
      JOIN \`gowid-prd.dw_dimension.card_company\` cc ON p.card_company_name = cc.card_company_name
      JOIN \`gowid-prd.dw_metric.limit__date__corporation_card_company\` l
        ON p.corp_id = l.corp_id AND cc.card_company_id = l.card_company_id
        AND l.date_id BETWEEN DATE_SUB(CAST(p.card_co_pending_at AS DATE), INTERVAL 14 DAY)
                         AND DATE_SUB(CAST(p.card_co_pending_at AS DATE), INTERVAL 3 DAY)
      GROUP BY 1
    ),
    peak_after AS (
      SELECT p.id, MAX(l.total_granted_limit) AS limit_peak
      FROM pending p
      JOIN \`gowid-prd.dw_dimension.card_company\` cc ON p.card_company_name = cc.card_company_name
      JOIN \`gowid-prd.dw_metric.limit__date__corporation_card_company\` l
        ON p.corp_id = l.corp_id AND cc.card_company_id = l.card_company_id
        AND l.date_id >= DATE_SUB(CAST(p.card_co_pending_at AS DATE), INTERVAL 2 DAY)
      GROUP BY 1
    ),
    current_metric AS (
      SELECT p.id, MAX(l.total_granted_limit) AS limit_current
      FROM pending p
      JOIN \`gowid-prd.dw_dimension.card_company\` cc ON p.card_company_name = cc.card_company_name
      JOIN \`gowid-prd.dw_metric.limit__date__corporation_card_company\` l
        ON p.corp_id = l.corp_id AND cc.card_company_id = l.card_company_id
        AND l.date_id >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
      GROUP BY 1
    )
    SELECT p.corp_name, p.card_company_name, p.application_type,
      p.current_limit_amount, p.requested_limit_amount, p.applied_date,
      p.days_elapsed, p.am_name, p.is_fuel
    FROM pending p
    LEFT JOIN before_pending bp ON p.id = bp.id
    LEFT JOIN peak_after pa ON p.id = pa.id
    LEFT JOIN current_metric cm ON p.id = cm.id
    WHERE NOT (
      bp.limit_before IS NOT NULL AND pa.limit_peak IS NOT NULL AND cm.limit_current IS NOT NULL
      AND pa.limit_peak > bp.limit_before AND cm.limit_current < pa.limit_peak
    )
    ORDER BY p.days_elapsed DESC, p.corp_name
  `);
  return rows;
}

// 섹션1.5: 고위드 승인 · 카드사 미접수
async function fetchGowidPending() {
  return await query(`
    SELECT
      s.corp_name, s.card_company_name, s.application_type,
      s.current_limit_amount, s.requested_limit_amount,
      CAST(s.initialized_at AS DATE) AS applied_date,
      (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7))
       FROM UNNEST(GENERATE_DATE_ARRAY(
         DATE_ADD(CAST(s.gowid_approved_at AS DATE), INTERVAL 1 DAY), CURRENT_DATE()
       )) AS d) AS days_elapsed,
      cor.assigned_am AS am_name,
      COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel
    FROM \`gowid-prd.mart_limit_application.application_status\` s
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON s.corp_id = cor.corp_id
    WHERE s.application_type IN ('한도상향', '카드사 추가')
      AND s.gowid_approved_at IS NOT NULL
      AND s.card_co_pending_at IS NULL AND s.card_co_approved_at IS NULL
      AND s.card_co_rejected_at IS NULL AND s.gowid_rejected_at IS NULL AND s.canceled_at IS NULL
      AND ${corpExcludeWhere('s')}
    ORDER BY days_elapsed DESC, s.corp_name
  `);
}

// 섹션2: 승인 완료 · 한도 미반영
async function fetchUnapplied() {
  return await query(`
    WITH latest AS (
      SELECT s.*,
        ROW_NUMBER() OVER (PARTITION BY s.corp_id, s.card_company_name ORDER BY s.card_co_approved_at DESC) AS rn
      FROM \`gowid-prd.mart_limit_application.application_status\` s
      WHERE s.application_type IN ('한도상향', '카드사 추가')
        AND s.card_co_approved_at IS NOT NULL
        AND s.gowid_rejected_at IS NULL AND s.canceled_at IS NULL AND s.card_co_rejected_at IS NULL
        AND ${corpExcludeWhere('s')}
    ),
    approved_latest AS (SELECT * FROM latest WHERE rn = 1),
    newer_pending AS (
      SELECT DISTINCT s.corp_id, s.card_company_name
      FROM \`gowid-prd.mart_limit_application.application_status\` s
      WHERE s.application_type IN ('한도상향', '카드사 추가')
        AND s.card_co_pending_at IS NOT NULL AND s.card_co_approved_at IS NULL
        AND s.card_co_rejected_at IS NULL AND s.gowid_rejected_at IS NULL AND s.canceled_at IS NULL
    ),
    before_limit AS (
      SELECT a.id, MAX(l.total_granted_limit) AS limit_before
      FROM approved_latest a
      JOIN \`gowid-prd.dw_dimension.card_company\` cc ON a.card_company_name = cc.card_company_name
      JOIN \`gowid-prd.dw_metric.limit__date__corporation_card_company\` l
        ON a.corp_id = l.corp_id AND cc.card_company_id = l.card_company_id
        AND l.date_id BETWEEN DATE_SUB(CAST(a.card_co_approved_at AS DATE), INTERVAL 14 DAY)
                         AND DATE_SUB(CAST(a.card_co_approved_at AS DATE), INTERVAL 3 DAY)
      GROUP BY 1
    ),
    after_limit AS (
      SELECT a.id, MAX(l.total_granted_limit) AS limit_after
      FROM approved_latest a
      JOIN \`gowid-prd.dw_dimension.card_company\` cc ON a.card_company_name = cc.card_company_name
      JOIN \`gowid-prd.dw_metric.limit__date__corporation_card_company\` l
        ON a.corp_id = l.corp_id AND cc.card_company_id = l.card_company_id
        AND l.date_id >= DATE_SUB(CAST(a.card_co_approved_at AS DATE), INTERVAL 2 DAY)
      GROUP BY 1
    )
    SELECT a.corp_name, a.card_company_name, a.application_type,
      a.current_limit_amount,
      CAST(a.initialized_at AS DATE) AS applied_date,
      (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7))
       FROM UNNEST(GENERATE_DATE_ARRAY(
         DATE_ADD(CAST(a.card_co_approved_at AS DATE), INTERVAL 1 DAY), CURRENT_DATE()
       )) AS d) AS days_elapsed,
      cor.assigned_am AS am_name,
      COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel
    FROM approved_latest a
    JOIN before_limit b ON a.id = b.id
    JOIN after_limit af ON a.id = af.id
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON a.corp_id = cor.corp_id
    LEFT JOIN newer_pending np ON a.corp_id = np.corp_id AND a.card_company_name = np.card_company_name
    WHERE af.limit_after = b.limit_before
      AND a.current_limit_amount >= b.limit_before
      AND (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7))
           FROM UNNEST(GENERATE_DATE_ARRAY(
             DATE_ADD(CAST(a.card_co_approved_at AS DATE), INTERVAL 1 DAY), CURRENT_DATE()
           )) AS d) >= 3
      AND a.requested_limit_amount > 0
      AND a.requested_limit_amount > a.current_limit_amount
      AND np.corp_id IS NULL
    ORDER BY days_elapsed DESC, a.corp_name
  `);
}

// Staging 보정
async function fetchStagingCorrections() {
  const rows = await query(`
    WITH ccm AS (
      SELECT 'SHINHAN' AS code, '신한카드' AS name UNION ALL
      SELECT 'LOTTE', '롯데카드' UNION ALL
      SELECT 'BC', '비씨카드'
    ),
    staging_latest AS (
      SELECT s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s.gowid_corp_idx, s.card_company_code
          ORDER BY s.limit_application_id DESC
        ) AS rn
      FROM \`gowid-prd.dw_staging.stg_gowid__limit_application_current_status\` s
      WHERE s.application_type IN ('한도상향', '카드사 추가')
    )
    SELECT
      d.corp_name, ccm.name AS card_company_name,
      sl.latest_status,
      (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM dd) NOT IN (1, 7))
       FROM UNNEST(GENERATE_DATE_ARRAY(
         DATE_ADD(DATE(f.card_co_pending_at), INTERVAL 1 DAY), CURRENT_DATE()
       )) AS dd) AS pending_days_elapsed
    FROM staging_latest sl
    JOIN \`gowid-prd.dw_staging.stg_gowid__limit_application_funnel\` f ON sl.id = f.id
    JOIN \`gowid-prd.dw_dimension.corporation\` d ON sl.gowid_corp_idx = d.gowid_corp_idx
    LEFT JOIN ccm ON sl.card_company_code = ccm.code
    WHERE sl.rn = 1
      AND sl.latest_status IN ('카드사 심사중', '카드사 승인', '카드사 부결')
      AND ${corpExcludeWhere('d')}
  `);
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.corp_name}|${r.card_company_name}`, {
      status: r.latest_status,
      days_elapsed: Number(r.pending_days_elapsed) || 0,
    });
  }
  return map;
}

// ─── Formatting ───

function fmtAmt(v) {
  if (!v || v === 0 || v === '0') return '-';
  const n = Number(v);
  const eok = Math.floor(n / 1e8);
  const man = Math.round((n % 1e8) / 1e4);
  if (eok > 0 && man > 0) return `${eok}억${man}만`;
  if (eok > 0) return `${eok}억`;
  if (man > 0) return `${man}만`;
  return n.toLocaleString();
}

function rowKey(r) {
  return `${r.corp_name}|${r.card_company_name}`;
}

// ─── Staging Correction ───

function applyStagingCorrections(pendingRows, gowidRows, stagingMap) {
  const correctedPending = [];
  const correctedGowid = [];
  let moved = 0, resolved = 0;

  for (const g of gowidRows) {
    const stg = stagingMap.get(rowKey(g));
    if (stg && stg.status === '카드사 심사중') {
      correctedPending.push({ ...g, days_elapsed: stg.days_elapsed });
      moved++;
    } else {
      correctedGowid.push(g);
    }
  }

  const allPending = [...pendingRows, ...correctedPending];
  const filteredPending = allPending.filter(p => {
    const stg = stagingMap.get(rowKey(p));
    if (stg && (stg.status === '카드사 승인' || stg.status === '카드사 부결')) {
      resolved++;
      return false;
    }
    return true;
  });

  filteredPending.sort((a, b) => (Number(b.days_elapsed) || 0) - (Number(a.days_elapsed) || 0));
  correctedGowid.sort((a, b) => (Number(b.days_elapsed) || 0) - (Number(a.days_elapsed) || 0));

  return { pending: filteredPending, gowid: correctedGowid, moved, resolved };
}

// ─── Sheet Operations ───

async function getSheetId(sheetName) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const s = res.data.sheets.find(s => s.properties.title === sheetName);
  return s ? s.properties.sheetId : null;
}

async function ensureTab(sheetName) {
  const id = await getSheetId(sheetName);
  if (id !== null) return id;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function readExistingManual(sheetName) {
  // 기존 수기 입력(진척사항, 메모) 보존을 위해 읽기
  const map = new Map();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:M`,
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return map;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      // A=갱신일, B=신청일, C=법인명, D=카드사 → key = C|D
      const key = `${r[2] || ''}|${r[3] || ''}`;
      const progress = r[10] || '';  // K열 = 진척사항
      const memo = r[11] || '';      // L열 = 메모
      if (progress || memo) {
        map.set(key, { progress, memo });
      }
    }
  } catch (e) {
    // 탭이 비어있으면 무시
  }
  return map;
}

function toSheetRow(r, section, manualMap, today) {
  const key = rowKey(r);
  const manual = manualMap.get(key) || {};
  return [
    today,                                                       // A: 갱신일
    r.applied_date ? r.applied_date.value || r.applied_date : '',// B: 신청일
    r.corp_name || '',                                           // C: 법인명
    r.card_company_name || '',                                   // D: 카드사
    r.application_type || '',                                    // E: 유형
    (r.is_fuel === true || r.is_fuel === 'true') ? 'Y' : '',    // F: FUEL
    Number(r.current_limit_amount) || 0,                         // G: 현재한도 (원)
    Number(r.requested_limit_amount) || 0,                       // H: 요청한도 (원)
    Number(r.days_elapsed) || 0,                                 // I: 경과일
    r.am_name || '',                                             // J: AM
    manual.progress || '',                                       // K: 진척사항 (보존)
    manual.memo || '',                                           // L: 메모 (보존)
  ];
}

async function writeTab(sheetName, sheetId, rows, manualMap, today) {
  const HEADERS = ['갱신일','신청일','법인명','카드사','유형','FUEL','현재한도','요청한도','경과일(영업일)','AM','진척사항','메모'];

  const data = [HEADERS];
  for (const r of rows) {
    data.push(toSheetRow(r, sheetName, manualMap, today));
  }

  // 시트 초기화 + 데이터 쓰기
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: data },
  });

  // 기존 조건부 서식 삭제 후 서식 적용
  await clearConditionalFormats(sheetId);
  await applyFormatting(sheetId, rows.length, HEADERS.length);
}

async function clearConditionalFormats(sheetId) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId),conditionalFormats)',
  });
  const sheet = res.data.sheets.find(s => s.properties.sheetId === sheetId);
  const rules = sheet?.conditionalFormats || [];
  if (rules.length === 0) return;

  // 역순으로 삭제 (인덱스 밀림 방지)
  const requests = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
}

async function applyFormatting(sheetId, rowCount, colCount) {
  const requests = [];

  // 헤더 서식: 굵게, 회색 배경, 고정
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
          textFormat: { bold: true },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  });
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // 진척사항/메모 컬럼 배경 (K-L = 10-11)
  if (rowCount > 0) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: rowCount + 1, startColumnIndex: 10, endColumnIndex: 12 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.94, green: 0.97, blue: 1.0 },
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }

  // 조건부 서식: 경과일(H열=7) 기준 행 전체 색상
  // 10일+ → 빨간 배경
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount + 1, 100) }],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: '=$I2>=' + ALERT_DAYS }],
          },
          format: {
            backgroundColor: { red: 1.0, green: 0.95, blue: 0.95 },
          },
        },
      },
      index: 0,
    },
  });
  // 5일+ → 노란 배경
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount + 1, 100) }],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: '=AND($I2>=' + WARN_DAYS + ',$I2<' + ALERT_DAYS + ')' }],
          },
          format: {
            backgroundColor: { red: 1.0, green: 0.98, blue: 0.92 },
          },
        },
      },
      index: 1,
    },
  });

  // 현재한도/요청한도 (F-G = 5-6) 숫자 서식: 천단위 콤마
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount + 1, 100), startColumnIndex: 6, endColumnIndex: 8 },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: 'NUMBER', pattern: '#,##0' },
        },
      },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  // 열 너비
  const widths = [85, 85, 200, 80, 90, 45, 130, 130, 80, 65, 250, 200];
  widths.forEach((w, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    });
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
}

async function writeDoneTab(removedItems, fromTab) {
  if (removedItems.length === 0) return;

  const sheetId = await ensureTab('완료');
  const HEADERS = ['법인명','카드사','유형','완료일','이전탭','진척사항','메모'];

  // 기존 데이터 확인
  let existingRows = 0;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '완료!A:A',
    });
    existingRows = (res.data.values || []).length;
  } catch (e) { /* empty */ }

  // 헤더가 없으면 추가
  if (existingRows === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: '완료!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] },
    });
    existingRows = 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const doneRows = removedItems.map(item => [
    item.corpName, item.cardCompany, item.type,
    today, fromTab, item.progress || '', item.memo || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: '완료!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: doneRows },
  });
}

async function detectRemoved(sheetName, newRows) {
  const newKeys = new Set(newRows.map(r => rowKey(r)));
  const removed = [];

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:L`,
    });
    const existing = res.data.values || [];
    for (let i = 1; i < existing.length; i++) {
      const r = existing[i];
      const key = `${r[2] || ''}|${r[3] || ''}`;  // C=법인명, D=카드사
      if (key && key !== '|' && !newKeys.has(key)) {
        removed.push({
          corpName: r[2], cardCompany: r[3], type: r[4],
          progress: r[10] || '', memo: r[11] || '',
        });
      }
    }
  } catch (e) { /* empty tab */ }

  return removed;
}

// ─── Main ───

async function main() {
  console.log('BigQuery 데이터 조회 중...');

  const [pendingRaw, gowidRaw, unapplied, stagingMap] = await Promise.all([
    fetchPending(),
    fetchGowidPending(),
    fetchUnapplied(),
    fetchStagingCorrections(),
  ]);

  // Staging 보정
  const { pending, gowid, moved, resolved } = applyStagingCorrections(pendingRaw, gowidRaw, stagingMap);

  console.log(`심사대기: ${pending.length}건, 미접수: ${gowid.length}건, 미반영: ${unapplied.length}건`);
  if (moved > 0) console.log(`[Staging 보정] 미접수→심사대기 ${moved}건`);
  if (resolved > 0) console.log(`[Staging 보정] 승인/부결 완료 ${resolved}건 제거`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 시트 미리보기:\n');
    console.log(`=== 심사대기 (${pending.length}건) ===`);
    pending.slice(0, 5).forEach(r => console.log(`  ${r.corp_name} [${r.card_company_name}] ${fmtAmt(r.current_limit_amount)}→${fmtAmt(r.requested_limit_amount)} ${r.days_elapsed}일`));
    if (pending.length > 5) console.log(`  ... +${pending.length - 5}건`);
    console.log(`\n=== 미접수 (${gowid.length}건) ===`);
    gowid.slice(0, 5).forEach(r => console.log(`  ${r.corp_name} [${r.card_company_name}] ${r.days_elapsed}일`));
    if (gowid.length > 5) console.log(`  ... +${gowid.length - 5}건`);
    console.log(`\n=== 미반영 (${unapplied.length}건) ===`);
    unapplied.forEach(r => console.log(`  ${r.corp_name} [${r.card_company_name}] ${r.days_elapsed}일`));
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  console.log('시트 동기화 중...');

  // 각 탭 처리
  for (const [tabName, rows] of [['심사대기', pending], ['미접수', gowid], ['미반영', unapplied]]) {
    const sheetId = await ensureTab(tabName);

    // 기존 수기 입력 보존
    const manualMap = await readExistingManual(tabName);

    // 사라진 건 → 완료 탭으로
    const removed = await detectRemoved(tabName, rows);
    await writeDoneTab(removed, tabName);
    if (removed.length > 0) console.log(`  ${tabName}: ${removed.length}건 → 완료 탭 이동`);

    // 데이터 쓰기
    await writeTab(tabName, sheetId, rows, manualMap, today);
    console.log(`  ${tabName}: ${rows.length}건 갱신 완료`);
  }

  // 기본 시트 정리
  try {
    const defaultId = await getSheetId('시트1') || await getSheetId('Sheet1');
    if (defaultId !== null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ deleteSheet: { sheetId: defaultId } }] },
      });
    }
  } catch (e) { /* 무시 */ }

  console.log(`\n동기화 완료! https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
}

main().catch(err => {
  console.error('오류:', err.message);
  if (err.message.includes('not found')) {
    console.error('\n서비스 계정에 시트 편집 권한이 없습니다.');
    console.error('스프레드시트 공유 → dev-to-prod-bq-access@gowid-prd.iam.gserviceaccount.com (편집자)');
  }
  process.exit(1);
});
