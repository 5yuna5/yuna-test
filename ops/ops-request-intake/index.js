#!/usr/bin/env node
/**
 * 운영팀 업무요청 인테이크 — Slack Workflow → Linear BizOps(OPS) 이슈 자동 생성
 *
 * 흐름:
 *   Slack Workflow가 인테이크 채널에 남긴 구조화 메시지
 *     → 파싱 → BQ 법인 조회(신규/기존·정본 법인명) → Linear OPS 이슈 생성
 *     → 원본 스레드에 이슈 링크 회신
 *
 * 제목 규칙(고정 4토큰):
 *   [업무요청] {요청유형}_{신규|기존}_{제휴사}_{법인명}
 *   빈 값은 '해당없음'으로 채운다.
 *
 * 인증:
 *   Linear = keychain `linear-api-key`
 *   Slack  = ~/.claude.json 의 slack MCP 봇 토큰 (인테이크 채널 history 권한 보유)
 *   BQ     = ~/.claude/credentials/gowid-prd-bigquery-key.json
 *
 * Usage:
 *   node index.js               # 처리 + Linear 생성 + 스레드 회신
 *   node index.js --dry-run     # 파싱·조회·제목생성까지만, 쓰기 없음
 *   node index.js --limit 50    # 조회 메시지 수 (기본 200)
 *   node index.js --since 7d    # 조회 시작 시점 (기본 3d)
 *   OPS_INTAKE_CHANNEL=C0xxxx node index.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');
const { WebClient } = require('@slack/web-api');
const { BigQuery } = require('@google-cloud/bigquery');

// ─── Config ───
const INTAKE_CHANNEL = process.env.OPS_INTAKE_CHANNEL || 'C068EG4N7QA';
const OPS_TEAM_ID = 'ba7b57b7-3f9e-4f81-b7f4-7e24ed38c074';
const BACKLOG_STATE_ID = '0baa5dc0-c2b4-4544-8ecf-e58f182a4156';
const MARKER = '운영 업무 요청';
// 메시지에 노출될 봇 표시 이름. chat:write.customize 스코프로 앱 기본 이름을 덮어쓴다.
// (bizops-due-alert가 'BizOps 마감 알림'을 쓰는 것과 같은 방식)
const BOT_USERNAME = '서비스전략';
const BOT_ICON = ':inbox_tray:';
const BQ_KEY = path.join(os.homedir(), '.claude/credentials/gowid-prd-bigquery-key.json');

const LABELS = {
  '대기/내부': 'b0feb018-7af3-440f-9819-b14d93efe770',
  '대기/타팀': '58a66453-3884-4e77-acb1-4d9ff5af69f2',
  '대기/카드사': 'fbb3f776-24d0-42ba-8e02-892a2cc790c5',
  '대기/고객': '23311dc0-1e9a-4c1e-a485-a58c3dde3a70',
  '서비스/카드': '0b751f15-cfba-41d7-906f-8f8beabb6a8e',
  '서비스/성장금융': '7ff881f5-6979-4049-b6ac-033a2b791872',
  '서비스/지출관리': '9a0e25c0-fe73-4914-a2a5-0614a09fc868',
  '서비스/고객문의': '4ff058b5-aad7-4847-b5b9-4e6a2ad1d41f',
};

// 서비스 구분 → 라벨. 폼 선택지 문구가 바뀌어도 견디도록 패턴 매칭.
const SERVICE = [
  [/성장 ?금융|대출|여신실행/, '성장금융'],
  [/지출 ?관리|경비|영수증|ERP/, '지출관리'],
  [/고객 ?문의|CS|VOC/, '고객문의'],
  [/카드/, '카드'],
];

// 서비스별 담당자. slack=멘션·알림용, linear=이슈 담당자 배정용(OPS 팀 멤버여야 함).
// 둘 중 하나만 채워도 동작한다. 비워두면 멘션·배정을 건너뛴다.
// 진행 상태를 채널에서 한눈에 보이게 하는 이모지.
// started = Linear 담당자 배정됨 / done = Done / canceled = Canceled
// 이모지 리액션은 reactions:write 스코프가 필요해 현재 쓰지 않는다.
// 스레드 코멘트가 기본 경로다. 스코프가 생기면 OPS_USE_REACTIONS=true 로 켠다.
const USE_REACTIONS = process.env.OPS_USE_REACTIONS === 'true';
const REACTIONS = { started: 'arrow_forward', done: 'white_check_mark', canceled: 'no_entry_sign' };

// 스레드에 이미 보낸 알림인지 판별하는 문구. 상태 파일 없이 중복 발송을 막는 기준이다.
const NOTICE = {
  started: '처리를 시작했습니다',
  completed: '처리 완료되었습니다',
  canceled: '요청은 종료되었습니다',
};

// ─── 담당자 라우팅 ───
// 사람 사전. slack = 멘션용, linear = 배정·구독용.
const PEOPLE = {
  김소은: { slack: 'U0APKTBLYFK', linear: '4928ceba-7d54-4fc6-bb41-fa383f39f3b8' },
  김민지: { slack: 'U0831PJ9KE0', linear: '24b118ee-db73-44f2-b8ad-3659ddb9f453' },
  장혜원: { slack: 'U0B5MLD4SA0', linear: 'ae37bf75-25f8-4592-9c60-477bb52a489f' },
  황민영: { slack: 'U08BHAKLGP3', linear: '3da92996-a29d-477e-894c-0338051be77f' },
  김민우: { slack: 'U0B3WJ2N71T', linear: 'a8364964-b756-4184-9786-2dbfa18f8a82' },
  오유나: { slack: 'U09J53NDGV9', linear: '3c20eb70-9bf6-45fa-9fdf-b6d3ce2678a6' },
};

// 규칙은 위에서부터 평가해 처음 걸리는 하나가 이긴다. 순서가 곧 우선순위다.
// ctx = { service(정규화값), serviceRaw(폼 원문), type(요청유형), domain(업무영역), partner, text }
//   serviceRaw를 함께 보는 이유: SERVICE 매핑에 없는 새 선택지(BD 아젠다 등)가
//   서비스 칸에 들어와도 규칙이 잡아야 하기 때문
const ROUTES = [
  { name: '성장금융',        when: (c) => c.service === '성장금융',                    who: ['황민영'] },
  { name: 'BD 아젠다',       when: (c) => /BD ?아젠다|BD ?agenda/i.test(`${c.serviceRaw} ${c.type} ${c.domain}`), who: ['김민우', '오유나'] },
  { name: '고객문의',        when: (c) => c.service === '고객문의',                    who: ['장혜원'] },
  { name: '지출관리',        when: (c) => c.service === '지출관리',                    who: ['장혜원'] },
  { name: '가이드·CX',       when: (c) => /가이드|CX|고객 ?안내|응대/.test(`${c.type} ${c.domain}`), who: ['장혜원'] },
  { name: '카드-비씨·신한',  when: (c) => c.service === '카드' && /비씨|BC|신한/i.test(c.partner), who: ['김소은'] },
  { name: '카드-국민·롯데',  when: (c) => c.service === '카드' && /국민|KB|롯데/i.test(c.partner), who: ['김민지'] },
  { name: '카드-제휴사불명', when: (c) => c.service === '카드',                        who: ['김소은', '김민지'] },
];

/** 라우팅 결과 → { names, slack[], linear[], rule } */
function route(ctx) {
  const hit = ROUTES.find((r) => r.when(ctx));
  if (!hit) return { names: [], slack: [], linear: [], rule: null };
  const people = hit.who.map((n) => PEOPLE[n]).filter(Boolean);
  return {
    names: hit.who,
    slack: people.map((p) => p.slack).filter(Boolean),
    linear: people.map((p) => p.linear).filter(Boolean),
    rule: hit.name,
  };
}


