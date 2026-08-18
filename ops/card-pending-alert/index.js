#!/usr/bin/env node
/**
 * 카드 발급 대기 업체 알림 스크립트
 *
 * - 직전 3개월 도입신청(또는 가입) → 카드사 접수 → 발급 미완료
 * - 당월 도입신청(또는 가입) → 카드사 접수 → 발급 미완료
 * - 고위드 부결/취소 제외, FUEL 표기, 카드사별 건별 트래킹
 * - 도입신청서 없이 인입된 곳은 회원가입일/법인생성일 기준 코호트 산정
 *
 * Usage:
 *   node index.js                    # 기본 채널로 전송
 *   node index.js --channel C057XXX  # 특정 채널로 전송
 *   node index.js --dry-run          # 슬랙 전송 없이 콘솔 출력만
 */

require('dotenv').config({ path: require('path').join(__dirname, '../crm-slack-bot/.env') });

const { BigQuery } = require('@google-cloud/bigquery');
const { WebClient } = require('@slack/web-api');
const path = require('path');

// ─── Config ───
const KEYFILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const PROJECT = 'gowid-prd';
const LOCATION = 'asia-northeast3';
const DEFAULT_CHANNEL = 'C068EG4N7QA'; // 온보딩 퍼널별 고객 터치 알림 채널
const PARENT_BOT_ID = 'B0A1F2E9KPX'; // 온보딩 퍼널별 고객 터치 알림 봇

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force'); // 멱등성 가드 무시하고 강제 재발송 (수동 확인용)
const NO_THREAD = args.includes('--no-thread'); // 부모 봇 메시지 탐색/쓰레드 없이 채널에 바로 발송 (DM 테스트용)
const channelIdx = args.indexOf('--channel');
const CHANNEL = channelIdx >= 0 ? args[channelIdx + 1] : DEFAULT_CHANNEL;

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 수동 제외 리스트 (신청서 취소/고객 이탈 등 데이터에 반영되지 않는 건)
const EXCLUDED_CORP_IDS = [
  1328617025, // (주)이앤티코리아 — 고객 의사 철회, 신청 취소
  2738102997, // 주식회사 모난돌컴퍼니 — 신청서 취소 처리
];

// ─── Supabase 운영 이탈 (card-squad /goal과 동일 소스로 리스트 일치) ───
// /goal '카드사 심사중'은 manual_exclusions/onboarding_exits(운영팀 수동 이탈)를 제외함.
// 봇도 동일 기준을 맞추기 위해 PostgREST로 직접 조회. anon 키는 공개값(card-squad src/lib/supabase.ts와 동일).
const SUPABASE_URL = 'https://okiipcxxaywvcmeecqvx.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9raWlwY3h4YXl3dmNtZWVjcXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDM5NjEsImV4cCI6MjA5MDUxOTk2MX0.xldBRKo6laOy89zGaWT_Z3azPc30-c4iUFVixt3ZvcY';

// /goal lifecycle row 활동 타임스탬프(재진입 판정용) — card-squad GOAL_ACTIVITY_FIELDS의 핵심 부분집합.
// 심사중 법인은 card_co_pending_at이 최신 활동이라 이 집합으로 /goal과 동일하게 판정됨.
const ACTIVITY_FIELDS = ['card_co_pending_at', 'application_submitted_at', 'gowid_approved_at', 'application_drafting_at', 'registered_at'];

const ymd = (v) => (v ? String(v).slice(0, 10) : '');
const maxYmd = (...vals) => { let m = ''; for (const v of vals) { const d = ymd(v); if (d && d > m) m = d; } return m; };
function latestActivityDate(row) { return maxYmd(...ACTIVITY_FIELDS.map((f) => row[f])); }

// card-squad isStillExcluded 포팅: 이탈 기록 있고, 그 이후 새 활동(재진입)이 없으면 제외 유지.
function isStillExcluded(exit, latestActivity) {
  if (!exit) return false;
  if (!exit.since) return true;
  return !(latestActivity && latestActivity > exit.since);
}

async function sbSelect(table, cols) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
  });
  if (!r.ok) throw new Error(`Supabase ${table} ${r.status}`);
  return r.json();
}

