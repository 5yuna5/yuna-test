#!/usr/bin/env node
/**
 * BizOps 마감/기한초과 미완료 알림 봇 (v1)
 *
 * - 매일 11:00 KST에 Linear "BizOps" 팀에서 dueDate가 오늘(KST) 이하이고
 *   미완료(state.type ∉ {completed, canceled})인 이슈를 모아 두 섹션으로 발송:
 *     🔴 기한 초과(dueDate < 오늘) — 가장 오래 지난 순, D+N 표기
 *     📌 오늘 마감(dueDate == 오늘) — 담당자별 그룹
 * - Slack 채널 C068EG4N7QA에 발송. 둘 다 0건이면 '✅ … 없음' 한 줄.
 * - 같은 KST 날짜 중복 발송은 멱등 가드로 방지(--force 제외).
 *
 * Slack 멘션 한계(v1): Linear assignee → Slack userid 매핑이 없어
 *   실제 @멘션(<@U…>)이 아니라 담당자 이름 텍스트만 표시한다. (v2 과제)
 *
 * Usage:
 *   node index.js              # 발송 (멱등 가드 적용)
 *   node index.js --dry-run    # Slack 미발송, 콘솔 미리보기만
 *   node index.js --force      # 멱등 가드 무시하고 강제 재발송
 */

require('dotenv').config({
  path: '/Users/gowid/yuna-test/pm/context/card/operations/crm-slack-bot/.env',
});

const https = require('https');
const { execSync } = require('child_process');
const { WebClient } = require('@slack/web-api');

// ─── Config ───
const CHANNEL = process.env.BIZOPS_CHANNEL_ID || 'C068EG4N7QA'; // 기본: 온보딩 퍼널별 고객 터치 알림. BIZOPS_CHANNEL_ID로 override(테스트용)
const BIZOPS_TEAM_ID = 'ba7b57b7-3f9e-4f81-b7f4-7e24ed38c074';
const BOT_USERNAME = 'BizOps 마감 알림';
const DONE_STATE_TYPES = ['completed', 'canceled'];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Date helpers (KST) ───
// 'sv-SE' 로케일이 YYYY-MM-DD 포맷을 반환함. Linear dueDate(date 문자열)와 직접 비교.
function todayKst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
function mmdd(ymd) {
  // ymd: 'YYYY-MM-DD' → 'MM/DD'
  const [, m, d] = ymd.split('-');
  return `${m}/${d}`;
}
// Slack 메시지 ts(Unix epoch 초) → KST 날짜 문자열
function tsToKstDate(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
// 두 'YYYY-MM-DD' 사이 경과 일수(toYmd - fromYmd). date-only ISO는 UTC 자정으로 파싱돼 정확한 일수 차.
function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000);
}

// ─── Linear GraphQL ───
let _apiKey = null;
function getLinearKey() {
  if (_apiKey) return _apiKey;
  try {
    _apiKey = execSync('security find-generic-password -s "linear-api-key" -w', {
      encoding: 'utf-8',
    }).trim();
    return _apiKey;
  } catch {
    throw new Error('[bizops-due-alert] Linear API 키를 keychain에서 찾을 수 없습니다 (서비스명: linear-api-key).');
  }
}

function linearQuery(query, variables = {}) {
  const apiKey = getLinearKey();
  const payload = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey, // Bearer 아님, 키 문자열 그대로
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`[bizops-due-alert] Linear HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            if (json.errors && json.errors.length) {
              reject(new Error(`[bizops-due-alert] Linear: ${json.errors[0].message}`));
            } else if (json.data) {
              resolve(json.data);
            } else {
              reject(new Error('[bizops-due-alert] Linear 응답에 data 없음'));
            }
          } catch (e) {
            reject(new Error(`[bizops-due-alert] Linear 파싱 오류: ${e.message}`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`[bizops-due-alert] ${e.message}`)));
    req.write(payload);
    req.end();
  });
}

// dueDate lte(오늘 이하) 필터 기반 1차 쿼리. 스키마에서 막히면 폴백으로 전환.
const QUERY_FILTERED = `
  query DueIssues($teamId: String!, $today: TimelessDateOrDuration!, $cursor: String) {
    team(id: $teamId) {
      issues(first: 100, after: $cursor, filter: { dueDate: { lte: $today } }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          identifier title url dueDate
          state { type }
          assignee { name displayName email }
          project { name }
          labels { nodes { name parent { name } } }
        }
      }
    }
  }
`;

// 폴백: dueDate 필터 없이 전량 페이지네이션 후 코드에서 today 매칭.
const QUERY_ALL = `
  query AllIssues($teamId: String!, $cursor: String) {
    team(id: $teamId) {
      issues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          identifier title url dueDate
          state { type }
          assignee { name displayName email }
          project { name }
          labels { nodes { name parent { name } } }
        }
      }
    }
  }
