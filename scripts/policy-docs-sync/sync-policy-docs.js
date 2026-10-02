#!/usr/bin/env node
/**
 * 카드스쿼드 AI 원천시트 → Supabase policy_docs 동기화
 *
 * 원천: "카드사별 상품 및 운영정책" 시트(gid=0, 비교표 탭)
 * 대상: Supabase(okiipcxxaywvcmeecqvx) policy_docs — card-squad /api/policy-chat · /policy 가 읽는 테이블
 *
 * 규칙
 * - 시트 = SSOT. source='sheet' 행은 매번 통째로 교체 (새 행 insert → 옛 행 delete)
 * - source='manual' 행(채팅·화면에서 추가)은 건드리지 않음
 * - 내용이 그대로면 아무것도 쓰지 않음 (id 유지)
 * - type / policy_types 는 시트에 없으므로 같은 카테고리|항목의 기존 값을 승계
 *
 * 사용: node sync-policy-docs.js [--dry-run]
 * 실행: GitHub Actions policy-docs-sync.yml (매시간 :20) + Mac launchd com.gowid.policy-docs-sync (매시간 :50, GHA 지연 대비)
 */

const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const SHEET_ID = '1vxxnJpO7b4vfm3PSauYYad5yYsrjZUb3rKMt9Dqs_IU';
const SHEET_GID = 0;
const KEY_FILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');

// card-squad 앱과 같은 프로젝트·anon key (policy_docs RLS = public ALL)
const SUPABASE_URL = 'https://okiipcxxaywvcmeecqvx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9raWlwY3h4YXl3dmNtZWVjcXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDM5NjEsImV4cCI6MjA5MDUxOTk2MX0.xldBRKo6laOy89zGaWT_Z3azPc30-c4iUFVixt3ZvcY';

const DRY_RUN = process.argv.includes('--dry-run');
const MIN_ROWS = 50; // 이보다 적게 파싱되면 시트 구조가 깨진 것으로 보고 중단

// 시트 헤더 → DB 컬럼. 컬럼 순서가 바뀌어도 헤더명으로 찾는다
const HEADER_MAP = [
  { field: 'item', match: (h) => h === '항목', required: true },
  { field: 'detail', match: (h) => h === '상세설명', required: true },
  { field: 'lotte', match: (h) => h === '롯데', required: true },
  { field: 'lotte_skypass', match: (h) => h.startsWith('롯데') && h.includes('스카이패스') },
  { field: 'bc', match: (h) => h === '비씨', required: true },
  { field: 'shinhan', match: (h) => h === '신한', required: true },
  { field: 'kb', match: (h) => h === '국민' },
  { field: 'kb_credit', match: (h) => h.startsWith('국민') && h.includes('크레딧') },
  { field: 'samsung', match: (h) => h.startsWith('삼성') },
  { field: 'common', match: (h) => h.startsWith('공통') },
  { field: 'note', match: (h) => h.includes('비고') },
  { field: 'ref', match: (h) => h.startsWith('참고') },
];
const CONTENT_FIELDS = ['detail', 'lotte', 'lotte_skypass', 'bc', 'shinhan', 'kb', 'kb_credit', 'samsung', 'common', 'note', 'ref'];
const ROW_FIELDS = ['category', 'item', ...CONTENT_FIELDS];

// ─── Supabase REST ───
async function sb(method, query, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${query.split('?')[0]} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ─── 시트 읽기 ───
async function readSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties(sheetId,title)' });
  const tab = meta.data.sheets.find((s) => s.properties.sheetId === SHEET_GID);
  if (!tab) throw new Error(`gid=${SHEET_GID} 탭을 찾을 수 없음`);
  const title = tab.properties.title;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${title}'!A1:Z2000` });
  return { title, values: res.data.values || [] };
}

function parseRows(values) {
  const header = (values[0] || []).map((h) => String(h || '').trim());
  const colOf = {};
  for (const { field, match, required } of HEADER_MAP) {
    const idx = header.findIndex((h, i) => i > 0 && match(h));
    if (idx === -1 && required) throw new Error(`필수 헤더 '${field}' 없음 — 시트 헤더: ${JSON.stringify(header)}`);
    if (idx !== -1) colOf[field] = idx;
  }

  const rows = [];
  let lastCategory = '';
  let lastItem = '';
  values.slice(1).forEach((raw, i) => {
    const cell = (idx) => (idx === undefined ? '' : String(raw[idx] || '').trim());
    // 병합 셀 패턴: 카테고리(A열)·항목은 비어 있으면 위 값을 이어받음
    const category = cell(0) || lastCategory;
    const item = cell(colOf.item) || lastItem;
    lastCategory = category;
    lastItem = item;

    const row = { category, item };
    for (const f of CONTENT_FIELDS) row[f] = cell(colOf[f]);
    const hasContent = cell(0) || cell(colOf.item) || CONTENT_FIELDS.some((f) => row[f]);
    if (!hasContent || !category) return;
    row.sheet_row = i + 2; // 시트상의 실제 행 번호
    rows.push(row);
  });
  return { rows, header, colOf };
}