// 이탈/제외 맵 로드 (card-squad src/lib/exits.ts 포팅). bzno → { reason, since }
async function loadExitMap() {
  const [me, oe] = await Promise.all([
    sbSelect('manual_exclusions', 'bzno,reason,excluded_at,synced_at'),
    sbSelect('onboarding_exits', 'bzno,exit_reason_category,exited_at,created_at'),
  ]);
  const map = {};
  const put = (bzno, since, reason) => {
    if (!bzno) return;
    const key = String(bzno);
    const prev = map[key];
    if (!prev) { map[key] = { reason: reason || '이탈', since }; return; }
    if (since > prev.since) prev.since = since;
    if (!prev.reason && reason) prev.reason = reason;
  };
  for (const e of me || []) put(e.bzno, maxYmd(e.excluded_at, e.synced_at), e.reason);
  for (const e of oe || []) put(e.bzno, maxYmd(e.exited_at, e.created_at), e.exit_reason_category || '이탈');
  return map;
}

// ─── BigQuery ───

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

async function fetchPendingCards() {
  // card-squad /goal '카드사 심사중'과 동일 기준으로 추출:
  //  - 소스: application_status_materialized (스냅샷, /goal과 동일) — (corp, 카드사) 최신 1건
  //  - 상태: '카드사 심사중' / '신청서 제출'(고위드 발송 대기) / '신청서 작성중'(고객 전자서명 대기)
  //  - 제외: 발급 완료(CardIssuanceInfo), 탈회(Corp.isDeleted=1), 운영 수동 이탈(Supabase, JS에서 처리)
  //  - 코호트 필터 없음(전체 기간). 표시상으로만 당월/이전으로 분리.
  const rows = await query(`
    WITH deleted_corps AS (
      SELECT DISTINCT SAFE_CAST(REPLACE(resCompanyIdentityNo, '-', '') AS INT64) AS corp_id
      FROM \`gowid-prd.ods_stream_gowid.Corp\`
      WHERE isDeleted = 1
        AND SAFE_CAST(REPLACE(resCompanyIdentityNo, '-', '') AS INT64) IS NOT NULL -- NOT IN + NULL 함정 방지
    ),

    corp_info AS (
      SELECT
        idx AS corp_idx,
        SAFE_CAST(REPLACE(resCompanyIdentityNo, '-', '') AS INT64) AS corp_id,
        resCompanyNm AS corp_name,
        FORMAT_TIMESTAMP('%Y-%m-%d', createdAt) AS registered_at
      FROM \`gowid-prd.ods_stream_gowid.Corp\`
      WHERE resCompanyIdentityNo IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY REPLACE(resCompanyIdentityNo, '-', '') ORDER BY createdAt DESC) = 1
    ),

    -- 발급 완료 법인 (제외용)
    issued AS (
      SELECT DISTINCT o.corp_id
      FROM corp_info o
      JOIN \`gowid-prd.ods_stream_gowid.CardIssuanceInfo\` ci ON ci.idxCorp = o.corp_idx
      WHERE ci.issuedAt IS NOT NULL
    ),

    -- 코호트 표시용 도입신청/가입일
    funnel AS (
      SELECT corp_id,
        DATE(card_application_submitted_at) AS app_submitted,
        DATE(signup_at) AS signup_at
      FROM \`gowid-prd.mart_limit_application.card_application_funnel\`
    ),

    -- /goal과 동일한 스냅샷 소스, (corp, 카드사) 최신 1건
    mart AS (
      SELECT corp_id, card_company_name, latest_status,
        FORMAT_DATETIME('%Y-%m-%d', opinion_submitted_at) AS opinion_submitted_at,
        FORMAT_DATETIME('%Y-%m-%d', card_co_pending_at) AS card_co_pending_at,
        FORMAT_DATETIME('%Y-%m-%d', application_submitted_at) AS application_submitted_at,
        FORMAT_DATETIME('%Y-%m-%d', gowid_approved_at) AS gowid_approved_at,
        FORMAT_DATETIME('%Y-%m-%d', application_drafting_at) AS application_drafting_at
      FROM \`gowid-prd.mart_limit_application.application_status_materialized\`
      WHERE application_type = '신규'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY corp_id, card_company_name ORDER BY initialized_at DESC) = 1
    ),

    base AS (
      SELECT
        m.corp_id,
        o.corp_name,
        m.card_company_name,
        m.latest_status,
        COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel,
        m.opinion_submitted_at,
        m.card_co_pending_at,
        m.application_submitted_at,
        m.gowid_approved_at,
        m.application_drafting_at,
        o.registered_at,
        FORMAT_DATE('%Y-%m', COALESCE(f.app_submitted, f.signup_at, DATE(o.registered_at))) AS cohort_month,
        (m.latest_status = '신청서 제출') AS card_co_not_received
      FROM mart m
      JOIN corp_info o ON o.corp_id = m.corp_id
      LEFT JOIN funnel f ON f.corp_id = m.corp_id
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON cor.corp_id = m.corp_id
      WHERE m.latest_status IN ('카드사 심사중', '신청서 제출', '신청서 작성중')
        AND m.corp_id NOT IN (SELECT corp_id FROM issued)
        AND m.corp_id NOT IN (SELECT corp_id FROM deleted_corps)
    ),

    -- 단계별 경과일 기준점: 지금 머물러 있는 단계에 진입한 시각
    anchored AS (
      SELECT *,
        CASE latest_status
          WHEN '카드사 심사중' THEN card_co_pending_at      -- 카드사 심사 시작
          WHEN '신청서 제출'   THEN application_submitted_at -- 전자서명 완료 = 제출
          WHEN '신청서 작성중' THEN application_drafting_at  -- 신청서 열람/작성 시작
        END AS stage_anchor_at
      FROM base
    )

    SELECT *,
      -- 영업일 계산 (주말 제외, 현재 단계 진입일 기준)
      CASE
        WHEN stage_anchor_at IS NULL THEN NULL
        ELSE (
          SELECT COUNT(*)
          FROM UNNEST(GENERATE_DATE_ARRAY(DATE(stage_anchor_at), CURRENT_DATE())) AS d
          WHERE EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7) -- 일=1, 토=7
        )
        -- 진입 당일 제외. 단 주말에 진입한 건은 위 COUNT에 애초에 안 잡히므로 뺄 것이 없음
        -- (안 그러면 일요일 제출 건이 1영업일 과소 계산됨)
        - IF(EXTRACT(DAYOFWEEK FROM DATE(stage_anchor_at)) IN (1, 7), 0, 1)
      END AS biz_days_in_stage,
      CASE WHEN cohort_month = FORMAT_DATE('%Y-%m', CURRENT_DATE()) THEN 'curr' ELSE 'prev' END AS cohort
    FROM anchored
    ORDER BY card_company_name, biz_days_in_stage DESC, corp_name
  `);

  // /goal과 동일하게 운영 수동 이탈(manual_exclusions/onboarding_exits) 제외 + 재진입 반영
  const exitMap = await loadExitMap();

  const prev3 = [];
  const curr = [];
  const drafting = []; // 고객 전자서명 대기 (신청서 작성중) — /goal 모수 밖이라 별도 섹션

  for (const r of rows) {
    if (EXCLUDED_CORP_IDS.includes(Number(r.corp_id))) continue;
    // 이탈 처리됐고 이탈 기록 이후 새 활동(재진입)이 없으면 제외
    if (isStillExcluded(exitMap[String(r.corp_id)], latestActivityDate(r))) continue;
    const item = {
      corp_id: r.corp_id,
      corp_name: r.corp_name,
      card_company: r.card_company_name,
      is_fuel: r.is_fuel,
      latest_status: r.latest_status,
      opinion_submitted_at: r.opinion_submitted_at,
      stage_anchor_at: r.stage_anchor_at,
      cohort_month: r.cohort_month,
      biz_days: r.biz_days_in_stage,
    };
    if (r.latest_status === '신청서 작성중') drafting.push(item);
    else (r.cohort === 'curr' ? curr : prev3).push(item);
  }

  return { prev3, curr, drafting };
}