// 요청유형 → 제목 축약형
const TYPE_SHORT = [
  [/제휴사|카드사/, '제휴사 확인'],
  [/정책.*(업데이트|신설|변경|개정)/, '정책 업데이트'],
  [/정책|가능여부/, '정책 확인'],
  [/진행상황|진척/, '진행상황 확인'],
  [/처리|작업/, '처리 요청'],
  [/고객 ?안내/, '고객 안내'],
  [/데이터|리스트|추출/, '데이터 추출'],
  [/오류|장애/, '장애 신고'],
  [/예외|승인/, '예외 승인'],
];

// 제휴사 폼 항목이 없을 때 본문에서 추론한다. 이름은 dw_dimension.card_company 표준명.
// (국민카드이지 KB국민카드가 아니다 — 마트와 조인할 때 조용히 어긋난다)
const PARTNER_HINT = [
  [/비씨|BC카드|\bBC\b/i, '비씨카드'],
  [/신한/, '신한카드'],
  [/롯데/, '롯데카드'],
  [/국민카드|KB국민|\bKB\b/i, '국민카드'],
  [/삼성카드/, '삼성카드'],
  [/하나은행|농협|기업은행|우리은행|국세청|등기소/, '은행·기관'],
  [/KPN|VAN|PG사/i, 'KPN·PG'],
];

