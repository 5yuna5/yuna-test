#!/usr/bin/env node
/**
 * 카드스쿼드 AI 검수 큐 알럿
 * Supabase kb_review_queue(미발송) → 슬랙 DM + 정책 시트 '검수 큐' 탭 추가
 * 시트 '검수 큐'의 처리 상태 → kb_review_queue.status 역반영
 *
 * 실행: GHA kb-alert.yml (SLACK_BOT_TOKEN 시크릿 = D09HW23FF6K 접근 봇)
 *   - 즉시성: Mac launchd(com.gowid.kb-alert-trigger, 5분)가 미발송 건이 있으면 workflow_dispatch
 *   - 안전망: GHA schedule 15분
 * 사용: SLACK_BOT_TOKEN=... node kb-alert.js [--dry-run]
 */
const path = require('path');
const { google } = require('googleapis');

const SHEET_ID = '1vxxnJpO7b4vfm3PSauYYad5yYsrjZUb3rKMt9Dqs_IU';
const QUEUE_TAB = '검수 큐';
const QUEUE_GID = 1499082914;
// 임시 수신자: 오유나 개인 DM. D09HW23FF6K(나와의 DM)는 봇 접근 불가(channel_not_found)라 사용자 ID로 봇 DM 발송
const ALERT_USER = process.env.KB_ALERT_USER || 'U09J53NDGV9';
const ALERT_CHANNEL = process.env.KB_ALERT_CHANNEL || '';
const KEY_FILE = path.join(process.env.HOME, '.claude/credentials/gowid-prd-bigquery-key.json');
const SUPABASE_URL = 'https://okiipcxxaywvcmeecqvx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9raWlwY3h4YXl3dmNtZWVjcXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDM5NjEsImV4cCI6MjA5MDUxOTk2MX0.xldBRKo6laOy89zGaWT_Z3azPc30-c4iUFVixt3ZvcY';
const DRY_RUN = process.argv.includes('--dry-run');
const REASON_EMOJI = { '검증 실패': ':no_entry:', '오답 신고': ':thumbsdown:', '시트 없음': ':mag:', '답지 없음': ':mag:' };

async function sb(method, query, body, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${query.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`Slack ${method} ${d.error}`);
  return d;
}
// 사용자 ID로 바로 보내면 봇 DM(앱 메시지 탭)으로 간다 — chat:write만 필요 (봇에 im:write 없음)
async function alertChannel() {
  return ALERT_CHANNEL || ALERT_USER;
}

async function slack(text) {
  return slackApi('chat.postMessage', { channel: await alertChannel(), text, unfurl_links: false });
}

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  // ─── 1) 시트 처리 상태 → DB 역반영 (비고 열의 "큐 #id"로 매칭) ───
  const sheetRows = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${QUEUE_TAB}'!A2:M3000` })).data.values || [];
  let back = 0;
  for (const r of sheetRows) {
    const m = String(r[12] || '').match(/큐 #(\d+)/);
    const status = String(r[9] || '').trim();
    if (!m || !status) continue;
    if (!DRY_RUN) {
      const updated = await sb('PATCH', `kb_review_queue?id=eq.${m[1]}&status=neq.${encodeURIComponent(status)}`, { status }, { Prefer: 'return=representation' });
      back += updated.length;
    }
  }
  if (back) console.log(`↩️ 처리 상태 역반영 ${back}건`);

  // ─── 2) 미발송 건 알럿 ───
  const items = await sb('GET', 'kb_review_queue?select=*&alerted_at=is.null&order=id.asc&limit=50');
  if (!items.length) return console.log('✅ 새 검수 건 없음');
  console.log(`🔔 새 검수 건 ${items.length}개 ${DRY_RUN ? '(dry-run)' : ''}`);

  for (const q of items) {
    const sheetLink = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${QUEUE_GID}`;
    const text = [
      `${REASON_EMOJI[q.reason] || ':warning:'} *카드스쿼드 AI 검수 요청* — ${q.reason} (큐 #${q.id})`,
      `*질문* ${cut(q.question, 300)}`,
      `*챗봇 답변* ${cut(q.answer, 500)}`,
      q.verify_note ? `*검증 메모* ${cut(q.verify_note, 300)}` : null,
      q.matched_qid ? `*관련 답지* ${q.matched_qid}` : null,
      `<${sheetLink}|검수 큐 시트에서 처리하기> · ${kst(q.created_at)} KST`,
    ].filter(Boolean).join('\n');
    if (DRY_RUN) { console.log(text, '\n'); continue; }

    // 시트 기록 → sheet_row 저장 → 슬랙 → alerted_at. 슬랙 실패로 재시도돼도 시트 행은 한 번만 생긴다
    if (!q.sheet_row) {
      const appended = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `'${QUEUE_TAB}'!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[kst(q.created_at), q.channel, q.asker_type, q.question, q.answer, q.reason, q.matched_qid || '', q.verify_note || '', '', q.status, '', '', `큐 #${q.id}`]] },
      });
      const sheetRow = Number((appended.data.updates.updatedRange.match(/!A(\d+)/) || [])[1]) || null;
      await sb('PATCH', `kb_review_queue?id=eq.${q.id}`, { sheet_row: sheetRow });
    }
    await slack(text);
    await sb('PATCH', `kb_review_queue?id=eq.${q.id}`, { alerted_at: new Date().toISOString() });
  }
  console.log(`✅ 알럿 ${items.length}건 발송·시트 기록`);
}

main().catch((e) => { console.error('❌ 검수 알럿 실패:', e.message); process.exit(1); });
