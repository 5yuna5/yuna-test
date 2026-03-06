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
  return `${y.slice(2)}년${m}월`;
}

// ─── 통합 업종 매핑 SQL ───
// innoforest 카테고리 → 통합 카테고리
const INNO_TO_UNIFIED = `
  CASE
    WHEN cat IN ('AI/딥테크/블록체인', '통신/보안/데이터') THEN 'IT/소프트웨어'
    WHEN cat IN ('커머스', '홈리빙/펫') THEN '커머스'
    WHEN cat = '광고/마케팅' THEN '광고/마케팅'
    WHEN cat IN ('콘텐츠/예술', '소셜미디어/커뮤니티', '게임') THEN '콘텐츠/미디어'
    WHEN cat = '인사/비즈니스/법률' THEN '경영/전문서비스'
    WHEN cat IN ('패션', '뷰티/화장품') THEN '패션/뷰티'
    WHEN cat = '교육' THEN '교육'
    WHEN cat = '푸드/농업' THEN 'F&B/식품'
    WHEN cat = '제조/하드웨어' THEN '제조/하드웨어'
    WHEN cat = '부동산/건설' THEN '건설/부동산'
    WHEN cat = '헬스케어/바이오' THEN '헬스케어/바이오'
    WHEN cat = '피트니스/스포츠' THEN '피트니스/스포츠'
    WHEN cat = '여행/레저' THEN '여행/숙박'
    WHEN cat = '환경/에너지' THEN '환경/에너지'
    WHEN cat = '물류' THEN '물류'
    WHEN cat = '금융/보험/핀테크' THEN '금융/핀테크'
    WHEN cat = '모빌리티/교통' THEN '모빌리티'
    ELSE '기타'
  END`;

// business_items 키워드 → 통합 카테고리
const BIZ_TO_UNIFIED = `
  CASE
    WHEN REGEXP_CONTAINS(biz, r'소프트웨어|프로그래밍|시스템통합|데이터|인터넷|포털|클라우드|플랫폼|정보통신|모바일') THEN 'IT/소프트웨어'
    WHEN REGEXP_CONTAINS(biz, r'전자상거래|소매|도매|유통|판매|프랜차이즈') THEN '커머스'
    WHEN REGEXP_CONTAINS(biz, r'광고|마케팅|디자인|홍보') THEN '광고/마케팅'
    WHEN REGEXP_CONTAINS(biz, r'미디어|콘텐츠|출판|영화|방송|음악|엔터|공연') THEN '콘텐츠/미디어'
    WHEN REGEXP_CONTAINS(biz, r'컨설팅|자문|회계|법무|인력') THEN '경영/전문서비스'
    WHEN REGEXP_CONTAINS(biz, r'화장품|뷰티|피부|패션|의류') THEN '패션/뷰티'
    WHEN REGEXP_CONTAINS(biz, r'교육|학원|학습') THEN '교육'
    WHEN REGEXP_CONTAINS(biz, r'식품|식료|음식|커피|양식|한식|농|주류') THEN 'F&B/식품'
    WHEN REGEXP_CONTAINS(biz, r'제조|로봇|기계|금속') THEN '제조/하드웨어'
    WHEN REGEXP_CONTAINS(biz, r'건축|건설|부동산|인테리어') THEN '건설/부동산'
    WHEN REGEXP_CONTAINS(biz, r'의약|바이오|의료') THEN '헬스케어/바이오'
    WHEN REGEXP_CONTAINS(biz, r'체력|스포츠|피트니스') THEN '피트니스/스포츠'
    WHEN REGEXP_CONTAINS(biz, r'호텔|여행|숙박|관광') THEN '여행/숙박'
    WHEN REGEXP_CONTAINS(biz, r'에너지|태양|신재생|환경') THEN '환경/에너지'
    WHEN REGEXP_CONTAINS(biz, r'물류|운송|배송|택배') THEN '물류'
    WHEN REGEXP_CONTAINS(biz, r'금융|보험|투자') THEN '금융/핀테크'
    ELSE '기타'
  END`;

// ─── QUERIES ───

