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

const HTML_FILE = path.join(__dirname, 'limit_increase_dashboard.html');
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
      AND initialized_at >= '2025-06-01'
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
      ROUND(AVG(limit_check_duration), 1) AS sla_limit_check,
      ROUND(AVG(net_gowid_review_duration), 1) AS sla_gowid_review,
      ROUND(AVG(application_submit_duration), 1) AS sla_app_submit,
      ROUND(AVG(card_co_review_duration), 1) AS sla_card_co_review,
      ROUND(AVG(gowid_review_duration), 1) AS sla_gowid_total,
      ROUND(AVG(total_review_duration), 1) AS sla_total,
      ROUND(AVG(days_elapsed), 1) AS avg_days_elapsed,
      -- SLA 초과 비율
      ROUND(SAFE_DIVIDE(COUNTIF(is_limit_check_duration_over), COUNT(*)) * 100, 1) AS pct_limit_check_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_net_gowid_review_duration_over), COUNT(*)) * 100, 1) AS pct_gowid_review_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_application_submit_duration_over), COUNT(*)) * 100, 1) AS pct_app_submit_over,
      ROUND(SAFE_DIVIDE(COUNTIF(is_card_co_review_duration_over), COUNT(*)) * 100, 1) AS pct_card_co_review_over
    FROM \`gowid-prd.mart_limit_application.application_status\`
    WHERE application_type IN ('한도상향', '카드사 추가')
      AND initialized_at >= '2025-06-01'
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

// ─── 3. DETAIL_DATA: 건별 상세 (전체 기간) ───
async function fetchDetailData() {
  console.log('  [3/4] DETAIL_DATA 조회 중...');
  const rows = await query(`
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
      a.total_review_duration AS total_days,
      FORMAT_DATETIME('%Y-%m', a.initialized_at) AS month,
      IFNULL(c.assigned_am, '') AS assigned_am
    FROM \`gowid-prd.mart_limit_application.application_status\` a
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON a.corp_id = c.corp_id
    WHERE a.application_type IN ('한도상향', '카드사 추가')
      AND a.initialized_at >= '2025-06-01'
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
      ROUND(AVG(card_co_review_duration), 1) AS avg_card_review,
      ROUND(AVG(total_review_duration), 1) AS avg_total
    FROM \`gowid-prd.mart_limit_application.application_status\`
    WHERE application_type IN ('한도상향', '카드사 추가')
      AND initialized_at >= '2025-06-01'
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
      a.total_review_duration AS td,
      a.card_co_review_duration AS cd,
      a.net_gowid_review_duration AS nd,
      a.limit_check_duration AS ld,
      a.application_submit_duration AS sd,
      CASE WHEN a.card_co_approved_at IS NOT NULL OR a.gowid_rejected_at IS NOT NULL
                OR a.card_co_rejected_at IS NOT NULL OR a.canceled_at IS NOT NULL THEN 1 ELSE 0 END AS done,
      CASE WHEN a.is_limit_check_duration_over THEN 1 ELSE 0 END AS lo,
      CASE WHEN a.is_net_gowid_review_duration_over THEN 1 ELSE 0 END AS go,
      CASE WHEN a.is_application_submit_duration_over THEN 1 ELSE 0 END AS so,
      CASE WHEN a.is_card_co_review_duration_over THEN 1 ELSE 0 END AS co
    FROM \`gowid-prd.mart_limit_application.application_status\` a
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` c ON a.corp_id = c.corp_id
    WHERE a.application_type IN ('한도상향', '카드사 추가')
      AND a.initialized_at >= '2025-06-01'
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

main().catch(err => {
  console.error('\n❌ 오류 발생:', err.message);
  if (err.message.includes('Cannot find module')) {
    console.error('\n@google-cloud/bigquery 패키지를 설치하세요:');
    console.error('  cd ' + __dirname + ' && bun add @google-cloud/bigquery');
  }
  process.exit(1);
});