// ─── 법인 전자서명 실패 감지 (#bot-법인카드-발급단계) ───
// 고객(대표자) 전자서명이 끝나 '전자서명 완료' → APPLICATION_SUBMITTED로 넘어간 뒤,
// 고위드가 카드사로 보내기 위한 '법인 전자서명' 처리가 서버 에러로 실패하는 케이스가 있음.
// 이때 ODS에는 아무 흔적이 안 남아 상태가 '신청서 제출'에 머물러 정상 대기처럼 보인다.
// (실측: 모아보아 08-16 14:20:33 전자서명 완료 → 14:21:10 법인 전자서명 실패 → 08-18 09:57 재시도 실패)
// 경과일 기준만으로는 당일 장애를 못 잡으므로 이 채널의 실패 이벤트를 직접 읽는다.
const STEP_EVENT_CHANNEL = 'C04M8QMRB0E'; // #bot-법인카드-발급단계
const SIGN_FAIL_LOOKBACK_DAYS = 14;

// 법인명 정규화: 법인격 표기 흔들림 흡수 ((주)/㈜/주식회사/공백)
function normCorpName(name) {
  return String(name || '')
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// 법인명(정규화) → { ts: 마지막 실패 시각(epoch초), reason }
async function fetchSignFailures() {
  const oldest = Math.floor(Date.now() / 1000) - SIGN_FAIL_LOOKBACK_DAYS * 86400;
  const failures = {};
  try {
    let cursor;
    do {
      const r = await slack.conversations.history({
        channel: STEP_EVENT_CHANNEL, oldest: String(oldest), limit: 200, cursor,
      });
      for (const m of r.messages || []) {
        const text = m.text || '';
        if (!/법인 전자서명\s*-\s*실패/.test(text)) continue;
        const nameMatch = text.match(/법인명\s*:\s*(.+)/);
        if (!nameMatch) continue;
        const key = normCorpName(nameMatch[1].trim());
        const reasonMatch = text.match(/실패\(([^)]*)\)/);
        const ts = Number(m.ts);
        if (!failures[key] || ts > failures[key].ts) {
          failures[key] = { ts, reason: reasonMatch ? reasonMatch[1].trim() : '' };
        }
      }
      cursor = r.response_metadata && r.response_metadata.next_cursor;
    } while (cursor);
    console.log(`법인 전자서명 실패 이벤트: ${Object.keys(failures).length}개 법인`);
  } catch (err) {
    // 채널 미초대(not_in_channel) 등은 치명적이지 않음 — 실패 표시만 빠지고 나머지는 그대로 발송.
    console.error(`[WARN] 전자서명 실패 이벤트 조회 실패 (${err.data ? err.data.error : err.message}) — 해당 표시 생략`);
  }
  return failures;
}