// 고객영향 → priority / 영업일 기한 / 최초회신 목표
const IMPACT = [
  [/못 ?쓰|사용.*막|막혀/, { priority: 1, dueBiz: 0, sla: '30분', mins: 30 }],
  [/기다리|답변.*대기|회신해/, { priority: 2, dueBiz: 1, sla: '2시간', mins: 120 }],
  [/아직 안 ?알림|내부에서 먼저/, { priority: 3, dueBiz: 2, sla: '당일', eodBiz: 0 }],
  [/고객 ?건 ?아님|내부 ?업무/, { priority: 4, dueBiz: 5, sla: '2영업일', eodBiz: 2 }],
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SYNC_ONLY = args.includes('--sync-only');
const INTAKE_ONLY = args.includes('--intake-only');
const LIMIT = Number(argVal('--limit', '200'));
const SINCE = argVal('--since', '3d');

// ─── Helpers ───
function pick(table, value, dflt) {
  for (const [re, out] of table) if (re.test(value || '')) return out;
  return dflt;
}
function todayKst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
/** 영업일 n일 뒤 (토·일 건너뜀). n=0이면 오늘. */
function addBizDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
/** 사업자번호 10자리 → 000-00-00000 */
function fmtBrn(d) {
  return d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d;
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
/** KST 기준 'YYYY-MM-DD HH:MM' 파츠 */
function kstParts(d) {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const g = (t) => f.find((x) => x.type === t)?.value;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
}
/**
 * 최초 회신 목표 시각을 사람이 읽는 문장으로.
 *   분 단위(30분/2시간) → '오늘 15:20까지'
 *   영업일 단위(당일/2영업일) → '오늘 18:00까지' / '9/9(수) 18:00까지'
 */
function replyDeadline(impact) {
  const today = todayKst();
  if (impact.mins != null) {
    const t = kstParts(new Date(Date.now() + impact.mins * 60000));
    const day = t.ymd === today ? '오늘' : `${Number(t.ymd.slice(5, 7))}/${Number(t.ymd.slice(8, 10))}`;
    return `${day} ${t.hm}까지`;
  }
  const ymd = addBizDays(today, impact.eodBiz ?? 0);
  if (ymd === today) return '오늘 18:00까지';
  const d = new Date(ymd + 'T00:00:00Z');
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}(${DOW[d.getUTCDay()]}) 18:00까지`;
}
/** slack id 배열 → '<@U1> <@U2>' 멘션 문자열. 없으면 null */
function ownerMentions(owner) {
  const ids = [].concat(owner?.slack || []).filter(Boolean);
  return ids.length ? ids.map((i) => `<@${i}>`).join(' ') : null;
}

/** Slack user id → 실명 (Linear 설명문용). 실패 시 원본 유지 */
const _userCache = {};
async function resolveUser(v) {
  const raw = (v || '').trim();
  const m = /<@([A-Z0-9]+)(\|([^>]*))?>/.exec(raw);
  if (!m) return raw || '-';
  if (m[3]) return m[3];
  const id = m[1];
  if (_userCache[id]) return _userCache[id];
  try {
    const r = await slack.users.info({ user: id });
    const p = r.user?.profile || {};
    _userCache[id] = p.real_name || r.user?.name || id;
  } catch {
    _userCache[id] = id;
  }
  return _userCache[id];
}
/** '<@U123|이름>' 또는 '<@U123>' 에서 멘션 토큰만 추출. 없으면 null */
function mentionOf(v) {
  const m = /<@([A-Z0-9]+)(\|[^>]*)?>/.exec(v || '');
  return m ? `<@${m[1]}>` : null;
}
function sinceToTs(s) {
  const m = /^(\d+)([dh])$/.exec(s);
  const n = m ? Number(m[1]) : 3;
  const unit = m && m[2] === 'h' ? 3600 : 86400;
  return String(Math.floor(Date.now() / 1000) - n * unit);
}

// ─── 멱등성: Linear를 상태 저장소로 쓴다 ───
// 파일 state는 GHA처럼 매번 새 머신에서 도는 환경에서 유지되지 않는다.
// 이슈 본문에 박아둔 Slack 스레드 링크가 곧 "이미 접수한 요청"의 증거다.

/** 이슈 본문에서 Slack 메시지 ts를 뽑는다. .../archives/C123/p1788761486073129 → '1788761486.073129' */
function tsFromDescription(desc, channel) {
  const m = new RegExp(`archives/${channel}/p(\\d{10})(\\d{6})`).exec(desc || '');
  return m ? `${m[1]}.${m[2]}` : null;
}

/** 최근 N일 내 생성된 OPS 업무요청 이슈를 ts → 이슈 맵으로 */
async function knownFromLinear(channel, days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const d = await linear(
    `query($t:DateTimeOrDuration){
       issues(filter:{ team:{ key:{ eq:"OPS" } }, createdAt:{ gte:$t } }, first:250){
         nodes{ id identifier url description state{ name type } assignee{ name } }
       }
     }`,
    { t: since }
  );
  const map = new Map();
  for (const n of d.issues?.nodes || []) {
    const ts = tsFromDescription(n.description, channel);
    if (ts) map.set(ts, n);
  }
  return map;
}

// ─── Slack ───
// 운영 계정은 **서비스전략봇**(구 crm-history-bot). bizops-due-alert와 같은 .env를 쓴다.
// 필요한 스코프: channels:history · chat:write · reactions:write · users:read
const CRM_ENV = '/Users/gowid/yuna-test/pm/context/card/operations/crm-slack-bot/.env';
function slackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  try {
    const m = /^SLACK_BOT_TOKEN=(.+)$/m.exec(fs.readFileSync(CRM_ENV, 'utf-8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  // 폴백: 로컬 MCP 봇 토큰
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
  const tok = cfg?.mcpServers?.slack?.env?.SLACK_BOT_TOKEN;
  if (!tok) throw new Error('[intake] Slack 봇 토큰을 찾을 수 없습니다 (crm-slack-bot/.env 또는 .claude.json).');
  return tok;
}
const slack = new WebClient(slackToken());

// ─── Linear ───
let _key = null;
function linearKey() {
  if (_key) return _key;
  // GHA 등 CI에서는 env, 로컬에서는 keychain
  if (process.env.LINEAR_API_KEY) return (_key = process.env.LINEAR_API_KEY.trim());
  _key = execSync('security find-generic-password -s "linear-api-key" -w', { encoding: 'utf-8' }).trim();
  return _key;
}
function linear(query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          Authorization: linearKey(),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.errors) return reject(new Error(JSON.stringify(j.errors)));
            resolve(j.data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── 파서 ───
/**
 * Workflow 메시지 포맷:
 *   📥 운영 업무 요청
 *   요청자 :: ...
 *   요청유형 :: ...
 *   업무영역 :: ...
 *   제휴사 :: ...
 *   법인 :: ...
 *   고객영향 :: ...
 *   ━ 요청내용 ━
 *   ...
 *   ━ 완료기준 ━
 *   ...
 *   ━ 참고 ━
 *   ...
 */
function parseRequest(text) {
  const clean = (text || '').replace(/\*/g, '');
  const out = { kv: {}, sec: {} };
  let cur = null;
  let buf = [];
  const push = (k, v) => {
    if (!k) return;
    const t = v.join('\n').trim();
    if (t) out.kv[k] = (out.kv[k] ? out.kv[k] + '\n' : '') + t;
  };

  for (const raw of clean.split('\n')) {
    const line = raw.trim();

    // (a) 섹션 구분자 — '— 요청내용 —', '━ 요청내용 ━', '--- 요청내용 ---'
    const sec = /^[—–━─=_-]{1,4}\s*(.+?)\s*[—–━─=_-]{1,4}$/.exec(line);
    if (sec && normLabel(sec[1])) {
      push(cur, buf); buf = [];
      cur = normLabel(sec[1]);
      continue;
    }
    // (b) '키 :: 값'
    const kv = /^(.{1,24}?)\s*::\s*(.*)$/.exec(line);
    if (kv && normLabel(kv[1])) {
      push(cur, buf); buf = [];
      cur = normLabel(kv[1]);
      buf = [kv[2]];
      continue;
    }
    // (c) '라벨 값' 같은 줄 — 가장 긴 라벨 프리픽스를 찾는다.
    //     예) '요청 유형 제휴사 확인·요청(...)' → 라벨 '요청 유형' / 값 나머지
    const hit = matchLabelPrefix(line);
    if (hit) {
      push(cur, buf); buf = [];
      cur = hit.label;
      buf = hit.rest ? [hit.rest] : [];
      continue;
    }
    // (d) 그 외는 현재 필드의 값
    if (cur) buf.push(raw);
  }
  push(cur, buf);

  for (const k of ['요청내용', '완료기준', '참고']) if (out.kv[k]) out.sec[k] = out.kv[k];
  return out;
}

/**
 * 줄 앞부분에서 가장 긴 라벨을 찾는다.
 * 라벨이 '요청 유형'처럼 공백을 품을 수 있어 어절을 하나씩 늘려가며 확인한다.
 * 라벨만 있고 값이 없으면 rest = '' (다음 줄들이 값이 된다).
 */
function matchLabelPrefix(line) {
  if (!line) return null;
  const parts = line.split(/\s+/);
  let best = null;
  for (let i = 1; i <= Math.min(parts.length, 5); i++) {
    const label = normLabel(parts.slice(0, i).join(' '));
    if (label) best = { label, rest: parts.slice(i).join(' ').trim() };
  }
  return best;
}

/** 라벨 문구를 표준 필드명으로. 못 알아보면 null (= 값 줄로 취급) */
function normLabel(v) {
  const t = (v || '').trim().replace(/[:：.。\s]+$/, '').replace(/\s+/g, '');
  if (!t) return null;
  const T = [
    [/^(법인명?|법인명또는사업자번호|사업자번호|법인식별자)$/, '법인'],
    [/^(서비스|서비스구분|어떤서비스건인가요|서비스명)$/, '서비스'],
    [/^(요청유형|무엇을해드릴까요)$/, '요청유형'],
    [/^(업무영역|어떤건인가요)$/, '업무영역'],
    [/^(제휴사|관련제휴사)$/, '제휴사'],
    [/^(고객영향|고객영향도)$/, '고객영향'],
    [/^(요청자|신청자)$/, '요청자'],
    [/^(요청내용|상세요청사항|상세요청사항을입력해주세요|상세내용|내용|요청사항)$/, '요청내용'],
    [/^(완료기준|원하는결과|무엇이되면끝인가요)$/, '완료기준'],
    [/^(참고|참고링크|참고자료|참고링크자료)$/, '참고'],
  ];
  for (const [re, name] of T) if (re.test(t)) return name;
  return null;
}

// ─── BQ 법인 조회 ───
let _bq = null;
function bq() {
  if (!_bq) _bq = new BigQuery({ projectId: 'gowid-prd', keyFilename: BQ_KEY, location: 'asia-northeast3' });
  return _bq;
}
/**
 * 법인 식별자(사업자번호 또는 법인명) → { corpName, brn, segment, issuedCC }
 * segment: '신규' | '기존' | '미확인'
 */
async function lookupCorp(input) {
  const raw = (input || '').trim();
  if (!raw || /^(내부|해당없음|-|없음|n\/?a)$/i.test(raw)) {
    return { corpName: '해당없음', brn: null, segment: '해당없음', issuedCC: null, internal: true };
  }
  const digits = raw.replace(/[^0-9]/g, '');
  const byBrn = digits.length === 10;
  // 법인명 정규화: 정규식 이스케이프 함정을 피해 명시적 치환만 쓴다.
  // (r"[\s주식회사...]" 문자클래스는 '주'·'사' 같은 낱글자를 아무 데서나 지워
  //  '주식회사 사조' → '조' 처럼 망가진다. 토큰 단위 REPLACE가 정확하다.)
  // 법인명 정규화. 표기 변형이 실제로 다양해서 열거가 아니라 '남길 것만 남기는' 방식을 쓴다.
  //  · 전각 괄호 （주） 가 실존한다 (（주）메디클러스) — ASCII (주)만 지우면 매칭 실패
  //  · 낱글자 제거(문자클래스)는 '주식회사 사조' → '조' 처럼 망가뜨리므로 토큰 단위로 지운다
  //  · 남은 공백·기호·구두점은 전부 떨어낸다
  const NORM = (col) => `
    REGEXP_REPLACE(
      REGEXP_REPLACE(UPPER(${col}),
        r'[（(][주유][）)]|㈜|㈲|주식회사|유한회사|유한책임회사', ''),
      r'[^가-힣A-Z0-9]', '')`;
  // 2단 매칭: 완전일치 우선, 없으면 접두일치 폴백.
  //  등록명에 영문 별칭이 붙는 경우가 실존한다 — '주식회사 솔라스틱(Solarstic)'.
  //  정규화하면 '솔라스틱SOLARSTIC'이 되어 '솔라스틱'과 완전일치하지 않는다.
  //  접두일치는 결과가 정확히 1건일 때만 채택해 오매칭을 막는다.
  const sql = `
    WITH q AS ( SELECT ${NORM('@q')} AS qn ),
    corp AS (
      SELECT c.idx, c.resCompanyNm AS corp_name,
             REPLACE(c.resCompanyIdentityNo,'-','') AS brn,
             IF(${NORM('c.resCompanyNm')} = q.qn, 0, 1) AS match_rank
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c, q
      WHERE ${byBrn
        ? "REPLACE(c.resCompanyIdentityNo,'-','') = @q"
        : `LENGTH(q.qn) >= 2 AND (
             ${NORM('c.resCompanyNm')} = q.qn
             OR STARTS_WITH(${NORM('c.resCompanyNm')}, q.qn)
           )`}
    ),
    iss AS (
      SELECT ci.idxCorp,
             COUNTIF(ci.issuedAt IS NOT NULL) AS issued_cnt,
             STRING_AGG(DISTINCT CASE WHEN ci.issuedAt IS NOT NULL THEN ci.cardCompany END) AS issued_cc
      FROM \`gowid-prd.ods_stream_gowid.CardIssuanceInfo\` ci
      WHERE IFNULL(ci.isDeleted,0)=0 OR ci.issuedAt IS NOT NULL
      GROUP BY ci.idxCorp
    )
    SELECT corp.corp_name, corp.brn, corp.match_rank,
           IFNULL(iss.issued_cnt,0) AS issued_cnt,
           iss.issued_cc
    FROM corp LEFT JOIN iss ON iss.idxCorp = corp.idx
    ORDER BY corp.match_rank
    LIMIT 10`;
  try {
    const [all] = await bq().query({ query: sql, params: { q: byBrn ? digits : raw } });
    const exact = all.filter((r) => Number(r.match_rank) === 0);
    // 완전일치가 있으면 그것만, 없으면 접두일치 후보 전체를 본다.
    const rows = exact.length ? exact : all;
    if (rows.length !== 1) {
      // 0건(미등록) 또는 2건 이상(동명이인) → 판정 보류, 입력값 그대로 사용
      return { corpName: raw, brn: byBrn ? digits : null, segment: '미확인', issuedCC: null, ambiguous: rows.length > 1 };
    }
    const r = rows[0];
    return {
      corpName: r.corp_name || raw,
      brn: r.brn,
      segment: Number(r.issued_cnt) > 0 ? '기존' : '신규',
      issuedCC: r.issued_cc || null,
    };
  } catch (e) {
    console.error('  ⚠️ BQ 조회 실패:', e.message.split('\n')[0]);
    return { corpName: raw, brn: byBrn ? digits : null, segment: '미확인', issuedCC: null };
  }
}

// ─── 이슈 조립 ───
function buildIssue(p, corp, permalink, requester) {
  const typeShort = pick(TYPE_SHORT, p.kv['요청유형'], '기타 요청');
  const impact = pick(IMPACT, p.kv['고객영향'], { priority: 3, dueBiz: 2, sla: '당일' });
  // 제휴사: 폼 값 우선. 없으면 요청 텍스트에서 추론(폼에 항목이 생기면 자연히 폼 값이 이긴다).
  const partnerRaw = (p.kv['제휴사'] || '').trim();
  const hintSource = [p.kv['법인'], p.kv['요청내용'], p.kv['업무영역'], p.kv['요청유형']].filter(Boolean).join(' ');
  const partner = partnerRaw || pick(PARTNER_HINT, hintSource, null) || '해당없음';

  // 제목 넷째 칸: 조회된 법인명 → 없으면 업무영역 → 없으면 해당없음.
  // 조회 실패(미확인)한 입력값은 식별자로 못 쓰므로 제목에 넣지 않고 본문에만 남긴다.
  // 업무영역·요청유형은 복수 선택이 가능해 'A, B' 로 들어온다.
  // 제목에 쓸 때는 첫 값만 (제목이 길어지면 보드에서 읽히지 않는다)
  const firstOf = (v) => (v || '').split(/[,،·]?\s*,\s*/)[0].trim();
  const domain = firstOf(p.kv['업무영역']);
  const resolved = corp.segment === '기존' || corp.segment === '신규';
  const subject = resolved ? corp.corpName : domain || '해당없음';
  const segment = resolved ? corp.segment : '해당없음';

  const service = pick(SERVICE, p.kv['서비스'], null);
  const owner = route({
    service,
    serviceRaw: p.kv['서비스'] || '',
    type: p.kv['요청유형'] || '',
    domain: p.kv['업무영역'] || '',
    partner,
    text: p.kv['요청내용'] || '',
  });
  const linearIds = owner.linear;
  const title = `[업무요청] ${typeShort}_${segment}_${partner}_${subject}`;

  const waitLabel =
    typeShort === '제휴사 확인' ? '대기/카드사' : typeShort === '장애 신고' ? '대기/타팀' : '대기/내부';
  const labelIds = [LABELS[waitLabel], service ? LABELS[`서비스/${service}`] : null].filter(Boolean);

  const lines = [
    `**서비스** ${p.kv['서비스'] || '-'}`,
    `**요청자** ${requester || p.kv['요청자'] || '-'}`,
    resolved
      ? `**법인** ${corp.corpName}${corp.brn ? ` \`${fmtBrn(corp.brn)}\`` : ''}${corp.segment === '기존' && corp.issuedCC ? ` · 보유 ${corp.issuedCC}` : ''}`
      : `**법인** ${corp.internal ? '내부 건 (고객 특정 없음)' : `입력값 \`${corp.corpName}\` — 법인 조회 안 됨`}`,
    `**요청유형** ${p.kv['요청유형'] || '-'}`,
    `**업무영역** ${p.kv['업무영역'] || '-'}`,
    `**제휴사** ${partner}`,
    `**고객 영향** ${p.kv['고객영향'] || '-'} · 최초 회신 목표 **${replyDeadline(impact)}** (${impact.sla})`,
    '',
    '### 요청 내용',
    p.sec['요청내용'] || '-',
    '',
    '### 완료 기준',
    p.sec['완료기준'] || '-',
  ];
  if (p.sec['참고']) lines.push('', '### 참고', p.sec['참고']);
  if (corp.segment === '미확인') {
    lines.push('', `> ⚠️ \`${corp.corpName}\` 로는 법인을 찾지 못했습니다${corp.ambiguous ? ' (동명 법인 2건 이상)' : ''}.`);
    lines.push('> 고객 건이라면 사업자번호로 다시 확인하고, 내부 건이라면 그대로 두셔도 됩니다.');
  }
  lines.push('', '---', `🔗 [Slack 원본 스레드](${permalink})`, '_Slack 업무요청 Workflow 자동 생성_');

  return {
    title,
    description: lines.join('\n'),
    priority: impact.priority,
    dueDate: addBizDays(todayKst(), impact.dueBiz),
    labelIds,
    assigneeId: linearIds[0],
    subscriberIds: linearIds.length > 1 ? linearIds : undefined,
    _meta: { typeShort, waitLabel, service, owner, routeRule: owner.rule, names: owner.names, sla: impact.sla, deadline: replyDeadline(impact), partner, corp },
  };
}

