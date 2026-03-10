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

const HTML_FILE = path.join(__dirname, 'card_funnel_dashboard.html');
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

// ─── RECORD_DATA: 건별 레코드 (퍼널 + SLA + AM) ───
async function fetchRecordData() {
  console.log('  [1/1] RECORD_DATA 조회 중...');
  const rows = await query(`
    WITH funnel AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', f.card_application_submitted_at) AS date,
        f.corp_id,
        f.corp_name,
        1 AS sub,
        CASE WHEN f.card_application_approved_at IS NOT NULL THEN 1 ELSE 0 END AS apr,
        CASE WHEN f.signup_at IS NOT NULL THEN 1 ELSE 0 END AS sig,
        CASE WHEN f.first_limit_start_init IS NOT NULL THEN 1 ELSE 0 END AS ls,
        CASE WHEN f.first_limit_progress_after_init IS NOT NULL THEN 1 ELSE 0 END AS lp,
        CASE WHEN f.first_limit_result_at IS NOT NULL THEN 1 ELSE 0 END AS lr,
        CASE WHEN f.first_limit_result_amount > 0 THEN 1 ELSE 0 END AS lnz,
        CASE WHEN f.first_limit_result_at IS NOT NULL AND f.first_limit_result_amount = 0 THEN 1 ELSE 0 END AS lz,
        CASE WHEN f.first_card_info_created_at IS NOT NULL THEN 1 ELSE 0 END AS ci,
        CASE WHEN f.first_card_applied_at IS NOT NULL THEN 1 ELSE 0 END AS ca,
        CASE WHEN f.first_card_issued_at IS NOT NULL THEN 1 ELSE 0 END AS cd,
        CASE WHEN f.first_spend_at IS NOT NULL THEN 1 ELSE 0 END AS fs,
        -- SLA (일 단위)
        GREATEST(f.days_card_application_submitted_to_approved, 0) AS d1,
        CASE WHEN f.signup_at IS NOT NULL AND f.card_application_approved_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(f.signup_at, f.card_application_approved_at, DAY), 0) END AS d2,
        CASE WHEN f.first_limit_result_at IS NOT NULL AND f.signup_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(f.first_limit_result_at, f.signup_at, DAY), 0) END AS d3,
        CASE WHEN f.first_card_issued_at IS NOT NULL AND f.first_limit_result_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(f.first_card_issued_at, f.first_limit_result_at, DAY), 0) END AS d4,
        CASE WHEN f.first_card_issued_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(f.first_card_issued_at, f.card_application_submitted_at, DAY), 0) END AS dt,
        CASE WHEN f.first_spend_at IS NOT NULL AND f.first_card_issued_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(f.first_spend_at, f.first_card_issued_at, DAY), 0) END AS d5,
        FORMAT_DATE('%Y-%m-%d', f.first_card_issued_at) AS issued_date
      FROM \`gowid-prd.mart_limit_application.card_application_funnel\` f
      WHERE f.card_application_submitted_at >= '2025-01-01'
    ),
    -- card_application 뷰에서만 있는 레코드 추가 (funnel 테이블에 없는 초기 이탈건)
    top_only AS (
      SELECT
        FORMAT_DATE('%Y-%m-%d', ca.card_application_submitted_at) AS date,
        ca.corp_id,
        ca.corp_name,
        1 AS sub,
        CASE WHEN ca.card_application_review_status = '승인' THEN 1 ELSE 0 END AS apr,
        CASE WHEN ca.funnel = '회원가입' THEN 1 ELSE 0 END AS sig,
        0 AS ls, 0 AS lp, 0 AS lr, 0 AS lnz, 0 AS lz,
        0 AS ci, 0 AS ca_flag, 0 AS cd, 0 AS fs,
        CAST(NULL AS INT64) AS d1, CAST(NULL AS INT64) AS d2,
        CAST(NULL AS INT64) AS d3, CAST(NULL AS INT64) AS d4,
        CAST(NULL AS INT64) AS dt, CAST(NULL AS INT64) AS d5,
        CAST(NULL AS STRING) AS issued_date
      FROM \`gowid-prd.mart_limit_application.card_application\` ca
      WHERE ca.card_application_submitted_at >= '2025-01-01'
        AND ca.corp_id NOT IN (
          SELECT corp_id FROM \`gowid-prd.mart_limit_application.card_application_funnel\`
          WHERE card_application_submitted_at >= '2025-01-01'
        )
    ),
    combined AS (
      SELECT * FROM funnel
      UNION ALL
      SELECT date, corp_id, corp_name, sub, apr, sig, ls, lp, lr, lnz, lz, ci, ca_flag AS ca, cd, fs, d1, d2, d3, d4, dt, d5, issued_date
      FROM top_only
    )
    SELECT
      c.date,
      c.corp_name,
      c.corp_id,
      IFNULL(co.assigned_am, '') AS am,
      c.sub, c.apr, c.sig, c.ls, c.lp, c.lr, c.lnz, c.lz,
      c.ci, c.ca, c.cd, c.fs,
      c.d1, c.d2, c.d3, c.d4, c.dt, c.d5,
      c.issued_date
    FROM combined c
    LEFT JOIN \`gowid-prd.dw_dimension.corporation\` co ON c.corp_id = co.corp_id
    ORDER BY c.date DESC
  `);

  return rows.map(r => ({
    d: r.date,
    c: r.corp_name,
    am: r.am || '',
    sub: Number(r.sub), apr: Number(r.apr), sig: Number(r.sig),
    ls: Number(r.ls), lp: Number(r.lp), lr: Number(r.lr),
    lnz: Number(r.lnz), lz: Number(r.lz),
    ci: Number(r.ci), ca: Number(r.ca), cd: Number(r.cd), fs: Number(r.fs),
    d1: r.d1 != null ? Number(r.d1) : null,
    d2: r.d2 != null ? Number(r.d2) : null,
    d3: r.d3 != null ? Number(r.d3) : null,
    d4: r.d4 != null ? Number(r.d4) : null,
    dt: r.dt != null ? Number(r.dt) : null,
    d5: r.d5 != null ? Number(r.d5) : null,
    id: r.issued_date || null,
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

  console.log('\n📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  html = replaceConst(html, 'RECORD_DATA', records);
  html = updateTimestamp(html);

  fs.writeFileSync(HTML_FILE, html);
  console.log(`\n✅ 업데이트 완료! (${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`   파일: ${HTML_FILE}`);
  console.log(`   시간: ${new Date().toLocaleString('ko-KR')}`);

  // gh-pages 배포
  await deployToGhPages();
}

async function deployToGhPages() {
  const { execSync } = require('child_process');
  const projectDir = __dirname;
  const run = (cmd, opts) =>
    execSync(cmd, { cwd: projectDir, stdio: 'pipe', timeout: 30000, ...opts });

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
            run('git checkout --ours "' + f + '"');
          } else {
            run('git checkout --theirs "' + f + '"');
          }
          run('git add "' + f + '"');
        }
        run('git rebase --continue', { env: { ...process.env, GIT_EDITOR: 'true' } });
        console.log('   ✅ 충돌 자동 해결');
      } catch {
        console.log('   ⚠ 자동 해결 실패 — reset 후 재시도...');
        try { run('git rebase --abort'); } catch {}
        const htmlPath = path.join(projectDir, 'card_funnel_dashboard.html');
        const jsPath = path.join(projectDir, 'update_card_funnel_data.js');
        const htmlBackup = fs.readFileSync(htmlPath);
        const jsBackup = fs.readFileSync(jsPath);
        run('git reset --hard origin/main');
        fs.writeFileSync(htmlPath, htmlBackup);
        fs.writeFileSync(jsPath, jsBackup);
        run('git add card_funnel_dashboard.html update_card_funnel_data.js');
        run('git commit -m "auto: update card_funnel_dashboard data"');
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