`;

async function paginate(query, baseVars) {
  const all = [];
  let cursor = null;
  let guard = 0; // 무한 루프 방지
  do {
    const data = await linearQuery(query, { ...baseVars, cursor });
    const conn = data.team && data.team.issues;
    if (!conn) break;
    all.push(...(conn.nodes || []));
    cursor = conn.pageInfo && conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    guard += 1;
  } while (cursor && guard < 50);
  return all;
}

async function fetchDueIssues(today) {
  let nodes;
  try {
    // 1차: dueDate lte(오늘 이하) 필터
    nodes = await paginate(QUERY_FILTERED, { teamId: BIZOPS_TEAM_ID, today });
  } catch (err) {
    // dueDate 필터가 스키마에서 막히면 폴백(전량 조회 후 코드 필터링)
    console.warn(`[bizops-due-alert] dueDate 필터 실패 → 폴백 전환: ${err.message}`);
    nodes = await paginate(QUERY_ALL, { teamId: BIZOPS_TEAM_ID });
  }
  // 이중 안전망: dueDate 존재 AND 오늘 이하(<=) AND 미완료
  return nodes.filter(
    (n) =>
      n &&
      n.dueDate &&
      n.dueDate <= today &&
      n.state &&
      !DONE_STATE_TYPES.includes(n.state.type)
  );
}

// ─── Block Kit ───
// 담당자 그룹/표시 키: Linear name(실제 이름) 우선 → displayName(handle) → "미배정".
function assigneeName(issue) {
  if (!issue.assignee) return '미배정';
  return issue.assignee.name || issue.assignee.displayName || '미배정';
}

// 담당자 멘션 렌더링.
// - Slack userId가 해결되면 실제 멘션 <@USERID>
// - 아니면 폴백으로 볼드 이름 *신현덕* (텍스트). 봇에 users:read.email 스코프가 생기면
//   코드 변경 없이 자동으로 실제 @멘션으로 승격됨.
function assigneeMention(issue, mentionMap) {
  const name = assigneeName(issue);
  if (name === '미배정') return '*미배정*';
  const email = issue.assignee && issue.assignee.email;
  const uid = email ? mentionMap.get(email) : null;
  return uid ? `<@${uid}>` : `*${name}*`;
}

// 고유 assignee.email → Slack userId 맵을 만든다(런당 캐시, 실패는 조용히 폴백).
// dry-run에서도 lookup 시도하되 실패는 null로 처리(절대 throw하지 않음).
async function resolveMentions(issues) {
  const map = new Map(); // email → userId | null
  const emails = [
    ...new Set(
      issues
        .map((i) => i.assignee && i.assignee.email)
        .filter((e) => !!e)
    ),
  ];
  for (const email of emails) {
    try {
      const res = await slack.users.lookupByEmail({ email });
      map.set(email, res && res.ok && res.user ? res.user.id : null);
    } catch (err) {
      // missing_scope / users_not_found 등 → 폴백(이름 텍스트). 죽지 않음.
      map.set(email, null);
    }
  }
  return map;
}

function labelSummary(issue) {
  const nodes = (issue.labels && issue.labels.nodes) || [];
  if (!nodes.length) return '';
  return nodes
    .map((l) => (l.parent && l.parent.name ? `${l.parent.name}/${l.name}` : l.name))
    .join(' / ');
}

function issueLine(issue, mentionMap, badge) {
  const parts = [`<${issue.url}|${issue.identifier}> ${issue.title}`];
  const labels = labelSummary(issue);
  if (labels) parts.push(`[${labels}]`);
  if (issue.project && issue.project.name) parts.push(`· ${issue.project.name}`);
  if (badge) parts.push(badge);
  parts.push(assigneeMention(issue, mentionMap));
  return parts.join('  ');
}

async function buildBlocks(issues, today) {
  const md = mmdd(today);

  if (issues.length === 0) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ 오늘(${md}) 마감·기한 초과 미완료 건 없음` },
      },
    ];
  }

  const mentionMap = await resolveMentions(issues);
  const hasRealMention = [...mentionMap.values()].some((v) => !!v);

  // dueDate 기준 분리: 기한 초과(< 오늘) / 오늘 마감(== 오늘)
  const overdue = issues
    .filter((i) => i.dueDate < today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)); // 오래 지난 순
  const dueToday = issues.filter((i) => i.dueDate === today);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `⏰ BizOps 마감 현황 — ${md}` },
    },
  ];

  // ── 🔴 기한 초과 (urgency 정렬, D+N 표기, 미그룹) ──
  if (overdue.length) {
    const lines = overdue.map((i) => `• ${issueLine(i, mentionMap, `\`D+${daysBetween(i.dueDate, today)}\``)}`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔴 기한 초과 (${overdue.length})*\n${lines.join('\n')}` },
    });
  }

  // ── 📌 오늘 마감 (담당자별 그룹, 미배정은 마지막) ──
  if (dueToday.length) {
    const groups = {};
    for (const issue of dueToday) {
      const key = assigneeName(issue);
      if (!groups[key]) groups[key] = [];
      groups[key].push(issue);
    }
    const names = Object.keys(groups).sort((a, b) => {
      if (a === '미배정') return 1;
      if (b === '미배정') return -1;
      return a.localeCompare(b, 'ko');
    });
    const todayLines = [`*📌 오늘 마감 (${dueToday.length})*`];
    for (const name of names) {
      const lines = groups[name].map((i) => `• ${issueLine(i, mentionMap)}`);
      todayLines.push(`*${name}* (${groups[name].length})\n${lines.join('\n')}`);
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: todayLines.join('\n') } });
  }

  const mentionNote = hasRealMention
    ? '담당자 실 @멘션'
    : '담당자 이름 텍스트(봇에 users:read.email 스코프 추가 시 실 @멘션 자동 승격)';
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `BizOps 마감/기한초과 미완료 · ${mentionNote} · ${new Date().toISOString().slice(0, 16)}`,
      },
    ],
  });

  return blocks;
}

