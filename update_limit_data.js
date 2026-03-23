#!/usr/bin/env node
/**
 * 한도상향/카드사추가 퍼널 대시보드 데이터 업데이트 스크립트
 * Usage: node update_limit_data.js
 *
 * BigQuery mart_limit_application.application_status에서 최신 데이터를 조회하여
 * limit_increase_dashboard.html의 데이터 상수를 업데이트합니다.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');
const path = require('path');
const https = require('https');

const HTML_FILE = path.join(__dirname, 'limit_increase_dashboard.html');
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';

// Slack 토큰
const SLACK_USER_TOKEN = (() => {
  try {
    const envPath = path.join(__dirname, 'pm/context/card/operations/crm-slack-bot/.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/SLACK_USER_TOKEN=(.+)/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
})();
// Slack: search.messages API로 전체 워크스페이스에서 회사명 검색

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });

// ─── Slack 소통 이력 ───
function slackGet(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
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

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

function fmtLabel(month) {
  const [y, m] = month.split('-');
  return `${y.slice(2)}년${m}월`;
}

// ─── 1. FUNNEL_DATA: 월별 코호트 퍼널 ───
async function fetchFunnelData() {
  console.log('  [1/4] FUNNEL_DATA 조회 중...');
  const rows = await query(`
    SELECT
      FORMAT_DATETIME('%Y-%m', initialized_at) AS cohort_month,
      application_type,
      COUNT(*) AS total,
      -- 퍼널 단계 (단조감소 보장: f1 >= f2 >= f3 >= f4)
      COUNT(*) AS f1_initialized,
      COUNT(application_submitted_at) AS f2_app_submitted,
      COUNT(CASE WHEN card_co_pending_at IS NOT NULL AND gowid_rejected_at IS NULL THEN 1 END) AS f3_card_co_pending,
      COUNT(CASE WHEN card_co_approved_at IS NOT NULL AND gowid_rejected_at IS NULL THEN 1 END) AS f4_card_co_approved,
      -- 이탈/부결
      COUNT(gowid_rejected_at) AS gowid_rejected,
      COUNT(CASE WHEN gowid_rejected_at IS NULL AND card_co_rejected_at IS NOT NULL THEN 1 END) AS card_co_rejected,
      COUNT(canceled_at) AS canceled,
      -- 진행중 (종결되지 않은 건)
      COUNT(CASE WHEN gowid_rejected_at IS NULL AND card_co_approved_at IS NULL
                  AND card_co_rejected_at IS NULL AND canceled_at IS NULL THEN 1 END) AS in_progress,
      -- 금액 (만원)
      ROUND(AVG(CASE WHEN gowid_rejected_at IS NULL THEN gowid_approved_limit_amount END) / 10000, 0) AS avg_approved_limit,
      ROUND(AVG(current_limit_amount) / 10000, 0) AS avg_current_limit,
      ROUND(AVG(requested_limit_amount) / 10000, 0) AS avg_requested_limit
    FROM \`gowid-prd.mart_limit_application.application_status\`
    WHERE application_type IN ('한도상향', '카드사 추가')
      AND initialized_at >= '2025-01-01'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  // 월별 합산 + 유형별 분리
  const monthMap = {};
  for (const r of rows) {
    const m = r.cohort_month;
    if (!monthMap[m]) {
      monthMap[m] = {
        month: m, label: fmtLabel(m),
        total: 0, f1: 0, f2: 0, f3: 0, f4: 0,
        gowid_rejected: 0, card_co_rejected: 0, canceled: 0, in_progress: 0,
        avg_approved_limit: 0, avg_current_limit: 0, avg_requested_limit: 0,
        // 유형별
        limit_up_total: 0, limit_up_f4: 0, limit_up_rejected: 0,
        card_add_total: 0, card_add_f4: 0, card_add_rejected: 0,
      };
    }
    const o = monthMap[m];
    const n = Number;
    o.total += n(r.total);
    o.f1 += n(r.f1_initialized);
    o.f2 += n(r.f2_app_submitted);
    o.f3 += n(r.f3_card_co_pending);
    o.f4 += n(r.f4_card_co_approved);
    o.gowid_rejected += n(r.gowid_rejected);
    o.card_co_rejected += n(r.card_co_rejected);
    o.canceled += n(r.canceled);
    o.in_progress += n(r.in_progress);

    if (r.application_type === '한도상향') {
      o.limit_up_total = n(r.total);
      o.limit_up_f4 = n(r.f4_card_co_approved);
      o.limit_up_rejected = n(r.gowid_rejected);
      o.avg_approved_limit = n(r.avg_approved_limit || 0);
      o.avg_current_limit = n(r.avg_current_limit || 0);
      o.avg_requested_limit = n(r.avg_requested_limit || 0);
    } else {
      o.card_add_total = n(r.total);
      o.card_add_f4 = n(r.f4_card_co_approved);
      o.card_add_rejected = n(r.gowid_rejected);
    }
  }

  return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
}

// ─── 2. SLA_DATA: 월별 평균 소요일 ───
async function fetchSLAData() {
  console.log('  [2/4] SLA_DATA 조회 중...');
  const rows = await query(`
    SELECT
      FORMAT_DATETIME('%Y-%m', initialized_at) AS month,
      COUNT(*) AS completed_cnt,
      ROUND(AVG(CASE WHEN limit_calculating_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(limit_calculating_at, initialized_at, HOUR), 0) / 24.0 END), 1) AS sla_limit_check,
      ROUND(AVG(CASE WHEN gowid_approved_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(gowid_approved_at, initialized_at, HOUR), 0) / 24.0 END), 1) AS sla_gowid_review,
      ROUND(AVG(CASE WHEN application_submitted_at IS NOT NULL AND gowid_approved_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(application_submitted_at, gowid_approved_at, HOUR), 0) / 24.0 END), 1) AS sla_app_submit,
      ROUND(AVG(CASE WHEN card_co_approved_at IS NOT NULL AND card_co_pending_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(card_co_approved_at, card_co_pending_at, HOUR), 0) / 24.0
        WHEN card_co_rejected_at IS NOT NULL AND card_co_pending_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(card_co_rejected_at, card_co_pending_at, HOUR), 0) / 24.0 END), 1) AS sla_card_co_review,
      ROUND(AVG(CASE WHEN gowid_approved_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(gowid_approved_at, initialized_at, HOUR), 0) / 24.0 END), 1) AS sla_gowid_total,
      ROUND(AVG(GREATEST(DATETIME_DIFF(COALESCE(card_co_approved_at, gowid_rejected_at, card_co_rejected_at, canceled_at), initialized_at, HOUR), 0) / 24.0), 1) AS sla_total,
      ROUND(AVG(days_elapsed), 1) AS avg_days_elapsed,
      -- SLA 초과 비율
      ROUND(SAFE_DIVIDE(COUNTIF(is_limit_check_duration_over), COUNT(*)) * 100, 1) AS pct_limit_check_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_net_gowid_review_duration_over), COUNT(*)) * 100, 1) AS pct_gowid_review_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_application_submit_duration_over), COUNT(*)) * 100, 1) AS pct_app_submit_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_card_co_review_duration_over), COUNT(*)) * 100, 1) AS pct_card_co_review_over
    FROM \`gowid-prd.mart_limit_application.application_status\`
    WHERE application_type IN ('한도상향', '카드사 추가')
      AND initialized_at >= '2025-01-01'
      -- 완료 건만 (미완료 건 제외하여 SLA 왜곡 방지)
      AND (card_co_approved_at IS NOT NULL
        OR gowid_rejected_at IS NOT NULL
        OR card_co_rejected_at IS NOT NULL
        OR canceled_at IS NOT NULL)
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map(r => ({
    month: r.month,
    label: fmtLabel(r.month),
    completed_cnt: Number(r.completed_cnt || 0),
    limit_check: Number(r.sla_limit_check || 0),
    gowid_review: Number(r.sla_gowid_review || 0),
    app_submit: Number(r.sla_app_submit || 0),
    card_co_review: Number(r.sla_card_co_review || 0),
    gowid_total: Number(r.sla_gowid_total || 0),
    total: Number(r.sla_total || 0),
    days_elapsed: Number(r.avg_days_elapsed || 0),
    pct_limit_over: Number(r.pct_limit_check_over || 0),
    pct_gowid_over: Number(r.pct_gowid_review_over || 0),
    pct_submit_over: Number(r.pct_app_submit_over || 0),
    pct_card_over: Number(r.pct_card_co_review_over || 0),
  }));
}

// ─── 공통 CTE: 특별심사 + 실부여한도 ───
const SHARED_CTES = `
    mla_ranked AS (
      SELECT mla.limitApplicationId, mla.resultReviewStatus AS special_result,
        ROW_NUMBER() OVER (PARTITION BY mla.limitApplicationId
          ORDER BY CAST(mla.datastream_metadata.source_timestamp AS INT64) DESC) AS rn
      FROM \`ods_stream_gowid.ManualLimitApplication\` mla
      WHERE mla.type = 'SPECIAL' AND (mla.isDeleted = 0 OR mla.isDeleted IS NULL)
    ),
    mla_special AS (SELECT * FROM mla_ranked WHERE rn = 1),
    max_granted_date AS (
      SELECT MAX(date_id) AS d FROM \`gowid-prd.dw_fact.card_granted_limit\`
    ),
    cur_limit AS (
      SELECT gl.corp_id, SUM(gl.granted_limit) AS cur_granted_limit
      FROM \`gowid-prd.dw_fact.card_granted_limit\` gl
      CROSS JOIN max_granted_date mgd
      WHERE gl.date_id = mgd.d
      GROUP BY gl.corp_id
    )`;

// 5단계 카테고리: UR=내부심사, ES=전자서명필요, SB=전문발송대기, CP=카드사심사, PS=제출대기
const CATEGORY_CASE = `
      CASE
        WHEN a.card_co_approved_at IS NOT NULL OR a.gowid_rejected_at IS NOT NULL
          OR a.card_co_rejected_at IS NOT NULL OR a.canceled_at IS NOT NULL THEN NULL
        WHEN a.gowid_approved_at IS NULL THEN 'UR'
        WHEN a.gowid_status LIKE '%특별심사%'
          AND (ms.special_result IS NULL OR ms.special_result NOT IN ('APPROVED', 'PARTIAL_APPROVED'))
          AND a.card_co_pending_at IS NULL THEN 'UR'
        WHEN ms.special_result IN ('APPROVED', 'PARTIAL_APPROVED')
          AND a.card_co_pending_at IS NULL THEN 'ES'
        WHEN a.application_submitted_at IS NOT NULL AND a.card_co_pending_at IS NULL THEN 'SB'
        WHEN a.card_co_pending_at IS NOT NULL THEN 'CP'
        ELSE 'PS'
      END`;

const SHARED_JOINS = `
    LEFT JOIN mla_special ms ON SAFE_CAST(SPLIT(a.id, '-')[OFFSET(0)] AS INT64) = ms.limitApplicationId
    LEFT JOIN cur_limit cur ON CAST(a.corp_id AS STRING) = CAST(cur.corp_id AS STRING)`;

// ─── 3. DETAIL_DATA: 건별 상세 (전체 기간) ───
async function fetchDetailData() {
  console.log('  [3/5] DETAIL_DATA 조회 중...');
  const rows = await query(`
    WITH ${SHARED_CTES}
    SELECT
      a.id,
      a.corp_name,
      a.application_type AS type,
      a.card_company_name AS card_co,
      a.latest_status AS status,
      a.gowid_status,
      a.card_company_status AS card_co_status,
      ROUND(COALESCE(a.gowid_approved_limit_amount, 0) / 10000, 0) AS approved_limit,
      ROUND(COALESCE(a.current_limit_amount, 0) / 10000, 0) AS current_limit,
      ROUND(COALESCE(a.requested_limit_amount, 0) / 10000, 0) AS requested_limit,
      a.days_elapsed,
      FORMAT_DATETIME('%Y-%m-%d', a.initialized_at) AS init_date,
      FORMAT_DATETIME('%Y-%m-%d', a.gowid_approved_at) AS gowid_date,
      FORMAT_DATETIME('%Y-%m-%d', a.application_submitted_at) AS submit_date,
      FORMAT_DATETIME('%Y-%m-%d', a.card_co_approved_at) AS approved_date,
      FORMAT_DATETIME('%Y-%m-%d', a.gowid_rejected_at) AS rejected_date,
      FORMAT_DATETIME('%Y-%m-%d', a.card_co_rejected_at) AS card_rejected_date,
      CASE WHEN a.card_co_approved_at IS NOT NULL OR a.gowid_rejected_at IS NOT NULL OR a.card_co_rejected_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(COALESCE(a.card_co_approved_at, a.gowid_rejected_at, a.card_co_rejected_at), a.initialized_at, HOUR), 0) / 24.0, 1) END AS total_days,
      FORMAT_DATETIME('%Y-%m', a.initialized_at) AS month,
      IFNULL(c.assigned_am, '') AS assigned_am,
      ${CATEGORY_CASE} AS cat,
      IFNULL(ms.special_result, '') AS special_review,
      ROUND(COALESCE(cur.cur_granted_limit, 0) / 10000, 0) AS granted_limit
    FROM \`gowid-prd.mart_limit_application.application_status\` a
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON a.corp_id = c.corp_id
    ${SHARED_JOINS}
    WHERE a.application_type IN ('한도상향', '카드사 추가')
      AND a.initialized_at >= '2025-01-01'
    ORDER BY a.initialized_at DESC
  `);

  return rows.map(r => ({
    id: r.id,
    corp: r.corp_name,
    type: r.type,
    card_co: r.card_co,
    status: r.status,
    gowid_st: r.gowid_status,
    card_st: r.card_co_status,
    approved: Number(r.approved_limit || 0),
    current: Number(r.current_limit || 0),
    requested: Number(r.requested_limit || 0),
    elapsed: Number(r.days_elapsed || 0),
    init: r.init_date,
    gowid: r.gowid_date,
    submit: r.submit_date,
    done: r.approved_date,
    reject: r.rejected_date,
    card_reject: r.card_rejected_date,
    total: Number(r.total_days || 0),
    am: r.assigned_am || '',
    cat: r.cat || null,
    spr: r.special_review || '',
    gl: Number(r.granted_limit || 0),
    crm: '',
  }));
}

// ─── 4. CARD_CO_DATA: 카드사별 집계 ───
async function fetchCardCoData() {
  console.log('  [4/4] CARD_CO_DATA 조회 중...');
  const rows = await query(`
    SELECT
      card_company_name,
      application_type,
      COUNT(*) AS total,
      COUNT(card_co_approved_at) AS approved,
      COUNT(card_co_rejected_at) AS rejected,
      COUNT(gowid_rejected_at) AS gowid_rejected,
      ROUND(AVG(CASE WHEN card_co_approved_at IS NOT NULL AND card_co_pending_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(card_co_approved_at, card_co_pending_at, HOUR), 0) / 24.0
        WHEN card_co_rejected_at IS NOT NULL AND card_co_pending_at IS NOT NULL THEN GREATEST(DATETIME_DIFF(card_co_rejected_at, card_co_pending_at, HOUR), 0) / 24.0 END), 1) AS avg_card_review,
      ROUND(AVG(CASE WHEN card_co_approved_at IS NOT NULL OR gowid_rejected_at IS NOT NULL OR card_co_rejected_at IS NOT NULL OR canceled_at IS NOT NULL
        THEN GREATEST(DATETIME_DIFF(COALESCE(card_co_approved_at, gowid_rejected_at, card_co_rejected_at, canceled_at), initialized_at, HOUR), 0) / 24.0 END), 1) AS avg_total
    FROM \`gowid-prd.mart_limit_application.application_status\`
    WHERE application_type IN ('한도상향', '카드사 추가')
      AND initialized_at >= '2025-01-01'
    GROUP BY 1, 2
    ORDER BY total DESC
  `);

  return rows.map(r => ({
    name: r.card_company_name,
    type: r.application_type,
    total: Number(r.total),
    approved: Number(r.approved),
    rejected: Number(r.rejected),
    gowid_rejected: Number(r.gowid_rejected),
    avg_card_review: Number(r.avg_card_review || 0),
    avg_total: Number(r.avg_total || 0),
  }));
}

// ─── 5. RECORD_DATA: 전체 건별 레코드 (퍼널 팝업 + AM 필터용) ───
async function fetchRecordData() {
  console.log('  [5/5] RECORD_DATA 조회 중...');
  const rows = await query(`
    WITH ${SHARED_CTES}
    SELECT
      FORMAT_DATETIME('%Y-%m-%d', a.initialized_at) AS date,
      a.corp_name,
      a.application_type AS type,
      a.card_company_name AS card_co,
      IFNULL(c.assigned_am, '') AS am,
      a.gowid_status AS gs,
      CASE WHEN a.gowid_approved_at IS NOT NULL AND a.gowid_rejected_at IS NULL THEN 1 ELSE 0 END AS ga,
      CASE WHEN a.application_submitted_at IS NOT NULL THEN 1 ELSE 0 END AS f2,
      CASE WHEN a.card_co_pending_at IS NOT NULL AND a.gowid_rejected_at IS NULL THEN 1 ELSE 0 END AS f3,
      CASE WHEN a.card_co_approved_at IS NOT NULL AND a.gowid_rejected_at IS NULL THEN 1 ELSE 0 END AS f4,
      CASE WHEN a.gowid_rejected_at IS NOT NULL THEN 1 ELSE 0 END AS rj,
      CASE WHEN a.gowid_rejected_at IS NULL AND a.card_co_rejected_at IS NOT NULL THEN 1 ELSE 0 END AS cr,
      CASE WHEN a.canceled_at IS NOT NULL THEN 1 ELSE 0 END AS cn,
      CASE WHEN a.gowid_rejected_at IS NULL AND a.card_co_approved_at IS NULL
                AND a.card_co_rejected_at IS NULL AND a.canceled_at IS NULL THEN 1 ELSE 0 END AS ip,
      ROUND(COALESCE(CASE WHEN a.gowid_rejected_at IS NULL THEN a.gowid_approved_limit_amount END, 0) / 10000, 0) AS al,
      ROUND(COALESCE(a.current_limit_amount, 0) / 10000, 0) AS cl,
      ROUND(COALESCE(a.requested_limit_amount, 0) / 10000, 0) AS rl,
      CASE WHEN a.card_co_approved_at IS NOT NULL OR a.gowid_rejected_at IS NOT NULL OR a.card_co_rejected_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(COALESCE(a.card_co_approved_at, a.gowid_rejected_at, a.card_co_rejected_at), a.initialized_at, HOUR), 0) / 24.0, 1) END AS td,
      CASE WHEN a.card_co_approved_at IS NOT NULL AND a.card_co_pending_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(a.card_co_approved_at, a.card_co_pending_at, HOUR), 0) / 24.0, 1)
        WHEN a.card_co_rejected_at IS NOT NULL AND a.card_co_pending_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(a.card_co_rejected_at, a.card_co_pending_at, HOUR), 0) / 24.0, 1)
        END AS cd,
      CASE WHEN a.gowid_approved_at IS NOT NULL AND a.initialized_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(a.gowid_approved_at, a.initialized_at, HOUR), 0) / 24.0, 1) END AS nd,
      CASE WHEN a.limit_calculating_at IS NOT NULL AND a.initialized_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(a.limit_calculating_at, a.initialized_at, HOUR), 0) / 24.0, 1) END AS ld,
      CASE WHEN a.application_submitted_at IS NOT NULL AND a.gowid_approved_at IS NOT NULL
        THEN ROUND(GREATEST(DATETIME_DIFF(a.application_submitted_at, a.gowid_approved_at, HOUR), 0) / 24.0, 1) END AS sd,
      CASE WHEN a.card_co_approved_at IS NOT NULL OR a.gowid_rejected_at IS NOT NULL
                OR a.card_co_rejected_at IS NOT NULL OR a.canceled_at IS NOT NULL THEN 1 ELSE 0 END AS done,
      CASE WHEN a.is_limit_check_duration_over THEN 1 ELSE 0 END AS lo,
      CASE WHEN a.is_net_gowid_review_duration_over THEN 1 ELSE 0 END AS go,
      CASE WHEN a.is_application_submit_duration_over THEN 1 ELSE 0 END AS so,
      CASE WHEN a.is_card_co_review_duration_over THEN 1 ELSE 0 END AS co,
      ${CATEGORY_CASE} AS cat,
      IFNULL(ms.special_result, '') AS spr,
      ROUND(COALESCE(cur.cur_granted_limit, 0) / 10000, 0) AS granted_limit
    FROM \`gowid-prd.mart_limit_application.application_status\` a
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON a.corp_id = c.corp_id
    ${SHARED_JOINS}
    WHERE a.application_type IN ('한도상향', '카드사 추가')
      AND a.initialized_at >= '2025-01-01'
    ORDER BY a.initialized_at DESC
  `);

  return rows.map(r => ({
    d: r.date,
    c: r.corp_name,
    t: r.type === '한도상향' ? '상향' : '추가',
    cc: r.card_co || '',
    am: r.am,
    gs: r.gs === '고위드 특별심사' ? '특별' : '자동',
    ga: Number(r.ga), f2: Number(r.f2), f3: Number(r.f3), f4: Number(r.f4),
    rj: Number(r.rj), cr: Number(r.cr), cn: Number(r.cn), ip: Number(r.ip),
    al: Number(r.al), cl: Number(r.cl), rl: Number(r.rl),
    td: r.td != null ? Number(r.td) : null,
    cd: r.cd != null ? Number(r.cd) : null,
    nd: r.nd != null ? Number(r.nd) : null,
    ld: r.ld != null ? Number(r.ld) : null,
    sd: r.sd != null ? Number(r.sd) : null,
    done: Number(r.done),
    lo: Number(r.lo), go: Number(r.go), so: Number(r.so), co: Number(r.co),
    cat: r.cat || null,
    spr: r.spr || '',
    gl: Number(r.granted_limit || 0),
    crm: '',
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
  console.log('🔄 한도상향/카드사추가 퍼널 데이터 업데이트 시작\n');

  const [funnel, sla, detail, cardCo, records] = await Promise.all([
    fetchFunnelData(),
    fetchSLAData(),
    fetchDetailData(),
    fetchCardCoData(),
    fetchRecordData(),
  ]);

  console.log(`\n📊 조회 완료:`);
  console.log(`  FUNNEL_DATA: ${funnel.length}개월`);
  console.log(`  SLA_DATA: ${sla.length}개월`);
  console.log(`  DETAIL_DATA: ${detail.length}건 (전체 기간)`);
  console.log(`  CARD_CO_DATA: ${cardCo.length}개 카드사×유형`);
  console.log(`  RECORD_DATA: ${records.length}건`);

  // Slack 소통 이력 매칭 (진행중인 건만 — 완료/부결건 제외하여 API 호출 최소화)
  const activeCorpNames = [...new Set([
    ...detail.filter(r => !r.done && !r.reject && !r.card_reject).map(r => r.corp),
    ...records.filter(r => r.ip).map(r => r.c),
  ].filter(Boolean))];
  console.log(`  Slack 검색 대상: ${activeCorpNames.length}건 (진행중 법인)`);
  const slackComm = await fetchSlackComm(activeCorpNames);
  for (const r of detail) {
    r.crm = slackComm.get(r.corp) || '';
  }
  for (const r of records) {
    r.crm = slackComm.get(r.c) || '';
  }

  console.log('\n📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  html = replaceConst(html, 'FUNNEL_DATA', funnel);
  html = replaceConst(html, 'SLA_DATA', sla);
  html = replaceConst(html, 'DETAIL_DATA', detail);
  html = replaceConst(html, 'CARD_CO_DATA', cardCo);
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

  try {
    console.log('\n🚀 GitHub Pages 배포 중...');

    run('git add limit_increase_dashboard.html update_limit_data.js');

    try {
      run('git diff --cached --quiet');
      console.log('   변경 없음 — push 생략');
      return;
    } catch {
      // 변경 있음 — 계속 진행
    }

    run('git commit -m "auto: update limit_increase_dashboard data"');

    // pull --rebase 시도, 충돌 시 자동 해결
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
          if (
            f === 'limit_increase_dashboard.html' ||
            f === 'update_limit_data.js'
          ) {
            run('git checkout --ours "' + f + '"');
          } else {
            run('git checkout --theirs "' + f + '"');
          }
          run('git add "' + f + '"');
        }
        run('git rebase --continue', {
          env: { ...process.env, GIT_EDITOR: 'true' },
        });
        console.log('   ✅ 충돌 자동 해결');
      } catch {
        // 자동 해결 실패 → reset 후 재커밋
        console.log('   ⚠ 자동 해결 실패 — reset 후 재시도...');
        try {
          run('git rebase --abort');
        } catch {
          // abort도 실패하면 무시
        }
        const htmlPath = require('path').join(
          projectDir,
          'limit_increase_dashboard.html',
        );
        const jsPath = require('path').join(
          projectDir,
          'update_limit_data.js',
        );
        const htmlBackup = require('fs').readFileSync(htmlPath);
        const jsBackup = require('fs').readFileSync(jsPath);
        run('git reset --hard origin/main');
        require('fs').writeFileSync(htmlPath, htmlBackup);
        require('fs').writeFileSync(jsPath, jsBackup);
        run('git add limit_increase_dashboard.html update_limit_data.js');
        run('git commit -m "auto: update limit_increase_dashboard data"');
        console.log('   ✅ reset 후 재커밋 완료');
      }
    }

    run('git push origin main');
    console.log('✅ GitHub Pages 배포 완료!');
  } catch (err) {
    console.error('⚠ GitHub Pages 배포 실패:', err.message);
  }
}

// 네트워크 오류 시 재시도 (Mac 잠자기 후 네트워크 복구 대기)
const MAX_RETRIES = 3;
const RETRY_DELAY_SEC = 30;
const RETRYABLE = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i;

(async () => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await main();
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES && RETRYABLE.test(err.message)) {
        console.error(`\n⚠ 네트워크 오류 (${attempt}/${MAX_RETRIES}): ${err.message}`);
        console.error(`  ${RETRY_DELAY_SEC}초 후 재시도...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_SEC * 1000));
        continue;
      }
      console.error('\n❌ 오류 발생:', err.message);
      if (err.message.includes('Cannot find module')) {
        console.error('\n@google-cloud/bigquery 패키지를 설치하세요:');
        console.error('  cd ' + __dirname + ' && bun add @google-cloud/bigquery');
      }
      process.exit(1);
    }
  }
})();
