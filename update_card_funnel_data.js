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
        MIN(IF(ci.issuedAt >= c.latest_application_created_at, ci.issuedAt, NULL)) AS ci_issued
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
        -- 발급일
        FORMAT_DATE('%Y-%m-%d', DATE(ci.ci_issued)) AS issued_date,
        -- SLA
        CASE WHEN c.latest_approved_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(c.latest_approved_at, c.latest_application_created_at, DAY), 0) END AS d1,
        CASE WHEN m.signup_at IS NOT NULL AND c.latest_approved_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(m.signup_at, c.latest_approved_at, DAY), 0) END AS d2,
        CASE WHEN lr.lr_at IS NOT NULL AND m.signup_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(lr.lr_at, m.signup_at, DAY), 0) END AS d3,
        CASE WHEN ci.ci_issued IS NOT NULL AND lr.lr_at IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(ci.ci_issued, lr.lr_at, DAY), 0) END AS d4,
        CASE WHEN ci.ci_issued IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(ci.ci_issued, c.latest_application_created_at, DAY), 0) END AS dt,
        CASE WHEN cd.first_spend IS NOT NULL AND ci.ci_issued IS NOT NULL
          THEN GREATEST(DATETIME_DIFF(cd.first_spend, ci.ci_issued, DAY), 0) END AS d5
      FROM cohort c
      LEFT JOIN corp_map_after_app m USING (brn_key)
      LEFT JOIN limit_flow_after_app lf USING (brn_key)
      LEFT JOIN first_limit_result lr USING (brn_key)
      LEFT JOIN card_info_after_app ci USING (brn_key)
      LEFT JOIN corp_dim_after_app cd USING (brn_key)
      LEFT JOIN am_map am USING (brn_key)
      LEFT JOIN corp_name_map cn USING (brn_key)
      LEFT JOIN app_name_map acn USING (brn_key)
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
        FORMAT_DATE('%Y-%m-%d', DATE(ci_agg.ci_issued)) AS issued_date,
        CAST(NULL AS INT64) AS d1, CAST(NULL AS INT64) AS d2,
        CAST(NULL AS INT64) AS d3, CAST(NULL AS INT64) AS d4,
        CAST(NULL AS INT64) AS dt, CAST(NULL AS INT64) AS d5,
        1 AS no_app
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` dim ON dim.corp_id = c.idx
      -- 카드 발급 정보 집계
      LEFT JOIN (
        SELECT ci.idxCorp,
          MIN(ci.createdAt) AS ci_created,
          MIN(ci.appliedAt) AS ci_applied,
          MIN(ci.issuedAt) AS ci_issued
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
    na: Number(r.no_app || 0),
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