// 실패 이벤트가 '현재 단계에 진입한 이후'에 발생했는지 (과거 신청건의 옛 실패 제외)
function signFailureFor(c, failures) {
  const f = failures[normCorpName(c.corp_name)];
  if (!f) return null;
  if (!c.stage_anchor_at) return f;
  return f.ts >= Date.parse(`${c.stage_anchor_at}T00:00:00+09:00`) / 1000 ? f : null;
}

function fmtKstTime(ts) {
  return new Date(Number(ts) * 1000)
    .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
    .slice(5, 16); // MM-DD HH:MM
}

// ─── Slack Message ───

function formatDate(isoStr) {
  if (!isoStr) return '-';
  return isoStr.slice(0, 10);
}

// Unix epoch(초) → KST 날짜 문자열 (YYYY-MM-DD)
function tsToKstDate(ts) {
  const ms = Number(ts) * 1000;
  // 'sv-SE' 로케일은 YYYY-MM-DD 포맷을 반환함. Asia/Seoul 타임존으로 KST 변환
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function todayKstDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function fmtMonth(d) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

// ─── 지연 감지 임계치 (2026-01 이후 신규 입회 실측 p90 초과) ───
// 제출→전문발송 영업일 분포:
//   신한 n=479 p50=0 p75=0 p90=0 (당일 전송 90.2%) — 평시 1~2분 자동 전송
//   롯데 n=437 p50=0 p75=0 p90=1 (당일 전송 89.5%)
//   비씨 n=247 p50=1 p75=3 p90=4 — 심사의견서 단계가 껴서 원래 며칠 걸림
// 작성중→제출(고객 전자서명) n=1177 p50=0 p75=1 p90=2
// → 각 p90을 넘어서면 정상 흐름이 아니라 막힌 것으로 보고 ⚠️ 표시.
const SEND_DELAY_ALERT = { '신한카드': 1, '롯데카드': 2, '비씨카드': 5 };
const SEND_DELAY_ALERT_DEFAULT = 2;
const SIGN_DELAY_ALERT = 3; // 고객 전자서명 대기

// 해당 단계에서 정상 범위를 벗어났는지. 카드사 심사중은 별도 SLA 체계라 대상 아님.
function isStalled(c) {
  if (c.biz_days == null) return false;
  if (c.latest_status === '카드사 심사중') return false;
  if (c.latest_status === '신청서 작성중') return c.biz_days >= SIGN_DELAY_ALERT;
  const th = SEND_DELAY_ALERT[c.card_company] ?? SEND_DELAY_ALERT_DEFAULT;
  return c.biz_days >= th;
}

// 현재 머물러 있는 단계를 카드사 프로세스에 맞춰 표기.
//  - 카드사 심사중  : 전문 발송 완료 → 라벨 없이 영업일만 (기존 동작 유지)
//  - 신청서 제출    : 전자서명 완료, 고위드가 아직 카드사로 안 보냄
//      · 비씨 + 의견서 미발송 → '심사의견서 발송 대기' (심사의견서는 비씨 전용 단계)
//      · 그 외(비씨 의견서 발송 후 / 신한 / 롯데) → '전문 발송 대기'
//  - 신청서 작성중  : 고객이 아직 전자서명을 안 끝냄
function stageLabel(c) {
  if (c.latest_status === '카드사 심사중') return null;
  if (c.latest_status === '신청서 작성중') return '고객 전자서명 대기';
  if (c.card_company === '비씨카드' && !c.opinion_submitted_at) return '심사의견서 발송 대기';
  return '전문 발송 대기';
}

function buildCorpLine(c, i, failures) {
  const fuel = c.is_fuel ? ' (FUEL)' : '';
  const month = c.cohort_month ? ` (${c.cohort_month})` : '';
  const days = c.biz_days != null ? `${c.biz_days}영업일` : null;
  const label = stageLabel(c);

  // 법인 전자서명 실패는 경과일과 무관하게 즉시 표시 (당일 장애도 놓치지 않도록)
  const fail = failures ? signFailureFor(c, failures) : null;
  const warn = (fail || isStalled(c)) ? ' :warning:' : '';
  const failNote = fail
    ? ` · 법인 전자서명 실패${fail.reason ? `(${fail.reason})` : ''} ${fmtKstTime(fail.ts)}`
    : '';

  const suffix = label
    ? ` — ${label}${days ? ` (${days})` : ''}${warn}${failNote}`
    : (days ? ` — ${days}${warn}${failNote}` : '');
  return `${i + 1}. ${c.corp_name}${fuel}${month}${suffix}`;
}

function groupByCardCompany(items) {
  const groups = {};
  for (const item of items) {
    const key = item.card_company || '확인필요';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function buildCardCompanySection(cardCompany, items, blocks, failures) {
  const lines = items.map((c, i) => buildCorpLine(c, i, failures));
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*[${cardCompany}] ${items.length}건*\n${lines.join('\n')}`,
    },
  });
}

function buildCohortSection(label, items, blocks, failures) {
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${label}*\n*총 ${items.length}건*`,
    },
  });

  if (items.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_해당 건이 없습니다._' } });
    return;
  }

  const groups = groupByCardCompany(items);
  for (const [cardCompany, groupItems] of Object.entries(groups)) {
    buildCardCompanySection(cardCompany, groupItems, blocks, failures);
  }
}

