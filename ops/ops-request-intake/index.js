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
const MARKER = '신규 운영 요청';
const STATE_FILE = path.join(__dirname, 'state', 'processed.json');
const BQ_KEY = path.join(os.homedir(), '.claude/credentials/gowid-prd-bigquery-key.json');

const LABELS = {
  '대기/내부': 'b0feb018-7af3-440f-9819-b14d93efe770',
  '대기/타팀': '58a66453-3884-4e77-acb1-4d9ff5af69f2',
  '대기/카드사': 'fbb3f776-24d0-42ba-8e02-892a2cc790c5',
  '대기/고객': '23311dc0-1e9a-4c1e-a485-a58c3dde3a70',
};

// 요청유형 → 제목 축약형
const TYPE_SHORT = [
  [/제휴사|카드사/, '제휴사 확인'],
  [/정책|가능여부/, '정책 확인'],
  [/진행상황|진척/, '진행상황 확인'],
  [/처리|작업/, '처리 요청'],
  [/고객 ?안내/, '고객 안내'],
  [/데이터|리스트|추출/, '데이터 추출'],
  [/오류|장애/, '장애 신고'],
  [/예외|승인/, '예외 승인'],
];

// 고객영향 → priority / 영업일 기한 / 최초회신 목표
const IMPACT = [
  [/못 ?쓰|사용.*막|막혀/, { priority: 1, dueBiz: 0, sla: '30분' }],
  [/기다리|답변.*대기|회신해/, { priority: 2, dueBiz: 1, sla: '2시간' }],
  [/아직 안 ?알림|내부에서 먼저/, { priority: 3, dueBiz: 2, sla: '당일' }],
  [/고객 ?건 ?아님|내부 ?업무/, { priority: 4, dueBiz: 5, sla: '2영업일' }],
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
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
function sinceToTs(s) {
  const m = /^(\d+)([dh])$/.exec(s);
  const n = m ? Number(m[1]) : 3;
  const unit = m && m[2] === 'h' ? 3600 : 86400;
  return String(Math.floor(Date.now() / 1000) - n * unit);
}

// ─── State (멱등성) ───
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { processed: {} };
  }
}
function saveState(st) {
  // 60일 지난 항목은 정리
  const cutoff = Date.now() / 1000 - 60 * 86400;
  for (const k of Object.keys(st.processed)) if (Number(k) < cutoff) delete st.processed[k];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

// ─── Slack ───
function slackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
  const tok = cfg?.mcpServers?.slack?.env?.SLACK_BOT_TOKEN;
  if (!tok) throw new Error('[intake] Slack 봇 토큰을 찾을 수 없습니다 (.claude.json mcpServers.slack).');
  return tok;
}
const slack = new WebClient(slackToken());