// ─── 상태 동기화 (Linear → Slack 리액션) ───
let _reactionScopeMissing = false;
/** 리액션 추가. 이미 달려 있으면 성공으로 본다. 스코프가 없으면 false를 돌려주고 이후 호출을 건너뛴다. */
async function react(ts, name) {
  if (!USE_REACTIONS || !name || _reactionScopeMissing) return false;
  try {
    await slack.reactions.add({ channel: INTAKE_CHANNEL, timestamp: ts, name });
    return true;
  } catch (e) {
    const err = e?.data?.error;
    if (err === 'already_reacted') return true;
    if (err === 'missing_scope' || err === 'not_allowed_token_type') {
      _reactionScopeMissing = true;
      console.error(`  ⚠️ 리액션 스코프 없음(reactions:write) — 이모지 대신 스레드 코멘트로 대체합니다.`);
      return false;
    }
    console.error(`  ⚠️ 리액션 실패(${name}):`, err || e.message);
    return false;
  }
}

/**
 * Linear 상태를 읽어 원본 메시지에 이모지(또는 스레드 코멘트)를 반영한다.
 * 중복 발송 방지는 상태 파일이 아니라 **스레드에 이미 그 알림이 있는지**로 판단한다.
 * (GHA처럼 매번 새 머신에서 도는 환경에서도 안전)
 */