const hashRows = (rows) =>
  crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => [r.sheet_row, ...ROW_FIELDS.map((f) => r[f] || '')]))).digest('hex');

const defaultPolicyTypes = (category) => (category === '한도 심사' ? ['limit_policy'] : ['card_policy']);

// GHA(:20)와 launchd(:50)가 GHA 지연으로 겹칠 수 있어 5분 잠금. 단일 UPDATE 조건부라 원자적
async function acquireLock() {
  const now = new Date();
  const until = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const rows = await sb(
    'PATCH',
    `policy_sync_state?id=eq.1&or=(lock_until.is.null,lock_until.lt.${encodeURIComponent(now.toISOString())})`,
    { lock_until: until },
    { Prefer: 'return=representation' }
  );
  return rows.length === 1;
}
const releaseLock = () => sb('PATCH', 'policy_sync_state?id=eq.1', { lock_until: null });

async function main() {
  if (!DRY_RUN && !(await acquireLock())) {
    console.log('⏭️ 다른 동기화가 실행 중 — 건너뜀');
    return;
  }
  try {
    await sync();
  } finally {
    if (!DRY_RUN) await releaseLock();
  }
}

async function sync() {
  console.log(`📥 시트 읽는 중... ${DRY_RUN ? '(dry-run)' : ''}`);
  const { title, values } = await readSheet();
  const { rows, colOf } = parseRows(values);
  console.log(`  탭 '${title}' → ${rows.length}행 (매핑 컬럼: ${Object.keys(colOf).join(', ')})`);
  if (rows.length < MIN_ROWS) throw new Error(`파싱 행 ${rows.length} < ${MIN_ROWS} — 시트 구조 변경 의심, 중단`);

  const existing = await sb('GET', 'policy_docs?select=*&source=eq.sheet&order=sheet_row.asc.nullslast,id.asc');
  const now = new Date().toISOString();

  if (hashRows(existing) === hashRows(rows)) {
    console.log(`✅ 변경 없음 (${rows.length}행) — 쓰기 생략`);
    if (!DRY_RUN) await sb('PATCH', 'policy_sync_state?id=eq.1', { last_checked_at: now, row_count: rows.length });
    return;
  }

  // type / policy_types 승계 (시트·수동 행 모두 참고)
  const all = await sb('GET', 'policy_docs?select=category,item,type,policy_types&order=id.asc');
  const inherit = new Map();
  for (const r of all) {
    const k = `${r.category}|${r.item}`;
    if (!inherit.has(k)) inherit.set(k, { type: r.type, policy_types: r.policy_types });
  }
  const payload = rows.map((r) => {
    const prev = inherit.get(`${r.category}|${r.item}`);
    return {
      ...r,
      source: 'sheet',
      type: prev?.type || 'both',
      policy_types: prev?.policy_types?.length ? prev.policy_types : defaultPolicyTypes(r.category),
      created_at: now,
      updated_at: now,
    };
  });

  const oldIds = existing.map((r) => r.id);
  console.log(`🔄 변경 감지: 기존 시트행 ${oldIds.length} → 신규 ${payload.length}`);
  if (DRY_RUN) {
    console.log('  [dry-run] 쓰기 생략. 샘플:', JSON.stringify(payload.slice(0, 2), null, 1));
    return;
  }

  // 1) 새 행 먼저 넣고 2) 가장 최근 배치보다 오래된 시트 행 삭제 — 중간 실패 시에도 데이터가 비지 않게.
  // 잠금이 풀린 뒤 겹쳐 돌아도 "최신 배치만 남김"으로 수렴한다 (옛 id 목록 기준 삭제는 중복이 남음)
  for (let i = 0; i < payload.length; i += 100) {
    await sb('POST', 'policy_docs', payload.slice(i, i + 100), { Prefer: 'return=minimal' });
  }
  const [newest] = await sb('GET', 'policy_docs?select=created_at&source=eq.sheet&order=created_at.desc&limit=1');
  await sb('DELETE', `policy_docs?source=eq.sheet&created_at=lt.${encodeURIComponent(newest.created_at)}`);
  await sb('PATCH', 'policy_sync_state?id=eq.1', { last_checked_at: now, last_changed_at: now, row_count: payload.length });
  console.log(`✅ 동기화 완료: ${payload.length}행 반영, ${oldIds.length}행 교체`);
}

main().catch((err) => {
  console.error('❌ 동기화 실패:', err.message);
  process.exit(1);
});