async function fetchFunnelData() {
  console.log('  [1/7] FUNNEL_DATA 조회 중...');
  // card_application (view): submitted/approved/signup (전체 신청 포함)
  // card_application_funnel (table): limit~first_spend (승인+가입 완료 건만)
  const rows = await query(`
    WITH top_funnel AS (
      SELECT
        FORMAT_DATE('%Y-%m', card_application_submitted_at) AS month,
        COUNT(*) AS submitted,
        COUNTIF(card_application_review_status = '승인') AS approved,
        COUNTIF(funnel = '회원가입') AS signup
      FROM \`gowid-prd.mart_limit_application.card_application\`
      WHERE card_application_submitted_at >= '2025-01-01'
      GROUP BY 1
    ),
    bottom_funnel AS (
      SELECT
        FORMAT_DATE('%Y-%m', card_application_submitted_at) AS month,
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
      GROUP BY 1
    )
    SELECT
      t.month,
      t.submitted, t.approved, t.signup,
      COALESCE(b.limit_start, 0) AS limit_start,
      COALESCE(b.limit_progress, 0) AS limit_progress,
      COALESCE(b.limit_result_any, 0) AS limit_result_any,
      COALESCE(b.limit_nonzero, 0) AS limit_nonzero,
      COALESCE(b.limit_zero, 0) AS limit_zero,
      COALESCE(b.card_info, 0) AS card_info,
      COALESCE(b.card_applied, 0) AS card_applied,
      COALESCE(b.card_issued, 0) AS card_issued,
      COALESCE(b.first_spend, 0) AS first_spend
    FROM top_funnel t
    LEFT JOIN bottom_funnel b ON t.month = b.month
    ORDER BY t.month
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
      SUM(m3_hit_flag) AS m3_cnt,
      CAST(SUM(normal_granted_limit) AS INT64) AS sum_limit,
      CAST(SUM(COALESCE(m0_normal_amount, 0) + COALESCE(m1_normal_amount, 0) + COALESCE(m2_normal_amount, 0) + COALESCE(m3_normal_amount, 0)) AS INT64) AS sum_spend
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
    sum_limit: Number(r.sum_limit || 0),
    sum_spend: Number(r.sum_spend || 0),
  }));
}

async function fetchIndustryData() {
  console.log('  [3/7] INDUSTRY_DATA 조회 중...');
  // 통합 업종 분류: innoforest 있으면 첫 카테고리→통합 매핑, 없으면 business_items 키워드 매핑
  const rows = await query(`
    WITH base AS (
      SELECT
        u.corp_id,
        CASE WHEN u.m0_normal_amount > 0 OR u.m1_normal_amount > 0 OR u.m2_normal_amount > 0 OR u.m3_normal_amount > 0 THEN 1 ELSE 0 END AS has_fs,
        ROUND(SAFE_MULTIPLY(u.m1_use_limit_rate, 100), 1) AS m1_val,
        CASE WHEN u.m1_use_limit_rate >= 0.2 THEN 1 ELSE 0 END AS m1_hit,
        CASE WHEN u.m1_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m1_ok,
        ROUND(SAFE_MULTIPLY(u.m2_use_limit_rate, 100), 1) AS m2_val,
        CASE WHEN u.m2_use_limit_rate >= 0.35 THEN 1 ELSE 0 END AS m2_hit,
        CASE WHEN u.m2_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m2_ok,
        ROUND(SAFE_MULTIPLY(u.m3_use_limit_rate, 100), 1) AS m3_val,
        CASE WHEN u.m3_use_limit_rate >= 0.45 THEN 1 ELSE 0 END AS m3_hit,
        CASE WHEN u.m3_use_limit_rate IS NOT NULL THEN 1 ELSE 0 END AS m3_ok,
        TRIM(SPLIT(c.business_items_innoforest, ',')[SAFE_OFFSET(0)]) AS cat,
        COALESCE(c.business_items, '') AS biz,
        CASE WHEN c.business_items_innoforest IS NOT NULL AND c.business_items_innoforest != '' THEN TRUE ELSE FALSE END AS has_inno
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\` u
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON u.corp_id = c.corp_id
      WHERE u.first_card_issued_at >= '2025-01-01'
    ),
    classified AS (
      SELECT *,
        CASE
          WHEN has_inno THEN ${INNO_TO_UNIFIED}
          ELSE ${BIZ_TO_UNIFIED}
        END AS name
      FROM base
    )
    SELECT
      name,
      COUNT(*) AS cnt,
      ROUND(SUM(has_fs) * 100.0 / COUNT(*), 1) AS fs,
      CASE WHEN SUM(m1_ok) > 0 THEN ROUND(AVG(CASE WHEN m1_ok = 1 THEN m1_val END), 1) ELSE NULL END AS m1,
      CASE WHEN SUM(m1_ok) > 0 THEN ROUND(SUM(m1_hit) * 100.0 / SUM(m1_ok), 1) ELSE NULL END AS m1_hit,
      CASE WHEN SUM(m2_ok) > 0 THEN ROUND(AVG(CASE WHEN m2_ok = 1 THEN m2_val END), 1) ELSE NULL END AS m2,
      CASE WHEN SUM(m2_ok) > 0 THEN ROUND(SUM(m2_hit) * 100.0 / SUM(m2_ok), 1) ELSE NULL END AS m2_hit,
      CASE WHEN SUM(m3_ok) > 0 THEN ROUND(AVG(CASE WHEN m3_ok = 1 THEN m3_val END), 1) ELSE NULL END AS m3,
      CASE WHEN SUM(m3_ok) > 0 THEN ROUND(SUM(m3_hit) * 100.0 / SUM(m3_ok), 1) ELSE NULL END AS m3_hit
    FROM classified
    GROUP BY 1
    HAVING COUNT(*) >= 3
    ORDER BY name
  `);
  return rows.map(r => ({
    name: r.name,
    cnt: Number(r.cnt),
    fs: Number(r.fs || 0),
    m1: r.m1 != null ? Number(r.m1) : null,
    m1_hit: r.m1_hit != null ? Number(r.m1_hit) : null,
    m2: r.m2 != null ? Number(r.m2) : null,
    m2_hit: r.m2_hit != null ? Number(r.m2_hit) : null,
    m3: r.m3 != null ? Number(r.m3) : null,
    m3_hit: r.m3_hit != null ? Number(r.m3_hit) : null,
  }));
}

async function fetchTierData() {
  console.log('  [4/7] TIER_DATA 조회 중...');
  const rows = await query(`
    WITH base AS (
      SELECT
        CASE
          WHEN normal_granted_limit <= 5000000 THEN '~500만'
          WHEN normal_granted_limit <= 10000000 THEN '500만~1천만'
          WHEN normal_granted_limit <= 30000000 THEN '1천만~3천만'
          WHEN normal_granted_limit <= 50000000 THEN '3천만~5천만'
          WHEN normal_granted_limit <= 100000000 THEN '5천만~1억'
          ELSE '1억 이상'
        END AS tier,
        CASE
          WHEN normal_granted_limit <= 5000000 THEN 1
          WHEN normal_granted_limit <= 10000000 THEN 2
          WHEN normal_granted_limit <= 30000000 THEN 3
          WHEN normal_granted_limit <= 50000000 THEN 4
          WHEN normal_granted_limit <= 100000000 THEN 5
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
        -- TODO: inv(인보이스) 컬럼 소스 미확인. corporation 테이블에 해당 컬럼 없음
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

async function fetchSLAData() {
  console.log('  [8/10] SLA_DATA 조회 중...');
  const rows = await query(`
    WITH raw AS (
      SELECT
        FORMAT_DATE('%Y-%m', card_application_submitted_at) AS month,
        GREATEST(days_card_application_submitted_to_approved, 0) AS d_submit_approve,
        GREATEST(DATETIME_DIFF(signup_at, card_application_approved_at, DAY), 0) AS d_approve_signup,
        CASE WHEN first_limit_result_at IS NOT NULL AND signup_at IS NOT NULL
             THEN GREATEST(DATETIME_DIFF(first_limit_result_at, signup_at, DAY), 0) ELSE NULL END AS d_signup_limit,
        CASE WHEN first_card_issued_at IS NOT NULL AND first_limit_result_at IS NOT NULL
             THEN GREATEST(DATETIME_DIFF(first_card_issued_at, first_limit_result_at, DAY), 0) ELSE NULL END AS d_limit_issued,
        GREATEST(days_applied_to_issued, 0) AS d_applied_issued,
        GREATEST(days_issued_to_spend, 0) AS d_issued_spend,
        GREATEST(DATETIME_DIFF(first_card_issued_at, card_application_submitted_at, DAY), 0) AS d_total
      FROM \`gowid-prd.mart_limit_application.card_application_funnel\`
      WHERE card_application_submitted_at >= '2025-01-01'
        AND first_card_issued_at IS NOT NULL
    )
    SELECT
      month,
      COUNT(*) AS total,
      ROUND(AVG(d_submit_approve), 1) AS submit_to_approve,
      ROUND(AVG(d_approve_signup), 1) AS approve_to_signup,
      ROUND(AVG(d_signup_limit), 1) AS signup_to_limit,
      ROUND(AVG(d_limit_issued), 1) AS limit_to_issued,
      ROUND(AVG(d_applied_issued), 1) AS applied_to_issued,
      ROUND(AVG(d_issued_spend), 1) AS issued_to_spend,
      ROUND(AVG(d_total), 1) AS total_days,
      ROUND(APPROX_QUANTILES(d_total, 2)[OFFSET(1)], 1) AS median_days
    FROM raw
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map(r => ({
    month: r.month,
    label: fmtLabel(r.month),
    total: Number(r.total),
    submit_to_approve: r.submit_to_approve != null ? Number(r.submit_to_approve) : null,
    approve_to_signup: r.approve_to_signup != null ? Number(r.approve_to_signup) : null,
    signup_to_limit: r.signup_to_limit != null ? Number(r.signup_to_limit) : null,
    limit_to_issued: r.limit_to_issued != null ? Number(r.limit_to_issued) : null,
    applied_to_issued: r.applied_to_issued != null ? Number(r.applied_to_issued) : null,
    issued_to_spend: r.issued_to_spend != null ? Number(r.issued_to_spend) : null,
    total_days: r.total_days != null ? Number(r.total_days) : null,
    median_days: r.median_days != null ? Number(r.median_days) : null,
  }));
}

async function fetchCohortIndustry() {
  console.log('  [9/10] COHORT_INDUSTRY 조회 중...');
  // 통합 업종 분류: innoforest 첫 카테고리 → 통합명, 없으면 business_items → 통합명
  const rows = await query(`
    WITH issued AS (
      SELECT
        FORMAT_DATE('%Y-%m', f.card_application_submitted_at) AS cohort,
        f.corp_id,
        f.first_limit_result_amount AS granted_limit
      FROM \`gowid-prd.mart_limit_application.card_application_funnel\` f
      WHERE f.card_application_submitted_at >= '2025-01-01'
        AND f.first_card_issued_at IS NOT NULL
    ),
    base AS (
      SELECT
        i.cohort,
        i.corp_id,
        i.granted_limit,
        c.headcount,
        TRIM(SPLIT(c.business_items_innoforest, ',')[SAFE_OFFSET(0)]) AS cat,
        COALESCE(c.business_items, '') AS biz,
        CASE WHEN c.business_items_innoforest IS NOT NULL AND c.business_items_innoforest != '' THEN TRUE ELSE FALSE END AS has_inno
      FROM issued i
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON i.corp_id = c.corp_id
    ),
    classified AS (
      SELECT cohort, corp_id, granted_limit, headcount,
        CASE
          WHEN has_inno THEN ${INNO_TO_UNIFIED}
          ELSE ${BIZ_TO_UNIFIED}
        END AS name
      FROM base
    )
    SELECT
      cohort,
      name,
      COUNT(*) AS cnt,
      ROUND(AVG(granted_limit / 10000)) AS avg_limit,
      ROUND(AVG(headcount), 1) AS avg_hc
    FROM classified
    GROUP BY 1, 2
    ORDER BY cohort, cnt DESC
  `);
  return rows.map(r => ({
    cohort: r.cohort,
    label: fmtLabel(r.cohort),
    name: r.name,
    cnt: Number(r.cnt),
    avg_limit: Number(r.avg_limit),
    avg_hc: r.avg_hc != null ? Number(r.avg_hc) : null,
  }));
}

async function fetchCohortIndustryByIssued() {
  console.log('  [10/10] COHORT_INDUSTRY_ISSUED 조회 중...');
  // 발급월 기준, 통합 업종 분류
  const rows = await query(`
    WITH issued AS (
      SELECT
        FORMAT_DATE('%Y-%m', u.first_card_issued_at) AS cohort,
        u.corp_id,
        u.normal_granted_limit AS granted_limit
      FROM \`gowid-prd.mart_card.export_card_issuance_initial_usage\` u
      WHERE u.first_card_issued_at >= '2025-01-01'
    ),
    base AS (
      SELECT
        i.cohort,
        i.corp_id,
        i.granted_limit,
        c.headcount,
        TRIM(SPLIT(c.business_items_innoforest, ',')[SAFE_OFFSET(0)]) AS cat,
        COALESCE(c.business_items, '') AS biz,
        CASE WHEN c.business_items_innoforest IS NOT NULL AND c.business_items_innoforest != '' THEN TRUE ELSE FALSE END AS has_inno
      FROM issued i
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON i.corp_id = c.corp_id
    ),
    classified AS (
      SELECT cohort, corp_id, granted_limit, headcount,
        CASE
          WHEN has_inno THEN ${INNO_TO_UNIFIED}
          ELSE ${BIZ_TO_UNIFIED}
        END AS name
      FROM base
    )
    SELECT
      cohort,
      name,
      COUNT(*) AS cnt,
      ROUND(AVG(granted_limit / 10000)) AS avg_limit,
      ROUND(AVG(headcount), 1) AS avg_hc
    FROM classified
    GROUP BY 1, 2
    ORDER BY cohort, cnt DESC
  `);
  return rows.map(r => ({
    cohort: r.cohort,
    label: fmtLabel(r.cohort),
    name: r.name,
    cnt: Number(r.cnt),
    avg_limit: Number(r.avg_limit),
    avg_hc: r.avg_hc != null ? Number(r.avg_hc) : null,
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
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const isoFull = now.toISOString();
  // Update footer date
  html = html.replace(/업데이트: \d{4}-\d{2}-\d{2}/, `업데이트: ${today}`);
  // Update DATA_UPDATED_AT (ISO datetime for accurate freshness)
  const tsRe = /const DATA_UPDATED_AT = '[^']*';/;
  const tsNew = `const DATA_UPDATED_AT = '${isoFull}';`;
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

  // ⚠ TIER_DATA, COMPARE_DATA는 수작업 보정 데이터이므로 업데이트하지 않음
  const [funnel, usage, industry, corpDetail, funnelDetail, sla, cohortIndustry, cohortIndustryIssued] = await Promise.all([
    fetchFunnelData(),
    fetchUsageData(),
    fetchIndustryData(),
    fetchCorpDetail(),
    fetchFunnelDetail(),
    fetchSLAData(),
    fetchCohortIndustry(),
    fetchCohortIndustryByIssued(),
  ]);

  console.log(`\n📊 조회 완료:`);
  console.log(`  FUNNEL_DATA: ${funnel.length}개월`);
  console.log(`  USAGE_DATA: ${usage.length}개월`);
  console.log(`  INDUSTRY_DATA: ${industry.length}개 업종`);
  console.log(`  CORP_DETAIL: ${corpDetail.length}개 법인`);
  console.log(`  FUNNEL_DETAIL: ${funnelDetail.length}개 법인`);
  console.log(`  SLA_DATA: ${sla.length}개월`);
  console.log(`  COHORT_INDUSTRY: ${cohortIndustry.length}개 코호트×업종 (신청월 기준)`);
  console.log(`  COHORT_INDUSTRY_ISSUED: ${cohortIndustryIssued.length}개 코호트×업종 (발급월 기준)`);
  console.log(`  (TIER_DATA, COMPARE_DATA는 보정 데이터 — 건너뜀)`);

  console.log('\n📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  html = replaceConst(html, 'FUNNEL_DATA', funnel);
  html = replaceConst(html, 'USAGE_DATA', usage);
  html = replaceConst(html, 'INDUSTRY_DATA', industry);
  html = replaceConst(html, 'CORP_DETAIL', corpDetail);
  html = replaceConst(html, 'FUNNEL_DETAIL', funnelDetail);
  html = replaceConst(html, 'SLA_DATA', sla);
  html = replaceConst(html, 'COHORT_INDUSTRY', cohortIndustry);
  html = replaceConst(html, 'COHORT_INDUSTRY_ISSUED', cohortIndustryIssued);
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
