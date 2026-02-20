#!/usr/bin/env node
/**
 * 대시보드 데이터 업데이트 스크립트
 * Usage: node update_data.js
 *
 * BigQuery에서 최신 데이터를 조회하여 card_issuance_dashboard.html의
 * 데이터 상수(FUNNEL_DATA, USAGE_DATA 등)를 업데이트합니다.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, 'card_issuance_dashboard.html');
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

function fmtLabel(month) {
  const [y, m] = month.split('-');
  return `${y.slice(2)}년 ${parseInt(m)}월`;
}

// ─── QUERIES ───

async function fetchFunnelData() {
  console.log('  [1/7] FUNNEL_DATA 조회 중...');
  const rows = await query(`
    SELECT
      FORMAT_DATE('%Y-%m', card_application_submitted_at) AS month,
      COUNT(*) AS submitted,
      COUNTIF(card_application_approved_at IS NOT NULL) AS approved,
      COUNTIF(signup_at IS NOT NULL) AS signup,
      COUNTIF(first_limit_start_init IS NOT NULL) AS limit_start,
      COUNTIF(first_limit_progress_after_init IS NOT NULL) AS limit_progress,
      COUNTIF(first_limit_result_at IS NOT NULL) AS limit_result_any,
      COUNTIF(first_limit_result_amount > 0) AS limit_nonzero,
      COUNTIF(first_limit_result_at IS NOT NULL AND first_limit_result_amount = 0) AS limit_zero,
      COUNTIF(first_card_info_created_at IS NOT NULL) AS card_info,
      COUNTIF(first_card_applied_at IS NOT NULL) AS card_applied,
      COUNTIF(first_card_issued_at IS NOT NULL) AS card_issued,
      COUNTIF(first_spend_at IS NOT NULL) AS first_spend
    FROM \`gowid-prd.mart_limit_application.card_application_funnel\`
    WHERE card_application_submitted_at >= '2025-01-01'
    GROUP BY 1 ORDER BY 1
  `);
  return rows.map(r => ({
    month: r.month,
    label: fmtLabel(r.month),
    submitted: Number(r.submitted),
    approved: Number(r.approved),
    signup: Number(r.signup),
    limit_start: Number(r.limit_start),
    limit_progress: Number(r.limit_progress),
    limit_result_any: Number(r.limit_result_any),
    limit_nonzero: Number(r.limit_nonzero),
    limit_zero: Number(r.limit_zero),
    card_info: Number(r.card_info),
    card_applied: Number(r.card_applied),
    card_issued: Number(r.card_issued),
    first_spend: Number(r.first_spend),
  }));
}

async function fetchUsageData() {
  console.log('  [2/7] USAGE_DATA 조회 중...');
  const rows = await query(`
    WITH base AS (
      SELECT
        FORMAT_DATE('%Y-%m', first_card_issued_at) AS cohort,
        corp_id,
        normal_granted_limit,
        m0_normal_amount,
        m1_normal_amount,
        m2_normal_amount,
        m3_normal_amount,
        ROUND(SAFE_MULTIPLY(m0_use_limit_rate, 100), 1) AS m0,
        ROUND(SAFE_MULTIPLY(m1_use_limit_rate, 100), 1) AS m1,
        ROUND(SAFE_MULTIPLY(m2_use_limit_rate, 100), 1) AS m2,
        ROUND(SAFE_MULTIPLY(m3_use_limit_rate, 100), 1) AS m3,
        CASE WHEN m0_normal_amount > 0 OR m1_normal_amount > 0 OR m2_normal_amount > 0 OR m3_normal_amount > 0 THEN 1 ELSE 0 END AS has_spend,
        CASE WHEN m1_use_limit_rate >= 0.2 THEN 1 ELSE 0 END AS m1_hit_flag,
        CASE WHEN m2_use_limit_rate >= 0.35 THEN 1 ELSE 0 END AS m2_hit_flag,
        CASE WHEN m3_use_limit_rate >= 0.45 THEN 1 ELSE 0 END AS m3_hit_flag,
        CASE WHEN m1_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m1_eligible,
        CASE WHEN m2_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m2_eligible,
        CASE WHEN m3_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m3_eligible
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\`
      WHERE first_card_issued_at >= '2025-01-01'
    )
    SELECT
      cohort,
      COUNT(*) AS total,
      SUM(has_spend) AS first_spend,
      ROUND(AVG(m0), 1) AS m0,
      ROUND(AVG(m1), 1) AS m1,
      ROUND(AVG(m2), 1) AS m2,
      ROUND(AVG(m3), 1) AS m3,
      CASE WHEN SUM(m1_eligible) > 0 THEN ROUND(SUM(m1_hit_flag) * 100.0 / SUM(m1_eligible), 1) ELSE NULL END AS m1_hit,
      CASE WHEN SUM(m2_eligible) > 0 THEN ROUND(SUM(m2_hit_flag) * 100.0 / SUM(m2_eligible), 1) ELSE NULL END AS m2_hit,
      CASE WHEN SUM(m3_eligible) > 0 THEN ROUND(SUM(m3_hit_flag) * 100.0 / SUM(m3_eligible), 1) ELSE NULL END AS m3_hit,
      SUM(m1_hit_flag) AS m1_cnt,
      SUM(m2_hit_flag) AS m2_cnt,
      SUM(m3_hit_flag) AS m3_cnt
    FROM base
    GROUP BY 1 ORDER BY 1
  `);
  return rows.map(r => ({
    cohort: r.cohort,
    label: fmtLabel(r.cohort),
    total: Number(r.total),
    first_spend: Number(r.first_spend),
    m0: r.m0 != null ? Number(r.m0) : null,
    m1: r.m1 != null ? Number(r.m1) : null,
    m2: r.m2 != null ? Number(r.m2) : null,
    m3: r.m3 != null ? Number(r.m3) : null,
    m1_hit: r.m1_hit != null ? Number(r.m1_hit) : null,
    m2_hit: r.m2_hit != null ? Number(r.m2_hit) : null,
    m3_hit: r.m3_hit != null ? Number(r.m3_hit) : null,
    m1_cnt: Number(r.m1_cnt || 0),
    m2_cnt: Number(r.m2_cnt || 0),
    m3_cnt: Number(r.m3_cnt || 0),
  }));
}

async function fetchIndustryData() {
  console.log('  [3/7] INDUSTRY_DATA 조회 중...');
  const rows = await query(`
    WITH base AS (
      SELECT
        c.business_items_summarized AS industry,
        ROUND(SAFE_MULTIPLY(u.m1_use_limit_rate, 100), 1) AS m1,
        CASE WHEN u.m1_use_limit_rate >= 0.2 THEN 1 ELSE 0 END AS m1_hit
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\` u
      JOIN \`gowid-prd.dw_dimension.corporation\` c ON u.corp_id = c.corp_id
      WHERE u.first_card_issued_at >= '2025-01-01'
        AND u.m1_use_limit_rate IS NOT NULL
        AND c.business_items_summarized IS NOT NULL
        AND c.business_items_summarized != ''
    )
    SELECT
      industry AS name,
      ROUND(AVG(m1), 1) AS m1,
      ROUND(SUM(m1_hit) * 100.0 / COUNT(*), 1) AS hit
    FROM base
    GROUP BY 1
    HAVING COUNT(*) >= 3
    ORDER BY m1 DESC
  `);
  return rows.map(r => ({
    name: r.name,
    m1: Number(r.m1),
    hit: Number(r.hit),
  }));
}

async function fetchTierData() {
  console.log('  [4/7] TIER_DATA 조회 중...');
  const rows = await query(`
    WITH base AS (
      SELECT
        CASE
          WHEN normal_granted_limit < 1000000 THEN '100만 미만'
          WHEN normal_granted_limit < 3000000 THEN '100만~300만'
          WHEN normal_granted_limit < 10000000 THEN '300만~1천만'
          WHEN normal_granted_limit < 50000000 THEN '1천만~5천만'
          WHEN normal_granted_limit < 100000000 THEN '5천만~1억'
          ELSE '1억 이상'
        END AS tier,
        CASE
          WHEN normal_granted_limit < 1000000 THEN 1
          WHEN normal_granted_limit < 3000000 THEN 2
          WHEN normal_granted_limit < 10000000 THEN 3
          WHEN normal_granted_limit < 50000000 THEN 4
          WHEN normal_granted_limit < 100000000 THEN 5
          ELSE 6
        END AS tier_order,
        ROUND(SAFE_MULTIPLY(m1_use_limit_rate, 100), 1) AS m1,
        CASE WHEN m1_use_limit_rate >= 0.2 THEN 1 ELSE 0 END AS m1_hit
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\`
      WHERE first_card_issued_at >= '2025-01-01'
        AND m1_use_limit_rate IS NOT NULL
    )
    SELECT
      tier,
      COUNT(*) AS cnt,
      ROUND(AVG(m1), 1) AS avg_m1,
      ROUND(SUM(m1_hit) * 100.0 / COUNT(*), 1) AS hit
    FROM base
    GROUP BY tier, tier_order
    ORDER BY tier_order
  `);
  return rows.map(r => ({
    tier: r.tier,
    cnt: Number(r.cnt),
    avg_m1: Number(r.avg_m1),
    hit: Number(r.hit),
  }));
}

async function fetchCompareData() {
  console.log('  [5/7] COMPARE_DATA 조회 중...');
  const metrics = [
    { key: 'fs', cond: `m0_normal_amount > 0 OR m1_normal_amount > 0 OR m2_normal_amount > 0 OR m3_normal_amount > 0`, label: '첫결제' },
    { key: 'm1', cond: `m1_use_limit_rate >= 0.2`, label: 'M1' },
    { key: 'm2', cond: `m2_use_limit_rate >= 0.35`, label: 'M2' },
    { key: 'm3', cond: `m3_use_limit_rate >= 0.45`, label: 'M3' },
  ];

  const sql = `
    WITH base AS (
      SELECT
        FORMAT_DATE('%Y-%m', u.first_card_issued_at) AS cohort,
        u.corp_id,
        u.normal_granted_limit,
        u.m0_normal_amount, u.m1_normal_amount, u.m2_normal_amount, u.m3_normal_amount,
        u.m0_use_limit_rate, u.m1_use_limit_rate, u.m2_use_limit_rate, u.m3_use_limit_rate,
        c.headcount,
        CASE WHEN c.is_connected_bank THEN 1 ELSE 0 END AS has_bank,
        CASE WHEN c.is_connected_hometax THEN 1 ELSE 0 END AS has_htax,
        0 AS has_inv
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\` u
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON u.corp_id = c.corp_id
      WHERE u.first_card_issued_at >= '2025-01-01'
    ),
    fs_data AS (
      SELECT cohort,
        CASE WHEN ${metrics[0].cond} THEN 'a' ELSE 'm' END AS grp,
        COUNT(*) AS cnt,
        ROUND(AVG(normal_granted_limit / 10000)) AS avg_limit,
        ROUND(AVG(headcount), 1) AS avg_hc,
        ROUND(AVG(has_bank) * 100, 1) AS bank_rate,
        ROUND(AVG(has_htax) * 100, 1) AS htax_rate,
        ROUND(AVG(has_inv) * 100, 1) AS inv_rate,
        NULL AS avg_util
      FROM base GROUP BY 1, 2
    ),
    m1_data AS (
      SELECT cohort,
        CASE WHEN ${metrics[1].cond} THEN 'a' ELSE 'm' END AS grp,
        COUNT(*) AS cnt,
        ROUND(AVG(normal_granted_limit / 10000)) AS avg_limit,
        ROUND(AVG(headcount), 1) AS avg_hc,
        ROUND(AVG(has_bank) * 100, 1) AS bank_rate,
        ROUND(AVG(has_htax) * 100, 1) AS htax_rate,
        ROUND(AVG(has_inv) * 100, 1) AS inv_rate,
        ROUND(AVG(SAFE_MULTIPLY(m1_use_limit_rate, 100)), 1) AS avg_util
      FROM base WHERE m1_use_limit_rate IS NOT NULL GROUP BY 1, 2
    ),
    m2_data AS (
      SELECT cohort,
        CASE WHEN ${metrics[2].cond} THEN 'a' ELSE 'm' END AS grp,
        COUNT(*) AS cnt,
        ROUND(AVG(normal_granted_limit / 10000)) AS avg_limit,
        ROUND(AVG(headcount), 1) AS avg_hc,
        ROUND(AVG(has_bank) * 100, 1) AS bank_rate,
        ROUND(AVG(has_htax) * 100, 1) AS htax_rate,
        ROUND(AVG(has_inv) * 100, 1) AS inv_rate,
        ROUND(AVG(SAFE_MULTIPLY(m2_use_limit_rate, 100)), 1) AS avg_util
      FROM base WHERE m2_use_limit_rate IS NOT NULL GROUP BY 1, 2
    ),
    m3_data AS (
      SELECT cohort,
        CASE WHEN ${metrics[3].cond} THEN 'a' ELSE 'm' END AS grp,
        COUNT(*) AS cnt,
        ROUND(AVG(normal_granted_limit / 10000)) AS avg_limit,
        ROUND(AVG(headcount), 1) AS avg_hc,
        ROUND(AVG(has_bank) * 100, 1) AS bank_rate,
        ROUND(AVG(has_htax) * 100, 1) AS htax_rate,
        ROUND(AVG(has_inv) * 100, 1) AS inv_rate,
        ROUND(AVG(SAFE_MULTIPLY(m3_use_limit_rate, 100)), 1) AS avg_util
      FROM base WHERE m3_use_limit_rate IS NOT NULL GROUP BY 1, 2
    )
    SELECT 'fs' AS metric, * FROM fs_data
    UNION ALL SELECT 'm1', * FROM m1_data
    UNION ALL SELECT 'm2', * FROM m2_data
    UNION ALL SELECT 'm3', * FROM m3_data
    ORDER BY cohort, metric, grp
  `;

  const rows = await query(sql);

  // Group into {cohort, fs:{a:{...},m:{...}}, m1:{...}, ...}
  const cohortMap = {};
  for (const r of rows) {
    if (!cohortMap[r.cohort]) cohortMap[r.cohort] = { cohort: r.cohort };
    const c = cohortMap[r.cohort];
    if (!c[r.metric]) c[r.metric] = {};
    c[r.metric][r.grp] = {
      cnt: Number(r.cnt),
      limit: Number(r.avg_limit || 0),
      hc: r.avg_hc != null ? Number(r.avg_hc) : null,
      bank: Number(r.bank_rate || 0),
      htax: Number(r.htax_rate || 0),
      inv: Number(r.inv_rate || 0),
      ...(r.avg_util != null ? { util: Number(r.avg_util) } : {}),
    };
  }

  return Object.values(cohortMap).sort((a, b) => a.cohort.localeCompare(b.cohort));
}

async function fetchCorpDetail() {
  console.log('  [6/7] CORP_DETAIL 조회 중...');
  const rows = await query(`
    SELECT
      FORMAT_DATE('%Y-%m', first_card_issued_at) AS cohort,
      corp_id AS id,
      corp_name AS name,
      CAST(normal_granted_limit AS INT64) AS lim,
      CASE WHEN m0_normal_amount > 0 OR m1_normal_amount > 0 OR m2_normal_amount > 0 OR m3_normal_amount > 0 THEN 'Y' ELSE 'N' END AS fs,
      CAST(first_card_issued_at AS STRING) AS issued,
      ROUND(SAFE_MULTIPLY(m0_use_limit_rate, 100), 1) AS m0,
      ROUND(SAFE_MULTIPLY(m1_use_limit_rate, 100), 1) AS m1,
      CASE WHEN m1_use_limit_rate >= 0.2 THEN 'Y' ELSE 'N' END AS m1h,
      ROUND(SAFE_MULTIPLY(m2_use_limit_rate, 100), 1) AS m2,
      CASE WHEN m2_use_limit_rate >= 0.35 THEN 'Y' ELSE 'N' END AS m2h,
      ROUND(SAFE_MULTIPLY(m3_use_limit_rate, 100), 1) AS m3,
      CASE WHEN m3_use_limit_rate >= 0.45 THEN 'Y' ELSE 'N' END AS m3h
    FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\`
    WHERE first_card_issued_at >= '2025-01-01'
    ORDER BY first_card_issued_at DESC, corp_id
  `);
  return rows.map(r => ({
    cohort: r.cohort, id: Number(r.id), name: r.name, limit: Number(r.lim),
    fs: r.fs, issued: r.issued,
    m0: r.m0 != null ? Number(r.m0) : 0,
    m1: r.m1 != null ? Number(r.m1) : 0, m1h: r.m1h,
    m2: r.m2 != null ? Number(r.m2) : 0, m2h: r.m2h,
    m3: r.m3 != null ? Number(r.m3) : 0, m3h: r.m3h,
  }));
}

async function fetchFunnelDetail() {
  console.log('  [7/7] FUNNEL_DETAIL 조회 중...');
  const rows = await query(`
    SELECT
      FORMAT_DATE('%Y-%m', card_application_submitted_at) AS m,
      corp_id AS id,
      corp_name AS n,
      CASE WHEN card_application_submitted_at IS NOT NULL THEN 1 ELSE 0 END AS sub,
      CASE WHEN card_application_approved_at IS NOT NULL THEN 1 ELSE 0 END AS apr,
      CASE WHEN signup_at IS NOT NULL THEN 1 ELSE 0 END AS sig,
      CASE WHEN first_limit_start_init IS NOT NULL THEN 1 ELSE 0 END AS ls,
      CASE WHEN first_limit_progress_after_init IS NOT NULL THEN 1 ELSE 0 END AS lp,
      CASE WHEN first_limit_result_at IS NOT NULL THEN 1 ELSE 0 END AS lr,
      CAST(COALESCE(first_limit_result_amount, 0) AS INT64) AS lim,
      CASE WHEN first_card_info_created_at IS NOT NULL THEN 1 ELSE 0 END AS ci,
      CASE WHEN first_card_applied_at IS NOT NULL THEN 1 ELSE 0 END AS ca,
      CASE WHEN first_card_issued_at IS NOT NULL THEN 1 ELSE 0 END AS cd
    FROM \`gowid-prd.mart_limit_application.card_application_funnel\`
    WHERE card_application_submitted_at >= '2025-01-01'
    ORDER BY card_application_submitted_at DESC, corp_id
  `);
  return rows.map(r => ({
    m: r.m, id: Number(r.id), n: r.n,
    sub: Number(r.sub), apr: Number(r.apr), sig: Number(r.sig),
    ls: Number(r.ls), lp: Number(r.lp), lr: Number(r.lr),
    lim: Number(r.lim),
    ci: Number(r.ci), ca: Number(r.ca), cd: Number(r.cd),
  }));
}

// ─── HTML UPDATER ───

function replaceConst(html, name, data) {
  // Match: const NAME = [...]; or const NAME = [...\n];
  const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`);
  const replacement = `const ${name} = ${JSON.stringify(data)};`;
  if (!re.test(html)) {
    console.error(`  ⚠ ${name} 패턴을 찾을 수 없습니다.`);
    return html;
  }
  return html.replace(re, replacement);
}

function updateTimestamp(html) {
  const today = new Date().toISOString().slice(0, 10);
  // Update footer date
  html = html.replace(/업데이트: \d{4}-\d{2}-\d{2}/, `업데이트: ${today}`);
  // Update DATA_UPDATED_AT
  const tsRe = /const DATA_UPDATED_AT = '[^']*';/;
  const tsNew = `const DATA_UPDATED_AT = '${today}';`;
  if (tsRe.test(html)) {
    html = html.replace(tsRe, tsNew);
  } else {
    // Insert after first <script>
    html = html.replace('<script>', `<script>\n${tsNew}`);
  }
  return html;
}

// ─── MAIN ───

async function main() {
  console.log('🔄 대시보드 데이터 업데이트 시작\n');

  const [funnel, usage, industry, tier, compare, corpDetail, funnelDetail] = await Promise.all([
    fetchFunnelData(),
    fetchUsageData(),
    fetchIndustryData(),
    fetchTierData(),
    fetchCompareData(),
    fetchCorpDetail(),
    fetchFunnelDetail(),
  ]);

  console.log(`\n📊 조회 완료:`);
  console.log(`  FUNNEL_DATA: ${funnel.length}개월`);
  console.log(`  USAGE_DATA: ${usage.length}개 코호트`);
  console.log(`  INDUSTRY_DATA: ${industry.length}개 업종`);
  console.log(`  TIER_DATA: ${tier.length}개 구간`);
  console.log(`  COMPARE_DATA: ${compare.length}개 코호트`);
  console.log(`  CORP_DETAIL: ${corpDetail.length}개 법인`);
  console.log(`  FUNNEL_DETAIL: ${funnelDetail.length}개 법인`);

  console.log('\n📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  html = replaceConst(html, 'FUNNEL_DATA', funnel);
  html = replaceConst(html, 'USAGE_DATA', usage);
  html = replaceConst(html, 'INDUSTRY_DATA', industry);
  html = replaceConst(html, 'TIER_DATA', tier);
  html = replaceConst(html, 'COMPARE_DATA', compare);
  html = replaceConst(html, 'CORP_DETAIL', corpDetail);
  html = replaceConst(html, 'FUNNEL_DETAIL', funnelDetail);
  html = updateTimestamp(html);

  fs.writeFileSync(HTML_FILE, html);
  console.log(`\n✅ 업데이트 완료! (${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`   파일: ${HTML_FILE}`);
  console.log(`   시간: ${new Date().toLocaleString('ko-KR')}`);
}

main().catch(err => {
  console.error('\n❌ 오류 발생:', err.message);
  if (err.message.includes('Cannot find module')) {
    console.error('\n@google-cloud/bigquery 패키지를 설치하세요:');
    console.error('  cd ' + __dirname + ' && bun add @google-cloud/bigquery');
  }
  process.exit(1);
});