function previewBlocks(blocks) {
  for (const b of blocks) {
    if (b.type === 'header') console.log(`=== ${b.text.text} ===`);
    else if (b.type === 'section') console.log(b.text.text);
    else if (b.type === 'context') console.log(`(${b.elements[0].text})`);
    else if (b.type === 'divider') console.log('---');
  }
}

// ─── Main ───
async function main() {
  const today = todayKst();
  console.log(`[bizops-due-alert] 오늘(KST)=${today}, BizOps 마감/기한초과 미완료 이슈 조회 중...`);

  const issues = await fetchDueIssues(today);
  const overdueCount = issues.filter((i) => i.dueDate < today).length;
  const todayCount = issues.filter((i) => i.dueDate === today).length;
  console.log(`[bizops-due-alert] 기한초과 ${overdueCount} · 오늘마감 ${todayCount} (총 ${issues.length}건)`);

  const blocks = await buildBlocks(issues, today);
  const summaryText =
    issues.length === 0
      ? `✅ 오늘(${mmdd(today)}) 마감·기한 초과 미완료 없음`
      : `⏰ BizOps 마감 — 기한초과 ${overdueCount} · 오늘 ${todayCount} (${mmdd(today)})`;

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Slack 미발송 — 메시지 미리보기:\n');
    previewBlocks(blocks);
    // 토큰 유효성만 확인(발송 안 함)
    try {
      const auth = await slack.auth.test();
      console.log(`\n[DRY RUN] Slack 토큰 유효 (team=${auth.team}, bot=${auth.user})`);
    } catch (err) {
      console.warn(`\n[DRY RUN] Slack auth.test 실패(발송 시 문제 가능): ${err.data?.error || err.message}`);
    }
    return;
  }

  // ── 멱등 가드: 오늘(KST) 이미 봇이 발송했으면 skip ──
  if (!FORCE) {
    try {
      const history = await slack.conversations.history({ channel: CHANNEL, limit: 30 });
      const dup = (history.messages || []).find((m) => {
        const nameMatch =
          m.username === BOT_USERNAME ||
          (m.bot_profile && m.bot_profile.name === BOT_USERNAME);
        if (!nameMatch) return false;
        return tsToKstDate(m.ts) === today;
      });
      if (dup) {
        console.log(`[bizops-due-alert] 이미 오늘(${today}) 발송됨, skip (--force로 강제 가능). ts=${dup.ts}`);
        process.exit(0);
      }
    } catch (err) {
      // not_in_channel이면 history도 막힘 → 발송 단계에서 graceful 처리하도록 진행
      if (err.data?.error === 'not_in_channel') {
        console.error(
          '[bizops-due-alert] 봇이 채널 C068EG4N7QA에 없습니다. 슬랙에서 `/invite @봇` 실행 후 재시도하세요.'
        );
        process.exit(0);
      }
      console.error(`[bizops-due-alert] 멱등 가드 조회 실패(계속 진행): ${err.data?.error || err.message}`);
    }
  }

  // ── 발송 ──
  try {
    await slack.chat.postMessage({
      channel: CHANNEL,
      username: BOT_USERNAME,
      icon_emoji: ':pushpin:',
      text: summaryText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    console.log(`[bizops-due-alert] 발송 완료 → ${CHANNEL}`);
  } catch (err) {
    if (err.data?.error === 'not_in_channel') {
      console.error(
        '[bizops-due-alert] 봇이 채널 C068EG4N7QA에 없습니다. 슬랙에서 `/invite @봇` 실행 후 재시도하세요.'
      );
      process.exit(0); // graceful, non-error
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('오류:', err.message);
  process.exit(1);
});