async function syncStates(known) {
  const targets = [...known.entries()].filter(([, iss]) =>
    ['started', 'completed', 'canceled'].includes(iss.state?.type)
  );
  if (!targets.length) {
    console.log('[sync] 알릴 상태 변화 없음');
    return 0;
  }

  let changed = 0;
  for (const [ts, iss] of targets) {
    const type = iss.state.type;
    let thread;
    try {
      thread = await slack.conversations.replies({ channel: INTAKE_CHANNEL, ts, limit: 40 });
    } catch (e) {
      console.error(`  ⚠️ ${iss.identifier} 스레드 조회 실패:`, e?.data?.error || e.message);
      continue;
    }
    const msgs = thread.messages || [];
    const body = msgs.map((m) => m.text || '').join('\n');
    const reactions = (msgs[0]?.reactions || []).map((r) => r.name);
    const already = (kind) =>
      body.includes(NOTICE[kind]) ||
      reactions.includes(REACTIONS[kind === 'completed' ? 'done' : kind]);

    const post = async (text, emoji) => {
      await react(ts, emoji);
      await slack.chat.postMessage({
        channel: INTAKE_CHANNEL, thread_ts: ts, unfurl_links: false,
        username: BOT_USERNAME, icon_emoji: BOT_ICON, text,
      });
      changed++;
    };

    if (type === 'started' && !already('started')) {
      await post(
        `▶️ *${iss.assignee?.name || '담당자'}* 님이 ${NOTICE.started}. (<${iss.url}|${iss.identifier}>)`,
        REACTIONS.started
      );
      console.log(`  ▶️ ${iss.identifier} 시작 — ${iss.assignee?.name || '미배정'}`);
    }

    if (type === 'completed' && !already('completed')) {
      await post(`✅ ${NOTICE.completed}. (<${iss.url}|${iss.identifier}>)`, REACTIONS.done);
      console.log(`  ✅ ${iss.identifier} ${iss.state.name}`);
    }

    if (type === 'canceled' && !already('canceled')) {
      await post(`🚫 이 ${NOTICE.canceled}. 사유는 <${iss.url}|${iss.identifier}>에 있습니다.`, REACTIONS.canceled);
      console.log(`  🚫 ${iss.identifier} ${iss.state.name}`);
    }
  }
  console.log(`[sync] 검사 ${targets.length}건 · 알림 ${changed}건`);
  return changed;
}