// ─── Linear ───
let _key = null;
function linearKey() {
  if (_key) return _key;
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
 *   📥 신규 운영 요청
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
  for (const raw of clean.split('\n')) {
    const line = raw.trim();
    const sec = /^[━─=-]{1,3}\s*(.+?)\s*[━─=-]{1,3}$/.exec(line);
    if (sec) {
      cur = sec[1].replace(/\s/g, '');
      out.sec[cur] = [];
      continue;
    }
    const kv = /^(.{1,12}?)\s*::\s*(.*)$/.exec(line);
    if (kv && !cur) {
      out.kv[kv[1].replace(/\s/g, '')] = kv[2].trim();
      continue;
    }
    if (cur) out.sec[cur].push(raw);
  }
  for (const k of Object.keys(out.sec)) out.sec[k] = out.sec[k].join('\n').trim();
  return out;
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
  const sql = `
    WITH corp AS (
      SELECT c.idx, c.resCompanyNm AS corp_name,
             REPLACE(c.resCompanyIdentityNo,'-','') AS brn
      FROM \`gowid-prd.ods_stream_gowid.Corp\` c
      WHERE ${byBrn
        ? 'REPLACE(c.resCompanyIdentityNo,"-","") = @q'
        : 'REGEXP_REPLACE(c.resCompanyNm, r"[\\\\s()주식회사㈜\\\\(\\\\)]", "") = REGEXP_REPLACE(@q, r"[\\\\s()주식회사㈜\\\\(\\\\)]", "")'}
    ),
    iss AS (
      SELECT ci.idxCorp,
             COUNTIF(ci.issuedAt IS NOT NULL) AS issued_cnt,
             STRING_AGG(DISTINCT CASE WHEN ci.issuedAt IS NOT NULL THEN ci.cardCompany END) AS issued_cc
      FROM \`gowid-prd.ods_stream_gowid.CardIssuanceInfo\` ci
      WHERE IFNULL(ci.isDeleted,0)=0 OR ci.issuedAt IS NOT NULL
      GROUP BY ci.idxCorp
    )
    SELECT corp.corp_name, corp.brn,
           IFNULL(iss.issued_cnt,0) AS issued_cnt,
           iss.issued_cc
    FROM corp LEFT JOIN iss ON iss.idxCorp = corp.idx
    LIMIT 5`;
  try {
    const [rows] = await bq().query({ query: sql, params: { q: byBrn ? digits : raw } });
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
  const partner = (p.kv['제휴사'] || '').trim() || '해당없음';
  const title = `[업무요청] ${typeShort}_${corp.segment}_${partner}_${corp.corpName}`;

  const waitLabel =
    typeShort === '제휴사 확인' ? '대기/카드사' : typeShort === '장애 신고' ? '대기/타팀' : '대기/내부';

  const lines = [
    `**요청자** ${requester || p.kv['요청자'] || '-'}`,
    `**법인** ${corp.corpName}${corp.brn ? ` \`${fmtBrn(corp.brn)}\`` : ''}${corp.segment === '기존' && corp.issuedCC ? ` · 보유 ${corp.issuedCC}` : ''}`,
    `**요청유형** ${p.kv['요청유형'] || '-'}`,
    `**업무영역** ${p.kv['업무영역'] || '-'}`,
    `**제휴사** ${partner}`,
    `**고객 영향** ${p.kv['고객영향'] || '-'} · 최초 회신 목표 **${impact.sla}**`,
    '',
    '### 요청 내용',
    p.sec['요청내용'] || '-',
    '',
    '### 완료 기준',
    p.sec['완료기준'] || '-',
  ];
  if (p.sec['참고']) lines.push('', '### 참고', p.sec['참고']);
  if (corp.segment === '미확인') {
    lines.push('', `> ⚠️ 법인 자동조회 실패${corp.ambiguous ? '(동명 법인 2건 이상)' : '(미등록)'} — 신규/기존을 운영팀이 보정해주세요.`);
  }
  lines.push('', '---', `🔗 [Slack 원본 스레드](${permalink})`, '_Slack 업무요청 Workflow 자동 생성_');

  return {
    title,
    description: lines.join('\n'),
    priority: impact.priority,
    dueDate: addBizDays(todayKst(), impact.dueBiz),
    labelIds: [LABELS[waitLabel]].filter(Boolean),
    _meta: { typeShort, waitLabel, sla: impact.sla },
  };
}

// ─── Main ───
async function main() {
  console.log(`[intake] 채널 ${INTAKE_CHANNEL} · since ${SINCE}${DRY_RUN ? ' · DRY RUN' : ''}`);
  const state = loadState();

  const hist = await slack.conversations.history({
    channel: INTAKE_CHANNEL,
    oldest: sinceToTs(SINCE),
    limit: LIMIT,
  });
  const targets = (hist.messages || [])
    .filter((m) => (m.text || '').includes(MARKER))
    .filter((m) => !state.processed[m.ts])
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  console.log(`[intake] 대상 ${targets.length}건`);
  if (!targets.length) return;

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

    const issue = buildIssue(p, corp, permalink, p.kv['요청자']);
    console.log(`\n  ── ${m.ts}`);
    console.log(`  제목: ${issue.title}`);
    console.log(`  P${issue.priority} · 기한 ${issue.dueDate} · ${issue._meta.waitLabel} · 최초회신 ${issue._meta.sla}`);

    if (DRY_RUN) continue;

    const data = await linear(
      `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ identifier url } } }`,
      {
        i: {
          teamId: OPS_TEAM_ID,
          stateId: BACKLOG_STATE_ID,
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          dueDate: issue.dueDate,
          labelIds: issue.labelIds,
        },
      }
    );
    const iss = data.issueCreate.issue;
    console.log(`  ✅ ${iss.identifier} ${iss.url}`);

    await slack.chat.postMessage({
      channel: INTAKE_CHANNEL,
      thread_ts: m.ts,
      text: `✅ 접수 완료 · <${iss.url}|${iss.identifier}>\n담당자 지정 전이며, *최초 회신 목표는 ${issue._meta.sla}* 입니다.`,
      unfurl_links: false,
    });

    state.processed[m.ts] = { identifier: iss.identifier, at: new Date().toISOString() };
    created++;
  }

  if (!DRY_RUN) saveState(state);
  console.log(`\n[intake] 완료 — 생성 ${created}건`);
}

main().catch((e) => {
  console.error('[intake] 실패:', e.message);
  process.exit(1);
});
