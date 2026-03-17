#!/usr/bin/env node
/**
 * 신규 입회 퍼널 대시보드 데이터 업데이트 스크립트
 * Usage: node update_card_funnel_data.js
 *
 * BigQuery에서 card_application / card_application_funnel 데이터를 조회하여
 * card_funnel_dashboard.html의 RECORD_DATA를 업데이트합니다.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');
const path = require('path');
const https = require('https');

const HTML_FILE = path.join(__dirname, 'card_funnel_dashboard.html');
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';

// Slack 토큰 (CRM 봇 .env에서 로드)
const SLACK_USER_TOKEN = (() => {
  try {
    const envPath = path.join(__dirname, 'pm/context/card/operations/crm-slack-bot/.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/SLACK_USER_TOKEN=(.+)/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

// Slack 봇 토큰 (채널 메시지 조회용)
const SLACK_BOT_TOKEN = (() => {
  try {
    const envPath = path.join(__dirname, 'pm/context/card/operations/crm-slack-bot/.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/SLACK_BOT_TOKEN=(.+)/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

// ─── Slack 소통 이력 (search.messages API) ───
function slackGet(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ─── Slack 채널 메시지 일괄 조회 (conversations.history) ───
async function fetchChannelMessages(channelId, oldest, token) {
  if (!token) return [];
  const messages = [];
  let cursor = '';
  const oldestTs = String(Math.floor(new Date(oldest).getTime() / 1000));

  do {
    const url = `https://slack.com/api/conversations.history?channel=${channelId}&limit=200&oldest=${oldestTs}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const resp = await slackGet(url, token);
    if (!resp.ok) {
      console.log(`  ⚠ Slack channel ${channelId}: ${resp.error}`);
      break;
    }
    messages.push(...(resp.messages || []));
    cursor = (resp.response_metadata && resp.response_metadata.next_cursor) || '';
    if (cursor) await new Promise(r => setTimeout(r, 300));
  } while (cursor);

  return messages;
}

// 한도산출 메시지 파싱 (C04MCEHMV0V)
function parseLimitMessages(messages) {
  const brnMap = new Map(); // brn → { fail, type, reason, amount, link }
  // messages are newest-first → keep first (latest) per BRN
  for (const msg of messages) {
    if (msg.subtype !== 'bot_message') continue;
    const text = msg.text || '';
    const brnMatch = text.match(/사업자번호\*?:\s*([\d-]+)/);
    if (!brnMatch) continue;
    const brn = brnMatch[1].replace(/-/g, '');
    if (brnMap.has(brn)) continue;

    const link = `https://gowid.slack.com/archives/C04MCEHMV0V/p${msg.ts.replace('.', '')}`;
    const typeMatch = text.match(/한도 산출 불가 유형\*?:\s*(.+?)[\n\r>]/);
    const reasonMatch = text.match(/한도 산출 불가 사유\*?:\s*(.+?)[\n\r>]/);

    if (typeMatch || reasonMatch) {
      brnMap.set(brn, {
        fail: true,
        type: (typeMatch ? typeMatch[1].trim() : ''),
        reason: (reasonMatch ? reasonMatch[1].trim() : ''),
        amount: '',
        link: link,
      });
    } else {
      const amountMatch = text.match(/최대 제공 가능 한도\*?:\s*(.+?)[\n\r>]/);
      brnMap.set(brn, {
        fail: false,
        type: '',
        reason: '',
        amount: (amountMatch ? amountMatch[1].trim() : ''),
        link: link,
      });
    }
  }
  return brnMap;
}

// 서류보완 메시지 파싱 (C057EMUTZQR)
function parseDocMessages(messages) {
  const brnMap = new Map();
  for (const msg of messages) {
    if (msg.subtype && msg.subtype !== 'bot_message') continue;
    const text = msg.text || '';
    const brnMatch = text.match(/사업자번호:\s*([\d-]+)/);
    if (!brnMatch) continue;
    const brn = brnMatch[1].replace(/-/g, '');
    if (brnMap.has(brn)) continue;
    const memoMatch = text.match(/서류보완메모:\s*(.+?)(?:\n|$)/);
    const cardCoMatch = text.match(/\[(\S+?)_입회서류/);
    const ts = msg.ts || '';
    const link = ts ? `https://gowid.slack.com/archives/C057EMUTZQR/p${ts.replace('.', '')}` : '';
    brnMap.set(brn, {
      memo: (memoMatch ? memoMatch[1].trim() : ''),
      link,
      cardCo: (cardCoMatch ? cardCoMatch[1] : ''),
    });
  }
  return brnMap;
}

// search.messages로 채널 내 메시지 검색 (봇 미가입 채널용, rate limit 재시도)
async function searchChannelMessages(channelId, token) {
  if (!token) return [];
  const messages = [];
  let page = 1;
  let retries = 0;
  do {
    const q = encodeURIComponent(`in:<#${channelId}> 서류보완메모`);
    const url = `https://slack.com/api/search.messages?query=${q}&count=100&sort=timestamp&sort_dir=desc&page=${page}`;
    const resp = await slackGet(url, token);
    if (!resp.ok) {
      if (resp.error === 'ratelimited' && retries < 3) {
        const wait = (resp.headers && resp.headers['retry-after']) ? Number(resp.headers['retry-after']) * 1000 : 5000;
        console.log(`  ⚠ Slack search rate limited — ${Math.ceil(wait/1000)}초 대기 후 재시도...`);
        await new Promise(r => setTimeout(r, wait));
        retries++;
        continue;
      }
      console.log(`  ⚠ Slack search in ${channelId}: ${resp.error}`);
      break;
    }
    retries = 0;
    const matches = (resp.messages && resp.messages.matches) || [];
    if (matches.length === 0) break;
    messages.push(...matches);
    const totalPages = (resp.messages && resp.messages.paging && resp.messages.paging.pages) || 1;
    if (page >= totalPages || page >= 20) break;
    page++;
    await new Promise(r => setTimeout(r, 2000));
  } while (true);
  return messages;
}

async function fetchSlackComm(companyNames) {
  if (!SLACK_USER_TOKEN) {
    console.log('  ⚠ Slack 토큰 없음 — 소통 이력 생략');
    return new Map();
  }
  console.log('  [Slack] search.messages로 회사별 소통 이력 조회 중...');

  const commMap = new Map();
  let searched = 0;

  for (const name of companyNames) {
    if (!name || name.length < 2) continue;
    const searchName = name.replace(/\(주\)|\(주 \)|주식회사 |주식회사|㈜/g, '').trim();
    if (searchName.length < 3) continue;

    try {
      const q = encodeURIComponent(`"${searchName}"`);
      const resp = await slackGet(
        `https://slack.com/api/search.messages?query=${q}&count=1&sort=timestamp&sort_dir=desc`,
        SLACK_USER_TOKEN
      );
      searched++;
      if (resp.ok && resp.messages && resp.messages.matches && resp.messages.matches.length > 0) {
        const m = resp.messages.matches[0];
        const date = new Date(Number(m.ts) * 1000);
        const dateStr = `${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
        let txt = (m.text || '').replace(/\n/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
        if (txt.length > 100) {
          const idx = txt.indexOf(searchName);
          if (idx >= 0) {
            const start = Math.max(0, idx - 20);
            txt = txt.substring(start, start + 100);
          } else {
            txt = txt.substring(0, 100);
          }
        }
        commMap.set(name, dateStr + ' ' + txt.trim());
      }
      if (searched % 20 === 0) {
        console.log(`  [Slack] ${searched}건 검색, ${commMap.size}건 매칭...`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (e) {
      // 에러 시 해당 회사 건너뜀
    }
  }

  console.log(`  [Slack] 총 ${searched}건 검색, ${commMap.size}건 매칭 완료`);
  return commMap;
}

// ─── RECORD_DATA: 건별 레코드 (퍼널 + SLA + AM) ───
async function fetchRecordData() {
  console.log('  [1/1] RECORD_DATA 조회 중...');
  const rows = await query(`
    WITH corp_ods AS (
      SELECT c.idx AS corp_idx,
        REPLACE(c.resCompanyIdentityNo, '-', '') AS brn_key,
        c.createdAt AS corp_created_at
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c
      WHERE c.resCompanyIdentityNo IS NOT NULL
    ),
    latest_app AS (
      SELECT
        REPLACE(ca.businessRegistrationNumber, '-', '') AS brn_key,
        ca.reviewStatus,
        ca.createdAt AS application_created_at,
        ca.updatedAt AS application_updated_at
      FROM \`gowid-prd.ods_stream_gowid.CardApplication\` ca
      WHERE ca.businessRegistrationNumber IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY REPLACE(ca.businessRegistrationNumber, '-', '')
        ORDER BY ca.createdAt DESC
      ) = 1
    ),
    cohort AS (
      SELECT brn_key,
        DATE(application_created_at) AS cohort_date,
        application_created_at AS latest_application_created_at,
        (reviewStatus = 'SUITABLE') AS is_approved,
        CASE WHEN reviewStatus = 'SUITABLE' THEN application_updated_at END AS latest_approved_at
      FROM latest_app
      WHERE DATE(application_created_at) >= DATE '2025-01-01'
    ),
    corp_map_after_app AS (
      SELECT c.brn_key,
        MIN(IF(o.corp_created_at >= c.latest_application_created_at, o.corp_created_at, NULL)) AS signup_at
      FROM cohort c LEFT JOIN corp_ods o ON c.brn_key = o.brn_key
      GROUP BY c.brn_key
    ),
    limit_flow_after_app AS (
      SELECT c.brn_key,
        MIN(IF(la.applicationType='JOIN' AND la.isNewCorp=1 AND la.status='INIT'
          AND la.updatedAt >= c.latest_application_created_at, la.updatedAt, NULL)) AS limit_start,
        MIN(IF(la.applicationType='JOIN' AND la.isNewCorp=1 AND la.status<>'INIT'
          AND la.updatedAt >= c.latest_application_created_at, la.updatedAt, NULL)) AS limit_progress
      FROM cohort c LEFT JOIN corp_ods o ON c.brn_key = o.brn_key
      LEFT JOIN \`gowid-prd.ods_stream_gowid.LimitApplication\` la ON la.idxCorp = o.corp_idx
      GROUP BY c.brn_key
    ),
    first_limit_result AS (
      SELECT c.brn_key,
        ARRAY_AGG(
          STRUCT(la.updatedAt AS lr_at, la.totalLimitAmount AS lr_amount)
          ORDER BY la.updatedAt ASC LIMIT 1
        )[OFFSET(0)].*
      FROM cohort c LEFT JOIN corp_ods o ON c.brn_key = o.brn_key
      LEFT JOIN \`gowid-prd.ods_stream_gowid.LimitApplication\` la ON la.idxCorp = o.corp_idx
      WHERE la.applicationType = 'JOIN' AND la.isNewCorp = 1
        AND la.totalLimitAmount IS NOT NULL
        AND la.updatedAt >= c.latest_application_created_at
      GROUP BY c.brn_key
    ),
    card_info_after_app AS (
      SELECT c.brn_key,
        MIN(IF(ci.createdAt >= c.latest_application_created_at, ci.createdAt, NULL)) AS ci_created,
        MIN(IF(ci.appliedAt >= c.latest_application_created_at, ci.appliedAt, NULL)) AS ci_applied,
        MIN(IF(ci.issuedAt >= c.latest_application_created_at, ci.issuedAt, NULL)) AS ci_issued,
        ARRAY_AGG(
          IF(ci.createdAt >= c.latest_application_created_at AND ci.cardCompany IS NOT NULL, ci.cardCompany, NULL)
          IGNORE NULLS ORDER BY ci.createdAt ASC LIMIT 1
        )[SAFE_OFFSET(0)] AS card_co
      FROM cohort c LEFT JOIN corp_ods o ON c.brn_key = o.brn_key
      LEFT JOIN \`gowid-prd.ods_stream_gowid.CardIssuanceInfo\` ci ON ci.idxCorp = o.corp_idx
      GROUP BY c.brn_key
    ),
    corp_dim_after_app AS (
      SELECT c.brn_key,
        MIN(IF(d.first_card_spend_at >= c.latest_application_created_at, d.first_card_spend_at, NULL)) AS first_spend
      FROM cohort c LEFT JOIN \`gowid-prd.dw_dimension.corporation\` d ON CAST(d.corp_id AS STRING) = c.brn_key
      GROUP BY c.brn_key
    ),
    -- AM 매핑: brn_key → corp_id → assigned_am
    am_map AS (
      SELECT CAST(d.corp_id AS STRING) AS brn_key, d.assigned_am
      FROM \`gowid-prd.dw_dimension.corporation\` d
      WHERE d.assigned_am IS NOT NULL AND d.assigned_am != ''
    ),
    -- 법인명 매핑
    corp_name_map AS (
      SELECT REPLACE(c.resCompanyIdentityNo, '-', '') AS brn_key,
        ARRAY_AGG(c.resCompanyNm ORDER BY c.createdAt DESC LIMIT 1)[OFFSET(0)] AS corp_name
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c
      WHERE c.resCompanyIdentityNo IS NOT NULL
      GROUP BY 1
    ),
    -- 법인명 매핑: CardApplication에서 가져오기 (Corp에 없는 경우 폴백)
    app_name_map AS (
      SELECT REPLACE(ca.businessRegistrationNumber, '-', '') AS brn_key,
        ARRAY_AGG(ca.corporationName ORDER BY ca.createdAt DESC LIMIT 1)[OFFSET(0)] AS app_corp_name
      FROM \`gowid-prd.ods_stream_gowid.CardApplication\` ca
      WHERE ca.businessRegistrationNumber IS NOT NULL
        AND ca.corporationName IS NOT NULL AND ca.corporationName != ''
      GROUP BY 1
    ),
    -- 보증금 신청/확인 (DepositApplication)
    deposit_check AS (
      SELECT o.brn_key,
        1 AS deposit_applied,
        MAX(CASE WHEN da.depositConfirmed = 1 THEN 1 ELSE 0 END) AS deposit_confirmed
      FROM \`gowid-prd.ods_stream_gowid.DepositApplication\` da
      JOIN corp_ods o ON da.idxCorp = o.corp_idx
      GROUP BY o.brn_key
    ),
    -- 특별심사 신청/승인 (ManualLimitApplication CDC dedup)
    special_check AS (
      SELECT o.brn_key,
        1 AS special_requested,
        MAX(CASE WHEN mla.resultReviewStatus IN ('APPROVED', 'PARTIAL_APPROVED') THEN 1 ELSE 0 END) AS special_approved
      FROM (
        SELECT id, limitApplicationId, resultReviewStatus
        FROM \`gowid-prd.ods_stream_gowid.ManualLimitApplication\`
        WHERE type = 'SPECIAL'
        QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updatedAt DESC) = 1
      ) mla
      JOIN \`gowid-prd.ods_stream_gowid.LimitApplication\` la ON la.id = mla.limitApplicationId
      JOIN corp_ods o ON la.idxCorp = o.corp_idx
      GROUP BY o.brn_key
    ),
    base AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', c.cohort_date) AS submit_date,
        c.brn_key,
        COALESCE(cn.corp_name, acn.app_corp_name, c.brn_key) AS corp_name,
        IFNULL(am.assigned_am, '') AS am,
        -- 퍼널 플래그
        1 AS sub,
        CASE WHEN c.is_approved THEN 1 ELSE 0 END AS apr,
        CASE WHEN m.signup_at IS NOT NULL THEN 1 ELSE 0 END AS sig,
        CASE WHEN lf.limit_start IS NOT NULL THEN 1 ELSE 0 END AS ls,
        CASE WHEN lf.limit_progress IS NOT NULL THEN 1 ELSE 0 END AS lp,
        CASE WHEN lr.lr_at IS NOT NULL THEN 1 ELSE 0 END AS lr,
        CASE WHEN lr.lr_amount IS NOT NULL AND lr.lr_amount <> 0 THEN 1 ELSE 0 END AS lnz,
        CASE WHEN lr.lr_amount IS NOT NULL AND lr.lr_amount = 0 THEN 1 ELSE 0 END AS lz,
        CASE WHEN ci.ci_created IS NOT NULL THEN 1 ELSE 0 END AS ci,
        CASE WHEN ci.ci_applied IS NOT NULL THEN 1 ELSE 0 END AS ca,
        CASE WHEN ci.ci_issued IS NOT NULL THEN 1 ELSE 0 END AS cd,
        CASE WHEN cd.first_spend IS NOT NULL THEN 1 ELSE 0 END AS fs,
        -- 한도 금액 (원시값)
        lr.lr_amount AS limit_amount,
        -- 발급일
        FORMAT_DATE('%Y-%m-%d', DATE(ci.ci_issued)) AS issued_date,
        -- 카드사
        CASE ci.card_co
          WHEN 'SHINHAN' THEN '신한카드'
          WHEN 'BC' THEN '비씨카드'
          WHEN 'LOTTE' THEN '롯데카드'
          ELSE ci.card_co
        END AS card_company,
        -- SLA (HOUR 단위 → 소수점 일수)
        CASE WHEN c.latest_approved_at IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(c.latest_approved_at, c.latest_application_created_at, HOUR), 0) / 24.0, 1) END AS d1,
        CASE WHEN m.signup_at IS NOT NULL AND c.latest_approved_at IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(m.signup_at, c.latest_approved_at, HOUR), 0) / 24.0, 1) END AS d2,
        CASE WHEN lr.lr_at IS NOT NULL AND m.signup_at IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(lr.lr_at, m.signup_at, HOUR), 0) / 24.0, 1) END AS d3,
        CASE WHEN ci.ci_issued IS NOT NULL AND lr.lr_at IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(ci.ci_issued, lr.lr_at, HOUR), 0) / 24.0, 1) END AS d4,
        CASE WHEN ci.ci_issued IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(ci.ci_issued, c.latest_application_created_at, HOUR), 0) / 24.0, 1) END AS dt,
        CASE WHEN cd.first_spend IS NOT NULL AND ci.ci_issued IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(cd.first_spend, ci.ci_issued, HOUR), 0) / 24.0, 1) END AS d5,
        CASE WHEN ci.ci_applied IS NOT NULL AND lr.lr_at IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(ci.ci_applied, lr.lr_at, HOUR), 0) / 24.0, 1) END AS s3,
        CASE WHEN ci.ci_issued IS NOT NULL AND ci.ci_applied IS NOT NULL
          THEN ROUND(GREATEST(DATETIME_DIFF(ci.ci_issued, ci.ci_applied, HOUR), 0) / 24.0, 1) END AS s4,
        -- 보증금/특별심사 (실제 ODS 테이블 기반)
        IFNULL(dep.deposit_applied, 0) AS deposit_applied,
        IFNULL(dep.deposit_confirmed, 0) AS deposit_confirmed,
        IFNULL(spc.special_requested, 0) AS special_requested,
        IFNULL(spc.special_approved, 0) AS special_approved
      FROM cohort c
      LEFT JOIN corp_map_after_app m USING (brn_key)
      LEFT JOIN limit_flow_after_app lf USING (brn_key)
      LEFT JOIN first_limit_result lr USING (brn_key)
      LEFT JOIN card_info_after_app ci USING (brn_key)
      LEFT JOIN corp_dim_after_app cd USING (brn_key)
      LEFT JOIN am_map am USING (brn_key)
      LEFT JOIN corp_name_map cn USING (brn_key)
      LEFT JOIN app_name_map acn USING (brn_key)
      LEFT JOIN deposit_check dep USING (brn_key)
      LEFT JOIN special_check spc USING (brn_key)
    ),
    -- CardApplication 없이 카드 발급된 법인 (다른 온보딩 경로)
    -- Metabase #4299 로직: Corp.createdAt(회원가입일) 기준 코호트, CardApplication 없는 법인만
    extra_issued AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', DATE(c.createdAt)) AS submit_date,
        REPLACE(c.resCompanyIdentityNo, '-', '') AS brn_key,
        COALESCE(c.resCompanyNm, REPLACE(c.resCompanyIdentityNo, '-', '')) AS corp_name,
        IFNULL(dim.assigned_am, '') AS am,
        0 AS sub, 0 AS apr,
        1 AS sig,
        CASE WHEN la_check.has_limit IS NOT NULL THEN 1 ELSE 0 END AS ls,
        CASE WHEN la_check.has_progress IS NOT NULL THEN 1 ELSE 0 END AS lp,
        CASE WHEN la_check.has_result IS NOT NULL THEN 1 ELSE 0 END AS lr,
        CASE WHEN la_check.limit_amount IS NOT NULL AND la_check.limit_amount <> 0 THEN 1 ELSE 0 END AS lnz,
        CASE WHEN la_check.limit_amount IS NOT NULL AND la_check.limit_amount = 0 THEN 1 ELSE 0 END AS lz,
        CASE WHEN ci_agg.ci_created IS NOT NULL THEN 1 ELSE 0 END AS ci,
        CASE WHEN ci_agg.ci_applied IS NOT NULL THEN 1 ELSE 0 END AS ca,
        CASE WHEN ci_agg.ci_issued IS NOT NULL THEN 1 ELSE 0 END AS cd,
        CASE WHEN dim.first_card_spend_at IS NOT NULL THEN 1 ELSE 0 END AS fs,
        la_check.limit_amount AS limit_amount,
        FORMAT_DATE('%Y-%m-%d', DATE(ci_agg.ci_issued)) AS issued_date,
        CASE ci_agg.card_co
          WHEN 'SHINHAN' THEN '신한카드'
          WHEN 'BC' THEN '비씨카드'
          WHEN 'LOTTE' THEN '롯데카드'
          ELSE ci_agg.card_co
        END AS card_company,
        CAST(NULL AS INT64) AS d1, CAST(NULL AS INT64) AS d2,
        CAST(NULL AS INT64) AS d3, CAST(NULL AS INT64) AS d4,
        CAST(NULL AS INT64) AS dt, CAST(NULL AS INT64) AS d5,
        CAST(NULL AS INT64) AS s3, CAST(NULL AS INT64) AS s4,
        -- 보증금/특별심사 (실제 ODS 테이블 기반)
        IFNULL(dep2.deposit_applied, 0) AS deposit_applied,
        IFNULL(dep2.deposit_confirmed, 0) AS deposit_confirmed,
        IFNULL(spc2.special_requested, 0) AS special_requested,
        IFNULL(spc2.special_approved, 0) AS special_approved,
        1 AS no_app
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` dim ON dim.corp_id = c.idx
      LEFT JOIN deposit_check dep2 ON dep2.brn_key = REPLACE(c.resCompanyIdentityNo, '-', '')
      LEFT JOIN special_check spc2 ON spc2.brn_key = REPLACE(c.resCompanyIdentityNo, '-', '')
      -- 카드 발급 정보 집계
      LEFT JOIN (
        SELECT ci.idxCorp,
          MIN(ci.createdAt) AS ci_created,
          MIN(ci.appliedAt) AS ci_applied,
          MIN(ci.issuedAt) AS ci_issued,
          ARRAY_AGG(ci.cardCompany IGNORE NULLS ORDER BY ci.issuedAt ASC LIMIT 1)[SAFE_OFFSET(0)] AS card_co
        FROM \`gowid-prd.ods_stream_gowid.CardIssuanceInfo\` ci
        WHERE ci.issuedAt IS NOT NULL
        GROUP BY ci.idxCorp
      ) ci_agg ON ci_agg.idxCorp = c.idx
      -- 한도심사 정보
      LEFT JOIN (
        SELECT la.idxCorp,
          MIN(IF(la.status='INIT', la.updatedAt, NULL)) AS has_limit,
          MIN(IF(la.status<>'INIT', la.updatedAt, NULL)) AS has_progress,
          MIN(IF(la.totalLimitAmount IS NOT NULL, la.updatedAt, NULL)) AS has_result,
          MIN(la.totalLimitAmount) AS limit_amount
        FROM \`gowid-prd.ods_stream_gowid.LimitApplication\` la
        WHERE la.applicationType = 'JOIN' AND la.isNewCorp = 1
        GROUP BY la.idxCorp
      ) la_check ON la_check.idxCorp = c.idx
      WHERE c.resCompanyIdentityNo IS NOT NULL
        AND DATE(c.createdAt) >= DATE '2026-01-01'
        AND REPLACE(c.resCompanyIdentityNo, '-', '') NOT IN (
          SELECT brn_key FROM cohort
        )
        AND ci_agg.ci_issued IS NOT NULL
    )
    SELECT *, 0 AS no_app FROM base
    UNION ALL
    SELECT * FROM extra_issued
    ORDER BY submit_date DESC
  `);

  return rows.map(r => ({
    d: r.submit_date,
    b: r.brn_key || '',
    c: r.corp_name,
    am: r.am || '',
    sub: Number(r.sub), apr: Number(r.apr), sig: Number(r.sig),
    ls: Number(r.ls), lp: Number(r.lp), lr: Number(r.lr),
    lnz: Number(r.lnz), lz: Number(r.lz),
    ci: Number(r.ci), ca: Number(r.ca), cd: Number(r.cd), fs: Number(r.fs),
    la: r.limit_amount != null ? Number(r.limit_amount) : null,
    d1: r.d1 != null ? Number(r.d1) : null,
    d2: r.d2 != null ? Number(r.d2) : null,
    d3: r.d3 != null ? Number(r.d3) : null,
    d4: r.d4 != null ? Number(r.d4) : null,
    dt: r.dt != null ? Number(r.dt) : null,
    d5: r.d5 != null ? Number(r.d5) : null,
    s3: r.s3 != null ? Number(r.s3) : null,
    s4: r.s4 != null ? Number(r.s4) : null,
    id: r.issued_date || null,
    cc: r.card_company || '',
    na: Number(r.no_app || 0),
    da: Number(r.deposit_applied || 0),
    dc: Number(r.deposit_confirmed || 0),
    sr: Number(r.special_requested || 0),
    sa: Number(r.special_approved || 0),
    crm: '',
    lrf: 0, lrt: '', lrr: '', lrl: '',
    doc: '', dl: '',
  }));
}

// ─── 유틸리티 ───
function replaceConst(html, name, data) {
  const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`);
  const replacement = `const ${name} = ${JSON.stringify(data)};`;
  if (!re.test(html)) {
    console.error(`  ⚠ ${name} 패턴을 찾을 수 없습니다.`);
    return html;
  }
  return html.replace(re, replacement);
}

function updateTimestamp(html) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const isoFull = now.toISOString();
  html = html.replace(/업데이트: \d{4}-\d{2}-\d{2}/, `업데이트: ${today}`);
  const tsRe = /const DATA_UPDATED_AT = '[^']*';/;
  const tsNew = `const DATA_UPDATED_AT = '${isoFull}';`;
  if (tsRe.test(html)) html = html.replace(tsRe, tsNew);
  return html;
}

// ─── main ───
async function main() {
  console.log('🔄 신규 입회 퍼널 데이터 업데이트 시작\n');

  const records = await fetchRecordData();

  console.log(`\n📊 조회 완료:`);
  console.log(`  RECORD_DATA: ${records.length}건`);

  // ─── Slack 채널 데이터 수집 (한도산출 + 서류보완) ───
  console.log('\n📨 Slack 채널 데이터 수집 중...');
  // 한도산출: Bot Token으로 conversations.history
  const limitMsgs = await fetchChannelMessages('C04MCEHMV0V', '2025-01-01', SLACK_BOT_TOKEN);
  console.log(`  한도산출 메시지: ${limitMsgs.length}건`);
  // 서류보완: Bot Token으로 conversations.history (봇 채널 가입 완료)
  const docMsgs = await fetchChannelMessages('C057EMUTZQR', '2025-01-01', SLACK_BOT_TOKEN);
  console.log(`  서류보완 메시지: ${docMsgs.length}건`);

  const limitMap = parseLimitMessages(limitMsgs);
  const docMap = parseDocMessages(docMsgs);

  let limitMatched = 0, docMatched = 0;
  for (const r of records) {
    if (!r.b) continue;
    const lm = limitMap.get(r.b);
    if (lm) {
      limitMatched++;
      r.lrf = lm.fail ? 1 : 0;
      r.lrt = lm.type;
      r.lrr = lm.reason;
      r.lrl = lm.link;
      // 유효한도 금액 (Slack에서 가져온 "최대 제공 가능 한도" 텍스트)
      if (!lm.fail && lm.amount) r.las = lm.amount;
    }
    const dm = docMap.get(r.b);
    if (dm) {
      docMatched++;
      r.doc = dm.memo;
      r.dl = dm.link;
    }
  }
  console.log(`  한도산출 매칭: ${limitMatched}건 (산출불가: ${records.filter(r => r.lrf).length}건)`);
  console.log(`  서류보완 매칭: ${docMatched}건`);

  // Slack 소통 이력 매칭 (최근 90일 내 미완료 건만)
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const activeNames = [...new Set(records.filter(r => !r.fs && r.d >= cutoffStr).map(r => r.c).filter(Boolean))];
  console.log(`  Slack 검색 대상: ${activeNames.length}건 (최근 90일 미완료 법인)`);
  const slackComm = await fetchSlackComm(activeNames);
  for (const r of records) {
    r.crm = slackComm.get(r.c) || '';
  }
  console.log(`  Slack 소통 매칭: ${records.filter(r => r.crm).length}건`);

  console.log('\n📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  html = replaceConst(html, 'RECORD_DATA', records);
  html = updateTimestamp(html);

  fs.writeFileSync(HTML_FILE, html);
  console.log(`\n✅ 업데이트 완료! (${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`   파일: ${HTML_FILE}`);
  console.log(`   시간: ${new Date().toLocaleString('ko-KR')}`);

  // gh-pages 배포 (SKIP_DEPLOY=1이면 건너뜀 — GitHub Actions에서 일괄 커밋)
  if (process.env.SKIP_DEPLOY !== '1') {
    await deployToGhPages();
  } else {
    console.log('\n⏭ SKIP_DEPLOY=1 — 배포 생략 (GitHub Actions에서 일괄 처리)');
  }
}

async function deployToGhPages() {
  const { execSync } = require('child_process');
  const projectDir = __dirname;
  const run = (cmd, opts) =>
    execSync(cmd, { cwd: projectDir, stdio: 'pipe', timeout: 30000, ...opts });

  // Save backups BEFORE any git operations
  const htmlPath = path.join(projectDir, 'card_funnel_dashboard.html');
  const jsPath = path.join(projectDir, 'update_card_funnel_data.js');
  const htmlBackup = fs.readFileSync(htmlPath);
  const jsBackup = fs.readFileSync(jsPath);

  try {
    console.log('\n🚀 GitHub Pages 배포 중...');

    run('git add card_funnel_dashboard.html update_card_funnel_data.js');

    try {
      run('git diff --cached --quiet');
      console.log('   변경 없음 — push 생략');
      return;
    } catch {
      // 변경 있음 — 계속 진행
    }

    run('git commit -m "auto: update card_funnel_dashboard data"');

    try {
      run('git pull --rebase origin main');
    } catch {
      console.log('   ⚠ rebase 충돌 — 자동 해결 시도...');
      try {
        const status = run('git status --porcelain').toString();
        const conflicted = status
          .split('\n')
          .filter((l) => l.startsWith('UU ') || l.startsWith('AA '))
          .map((l) => l.slice(3).trim());
        for (const f of conflicted) {
          if (f === 'card_funnel_dashboard.html' || f === 'update_card_funnel_data.js') {
            // During rebase, --theirs means our local commits (opposite of merge)
            run('git checkout --theirs "' + f + '"');
          } else {
            run('git checkout --ours "' + f + '"');
          }
          run('git add "' + f + '"');
        }
        run('git rebase --continue', { env: { ...process.env, GIT_EDITOR: 'true' } });
        console.log('   ✅ 충돌 자동 해결');
      } catch {
        console.log('   ⚠ 자동 해결 실패 — reset 후 재시도...');
        try { run('git rebase --abort'); } catch {}
        run('git reset --hard origin/main');
        // Use pre-saved backups (not filesystem which may have conflict markers)
        fs.writeFileSync(htmlPath, htmlBackup);
        fs.writeFileSync(jsPath, jsBackup);
        run('git add card_funnel_dashboard.html update_card_funnel_data.js');
        run('git commit -m "auto: update card_funnel_dashboard data"');
        console.log('   ✅ reset 후 재커밋 완료');
      }
    }

    // Final safety check: verify no conflict markers in HTML before push
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    if (htmlContent.includes('<<<<<<< ')) {
      console.log('   ⚠ HTML에 충돌 마커 발견 — 백업으로 복원...');
      fs.writeFileSync(htmlPath, htmlBackup);
      fs.writeFileSync(jsPath, jsBackup);
      run('git add card_funnel_dashboard.html update_card_funnel_data.js');
      run('git commit -m "auto: update card_funnel_dashboard data"');
    }

    run('git push origin main');
    console.log('✅ GitHub Pages 배포 완료!');
  } catch (err) {
    console.error('⚠ GitHub Pages 배포 실패:', err.message);
  }
}

main().catch(err => {
  console.error('\n❌ 오류 발생:', err.message);
  if (err.message.includes('Cannot find module')) {
    console.error('\n@google-cloud/bigquery 패키지를 설치하세요:');
    console.error('  cd ' + __dirname + ' && bun add @google-cloud/bigquery');
  }
  process.exit(1);
});