// ─── Main ───
async function main() {
  console.log(`[intake] 채널 ${INTAKE_CHANNEL} · since ${SINCE}${DRY_RUN ? ' · DRY RUN' : ''}`);
  // Linear가 곧 상태 저장소다. 이미 접수한 요청의 Slack ts를 여기서 얻는다.
  const known = await knownFromLinear(INTAKE_CHANNEL);
  console.log(`[intake] Linear 기존 접수 ${known.size}건 인식`);

  if (SYNC_ONLY) {
    await syncStates(known);
    return;
  }

  // ⚠️ oldest를 넓게 주면 Slack이 그 구간의 '가장 오래된' N건을 돌려줘 최신 메시지가 누락된다.
  //    (--since 30d에서 실제로 0건이 나왔다) → oldest 없이 최신 N건을 받고 클라이언트에서 자른다.
  const cutoff = Number(sinceToTs(SINCE));
  const hist = await slack.conversations.history({ channel: INTAKE_CHANNEL, limit: LIMIT });
  // 판별 3중화. Workflow Builder 메시지는 본문에 워크플로 이름이 없을 수 있고,
  // username/bot_profile도 앱 설정에 따라 비어 온다. 그래서 구조 판별을 최후 보루로 둔다.
  const isBot = (m) => Boolean(m.bot_id) || m.subtype === 'bot_message' || Boolean(m.app_id);
  const isTarget = (m) => {
    // Workflow는 항상 봇으로 게시된다. 사람 글은 어떤 경우에도 후보가 아니다.
    // (공지문에 '운영 업무 요청'이 들어가는 것만으로 잡히던 오탐을 막는다)
    if (!isBot(m)) return false;
    const byMarker =
      (m.text || '').includes(MARKER) ||
      (m.username || '').includes(MARKER) ||
      (m.bot_profile?.name || '').includes(MARKER);
    if (byMarker) return true;
    const k = parseRequest(m.text).kv;
    return Boolean(k['요청유형'] && k['서비스'] && k['법인']);
  };
  const targets = (hist.messages || [])
    .filter((m) => Number(m.ts) >= cutoff)
    .filter(isTarget)
    .filter((m) => !known.has(m.ts))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  console.log(`[intake] 신규 대상 ${targets.length}건`);
  if (!targets.length) {
    if (!DRY_RUN && !INTAKE_ONLY) await syncStates(known);
    return;
  }

  let created = 0;
  for (const m of targets) {
    const p = parseRequest(m.text);
    if (!p.kv['요청유형']) {
      console.log(`  · ${m.ts} 건너뜀 (요청유형 없음 — 포맷 불일치)`);
      continue;
    }
    const corp = await lookupCorp(p.kv['법인']);
    let permalink = `https://gowid.slack.com/archives/${INTAKE_CHANNEL}/p${m.ts.replace('.', '')}`;
    try {
      const pl = await slack.chat.getPermalink({ channel: INTAKE_CHANNEL, message_ts: m.ts });
      if (pl.permalink) permalink = pl.permalink;
    } catch {}

    const requesterName = await resolveUser(p.kv['요청자']);
    const issue = buildIssue(p, corp, permalink, requesterName);
    console.log(`\n  ── ${m.ts}`);
    console.log(`  제목: ${issue.title}`);
    console.log(`  P${issue.priority} · 기한 ${issue.dueDate} · ${issue._meta.waitLabel} · 최초회신 ${issue._meta.sla}`);
    console.log(`  담당: ${(issue._meta.names || []).join(', ') || '미지정'}  [규칙: ${issue._meta.routeRule || '없음'}]`);

    if (DRY_RUN) continue;

    const data = await linear(
      `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ id identifier url } } }`,
      {
        i: {
          teamId: OPS_TEAM_ID,
          stateId: BACKLOG_STATE_ID,
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          dueDate: issue.dueDate,
          labelIds: issue.labelIds,
          assigneeId: issue.assigneeId,
          subscriberIds: issue.subscriberIds,
        },
      }
    );
    const iss = data.issueCreate.issue;
    console.log(`  ✅ ${iss.identifier} ${iss.url}`);

    const who = mentionOf(p.kv['요청자']);
    const receipt = [
      `${who ? who + ' ' : ''}✅ *요청이 접수되었습니다*`,
      '',
      `*접수번호*　<${iss.url}|${iss.identifier}>`,
      `*분류*　　　${issue._meta.service ? issue._meta.service + ' · ' : ''}${issue._meta.typeShort} · ${corp.segment} · ${issue._meta.partner}`,
      `*법인*　　　${corp.corpName}${corp.brn ? ` (${fmtBrn(corp.brn)})` : ''}`,
      `*최초 회신 목표*　*${issue._meta.deadline}*`,
      ...(ownerMentions(issue._meta.owner)
        ? ['', `담당 ${ownerMentions(issue._meta.owner)} 님이 확인합니다.`]
        : ['', '담당자가 지정되면 이 스레드로 안내드립니다.']),
    ].join('\n');
    await slack.chat.postMessage({
      channel: INTAKE_CHANNEL,
      thread_ts: m.ts,
      text: receipt,
      unfurl_links: false,
      username: BOT_USERNAME,
      icon_emoji: BOT_ICON,
    });

    known.set(m.ts, { ...iss, description: issue.description, state: { name: 'Backlog', type: 'backlog' }, assignee: null });
    created++;
  }

  if (!DRY_RUN && !INTAKE_ONLY) await syncStates(known);
  console.log(`\n[intake] 완료 — 생성 ${created}건`);
}

main().catch((e) => {
  console.error('[intake] 실패:', e.message);
  process.exit(1);
});