function buildBlocks(data, failures) {
  const now = new Date();
  const currMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `카드 발급 대기 현황 (${now.toISOString().slice(0, 10)})` },
  });

  // ── 당월 이전 (전체 기간) ──
  buildCohortSection(
    `${fmtMonth(currMonth)} 이전 (전체) 도입신청 → 카드사 심사중`,
    data.prev3,
    blocks,
    failures
  );

  // ── 당월 ──
  buildCohortSection(
    `${fmtMonth(currMonth)} 도입신청 → 카드사 심사중`,
    data.curr,
    blocks,
    failures
  );

  // ── 고객 전자서명 대기 (신청서 작성중) ──
  // 위 2개 섹션과 모수 분리: /goal '심사중 법인 관리' 합계를 깨지 않기 위해 별도 집계.
  if (data.drafting.length > 0) {
    buildCohortSection(
      '고객 전자서명 대기 (신청서 작성중) — 위 집계와 별도',
      data.drafting,
      blocks,
      failures
    );
  }

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `영업일 = 현재 단계 진입 후 경과일(주말 제외) · 심사의견서는 비씨카드 전용 단계 · 전문 = 고위드→카드사 신청 전송 · :warning: = 법인 전자서명 실패 또는 해당 단계 정상 범위(p90) 초과 (전문발송 신한 ${SEND_DELAY_ALERT['신한카드']}일↑·롯데 ${SEND_DELAY_ALERT['롯데카드']}일↑·비씨 ${SEND_DELAY_ALERT['비씨카드']}일↑ / 전자서명 ${SIGN_DELAY_ALERT}일↑) · 상단 2개 섹션은 /goal '심사중 법인 관리'와 동일 기준 | ${now.toISOString().slice(0, 16)}`,
    }],
  });

  return blocks;
}

