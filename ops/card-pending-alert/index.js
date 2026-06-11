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
const channelIdx = args.indexOf('--channel');
const CHANNEL = channelIdx >= 0 ? args[channelIdx + 1] : DEFAULT_CHANNEL;

const bq = new BigQuery({ projectId: PROJECT, keyFilename: KEYFILE, location: LOCATION });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 수동 제외 리스트 (신청서 취소/고객 이탈 등 데이터에 반영되지 않는 건)
const EXCLUDED_CORP_IDS = [
  1328617025, // (주)이앤티코리아 — 고객 의사 철회, 신청 취소
  2738102997, // 주식회사 모난돌컴퍼니 — 신청서 취소 처리
];

// ─── BigQuery ───

async function query(sql) {
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION });
  const [rows] = await job.getQueryResults();
  return rows;
}

async function fetchPendingCards() {
  const rows = await query(`
    -- 소스1: application_status (카드사별 건별 트래킹)
    -- 카드사 접수 완료 + 미승인 + 부결/취소 아닌 건
    WITH src_appstatus AS (
      SELECT
        la.corp_id,
        la.corp_name,
        la.card_company_name,
        la.latest_status,
        COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel,
        f.card_application_submitted_at,
        f.signup_at,
        cor.created_at AS corp_created_at,
        CASE WHEN f.card_application_submitted_at IS NULL THEN true ELSE false END AS no_card_application,
        la.card_co_pending_at
      FROM \`gowid-prd.mart_limit_application.application_status\` la
      LEFT JOIN \`gowid-prd.mart_limit_application.card_application_funnel\` f ON la.corp_id = f.corp_id
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON la.corp_id = cor.corp_id
      WHERE la.application_type = '신규'
        AND la.gowid_rejected_at IS NULL
        AND la.canceled_at IS NULL
        AND la.card_co_approved_at IS NULL
        AND la.card_co_rejected_at IS NULL
        AND la.card_co_pending_at IS NOT NULL
    ),

    -- 소스2: card_application_funnel (application_status에 없는 건 보완)
    -- 카드신청 완료 + 미발급 + application_status에 미존재
    src_funnel AS (
      SELECT
        f.corp_id,
        f.corp_name,
        '확인필요' AS card_company_name,
        '카드사 심사중' AS latest_status,
        COALESCE(cor.is_fuel_eligible, false) OR COALESCE(cor.is_fuel_client, false) AS is_fuel,
        f.card_application_submitted_at,
        f.signup_at,
        cor.created_at AS corp_created_at,
        CASE WHEN f.card_application_submitted_at IS NULL THEN true ELSE false END AS no_card_application,
        CAST(NULL AS DATETIME) AS card_co_pending_at
      FROM \`gowid-prd.mart_limit_application.card_application_funnel\` f
      LEFT JOIN \`gowid-prd.dw_dimension.corporation\` cor ON f.corp_id = cor.corp_id
      WHERE f.first_card_applied_at IS NOT NULL
        AND f.first_card_issued_at IS NULL
        AND f.corp_id NOT IN (
          SELECT DISTINCT corp_id
          FROM \`gowid-prd.mart_limit_application.application_status\`
          WHERE application_type = '신규'
        )
        -- 카드사 부결/고위드 부결건 제외 (활성 FUEL 등은 유지)
        AND NOT EXISTS (
          SELECT 1
          FROM \`gowid-prd.mart_limit_application.application_status\` r
          WHERE r.corp_id = f.corp_id
            AND (r.card_co_rejected_at IS NOT NULL OR r.gowid_rejected_at IS NOT NULL)
        )
    ),

    combined AS (
      SELECT * FROM src_appstatus
      UNION ALL
      SELECT * FROM src_funnel
    ),

    deduped AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY corp_id, card_company_name ORDER BY card_application_submitted_at DESC) AS rn
      FROM combined
    ),

    final AS (
      SELECT
        corp_id, corp_name, card_company_name, latest_status, is_fuel, no_card_application,
        FORMAT_DATE('%Y-%m',
          COALESCE(
            card_application_submitted_at,
            signup_at,
            CAST(corp_created_at AS DATETIME)
          )
        ) AS cohort_month,
        CAST(COALESCE(
          card_application_submitted_at,
          signup_at,
          CAST(corp_created_at AS DATETIME)
        ) AS STRING) AS ref_date,
        card_co_pending_at
      FROM deduped
      WHERE rn = 1
    ),

    -- 영업일 계산 (주말 제외)
    with_biz_days AS (
      SELECT *,
        CASE
          WHEN card_co_pending_at IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM UNNEST(GENERATE_DATE_ARRAY(
              DATE(card_co_pending_at),
              CURRENT_DATE()
            )) AS d
            WHERE EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7) -- 일=1, 토=7
          ) - 1 -- pending_at 당일 제외
        END AS biz_days_since_pending
      FROM final
    )

    SELECT *,
      CASE
        WHEN cohort_month = FORMAT_DATE('%Y-%m', CURRENT_DATE()) THEN 'curr'
        ELSE 'prev3'
      END AS cohort
    FROM with_biz_days
    WHERE cohort_month >= FORMAT_DATE('%Y-%m', DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH))
    ORDER BY card_company_name, biz_days_since_pending DESC, corp_name
  `);

  const prev3 = [];
  const curr = [];

  for (const r of rows) {
    if (EXCLUDED_CORP_IDS.includes(Number(r.corp_id))) continue;
    const item = {
      corp_id: r.corp_id,
      corp_name: r.corp_name,
      card_company: r.card_company_name,
      is_fuel: r.is_fuel,
      no_card_application: r.no_card_application,
      cohort_month: r.cohort_month,
      ref_date: r.ref_date,
      biz_days: r.biz_days_since_pending,
    };
    (r.cohort === 'curr' ? curr : prev3).push(item);
  }

  return { prev3, curr };
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

function buildCorpLine(c, i) {
  const fuel = c.is_fuel ? ' (FUEL)' : '';
  const month = c.cohort_month ? ` (${c.cohort_month})` : '';
  const days = c.biz_days != null ? ` — ${c.biz_days}영업일` : '';
  return `${i + 1}. ${c.corp_name}${fuel}${month}${days}`;
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

function buildCardCompanySection(cardCompany, items, blocks) {
  const lines = items.map((c, i) => buildCorpLine(c, i));
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*[${cardCompany}] ${items.length}건*\n${lines.join('\n')}`,
    },
  });
}

function buildCohortSection(label, items, blocks) {
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
    buildCardCompanySection(cardCompany, groupItems, blocks);
  }
}

function buildBlocks(data) {
  const now = new Date();
  const currMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const m1 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const m3 = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const prev3Label = `${fmtMonth(m3)}~${fmtMonth(m1)}`;

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `카드 발급 대기 현황 (${now.toISOString().slice(0, 10)})` },
  });

  // ── 직전 3개월 ──
  buildCohortSection(
    `${prev3Label} 도입신청 → 카드사 접수 → 발급 미완료`,
    data.prev3,
    blocks
  );

  // ── 당월 ──
  buildCohortSection(
    `${fmtMonth(currMonth)} 도입신청 → 카드사 접수 → 발급 미완료`,
    data.curr,
    blocks
  );

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `영업일 = 카드사 심사 시작 후 경과일(주말 제외) | ${now.toISOString().slice(0, 16)}`,
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

  const blocks = buildBlocks(data);

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
  const BOT_USERNAME = '카드 발급 대기 알림';
  const todayKst = todayKstDate();
  try {
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
    text: `카드 발급 대기 현황: 직전3개월 ${data.prev3.length}건, 당월 ${data.curr.length}건`,
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