// ─── Main ───

async function main() {
  console.log('카드 발급 대기 현황 조회 중...');
  const data = await fetchPendingCards();

  console.log(`직전3개월: ${data.prev3.length}건`);
  console.log(`당월: ${data.curr.length}건`);
  console.log(`고객 전자서명 대기(신청서 작성중): ${data.drafting.length}건`);

  const failures = await fetchSignFailures();
  const blocks = buildBlocks(data, failures);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 슬랙 메시지 미리보기:\n');
    for (const b of blocks) {
      if (b.type === 'header') console.log(`=== ${b.text.text} ===`);
      else if (b.type === 'section') console.log(b.text.text);
      else if (b.type === 'context') console.log(`(${b.elements[0].text})`);
      else if (b.type === 'divider') console.log('---');
    }
    return;
  }

  // --no-thread: 부모 봇 메시지가 없는 채널(DM 등)로 바로 발송. 테스트 확인용.
  if (NO_THREAD) {
    console.log(`\n[NO THREAD] 채널 ${CHANNEL}로 바로 전송 중...`);
    await slack.chat.postMessage({
      channel: CHANNEL,
      username: '카드 발급 대기 알림',
      icon_emoji: ':credit_card:',
      text: `카드 발급 대기 현황: 직전3개월 ${data.prev3.length}건, 당월 ${data.curr.length}건, 전자서명 대기 ${data.drafting.length}건`,
      blocks,
    });
    console.log('전송 완료!');
    return;
  }

  // 온보딩 퍼널별 고객 터치 알림 봇의 최신 메시지 찾기
  console.log(`\n채널 ${CHANNEL}에서 봇 메시지 검색 중...`);
  const history = await slack.conversations.history({
    channel: CHANNEL,
    limit: 30,
  });

  const parentMsg = history.messages.find(
    m => m.bot_id === PARENT_BOT_ID
  );

  if (!parentMsg) {
    console.error('온보딩 퍼널별 고객 터치 알림 봇 메시지를 찾을 수 없습니다.');
    process.exit(1);
  }

  // 중복 전송 방지: 이미 오늘자 "카드 발급 대기 알림" 리플라이가 쓰레드에 있으면 skip
  // (GHA 이중 스케줄 00:05/00:35 UTC 중 두 번째 실행이 돌 때를 위한 방어)
  // --force 시 가드 무시(수동 재발송).
  const BOT_USERNAME = '카드 발급 대기 알림';
  const todayKst = todayKstDate();
  if (!FORCE) try {
    const replies = await slack.conversations.replies({
      channel: CHANNEL,
      ts: parentMsg.ts,
    });
    const dup = (replies.messages || []).find(m => {
      const nameMatch =
        m.username === BOT_USERNAME ||
        (m.bot_profile && m.bot_profile.name === BOT_USERNAME);
      if (!nameMatch) return false;
      return tsToKstDate(m.ts) === todayKst;
    });
    if (dup) {
      console.log(`이미 오늘자 알림이 쓰레드에 있어 skip합니다. (ts=${dup.ts}, kst=${todayKst})`);
      process.exit(0);
    }
  } catch (err) {
    // 리플라이 조회 실패 시 중복방지 포기하고 기존 로직 진행 (silent fail보다 발송 누락이 더 위험)
    console.error(`중복 체크 실패 (계속 진행): ${err.message}`);
  }

  console.log(`봇 메시지 발견 (ts: ${parentMsg.ts}), 쓰레드로 전송 중...`);
  await slack.chat.postMessage({
    channel: CHANNEL,
    thread_ts: parentMsg.ts,
    username: '카드 발급 대기 알림',
    icon_emoji: ':credit_card:',
    text: `카드 발급 대기 현황: 직전3개월 ${data.prev3.length}건, 당월 ${data.curr.length}건, 전자서명 대기 ${data.drafting.length}건`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  console.log('쓰레드 전송 완료!');
}

main().catch(err => {
  console.error('오류:', err.message);
  process.exit(1);
});
