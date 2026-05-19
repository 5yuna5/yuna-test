/**
 * ============================================================
 * 슬랙 멘션 트래커 — 양방향 이모지 동기화 모듈
 * ============================================================
 *
 * 별도 파일로 분리. 기존 Code.gs(slack_mention_tracker.gs)는 손대지 않음.
 *
 * 동작:
 *   1. 시트 → 슬랙 (onSheetEdit 트리거):
 *      D열(진행상황)을 '완료'로 변경 → 슬랙 메시지에 ✅ 부착
 *      D열을 '완료'에서 다른 값으로 되돌림 → ✅ 제거
 *   2. 슬랙 → 시트 (syncFromSlackReactions, 5분 트리거):
 *      시트의 미완료 row 중 최근 50개를 검사,
 *      슬랙 메시지에 ✅가 붙어있으면 D열을 '완료'로 변경
 *
 * 필요한 Slack User Token scope: reactions:read, reactions:write
 * (기존 search:read, users:read에 추가)
 *
 * 설정 절차:
 *   1. Slack App OAuth & Permissions에서 위 scope 2개 추가 → Reinstall
 *   2. 이 파일을 Apps Script에 새 파일(파일명 자유, 예: reactions.gs)로 추가
 *   3. setupReactionTriggers() 1회 실행 (권한 승인 화면 → 허용)
 *   4. testReactionAdd / testReactionSync 로 동작 검증
 */

// ════════════════════════════════════════
// 상수
// ════════════════════════════════════════

var DONE_EMOJI = 'white_check_mark';   // ✅
var DONE_STATUS = '완료';
var STATUS_COL = 4;       // D열: 진행상황
var SLACK_LINK_COL = 8;   // H열: 슬랙링크 (HYPERLINK 수식)
var TS_COL = 10;          // J열: ts (숨김)

// 한 사이클에 검사할 미완료 row 최대 개수 (Slack reactions.get 호출량 제한)
var DEFAULT_REACTION_SYNC_LIMIT = 50;

// ════════════════════════════════════════
// 트리거 설정
// ════════════════════════════════════════

/**
 * 양방향 동기화 트리거 2종을 한꺼번에 등록합니다.
 *   - syncFromSlackReactions: 5분 시간 기반 (Slack → 시트)
 *   - onSheetEdit: 스프레드시트 onEdit (시트 → Slack)
 *
 * 기존에 동일 핸들러로 등록된 트리거가 있으면 먼저 제거합니다.
 * 첫 실행 시 외부 API + Spreadsheet 권한 승인 화면이 뜨면 허용.
 */
function setupReactionTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'syncFromSlackReactions' || fn === 'onSheetEdit') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // 1. 5분 시간 기반: Slack → 시트
  ScriptApp.newTrigger('syncFromSlackReactions')
    .timeBased()
    .everyMinutes(5)
    .create();

  // 2. onEdit: 시트 → Slack
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    console.log('[트리거] SPREADSHEET_ID 없음 — onSheetEdit 트리거 등록 불가');
    return;
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  console.log('[트리거] 양방향 동기화 트리거 등록 완료');
  console.log('  - syncFromSlackReactions (5분 시간 기반)');
  console.log('  - onSheetEdit (스프레드시트 수정 시)');
}

// ════════════════════════════════════════
// 시트 → 슬랙: onEdit 핸들러
// ════════════════════════════════════════

/**
 * Installable onEdit 트리거 핸들러.
 * D열(진행상황)이 변경된 row에 대해 Slack reactions.add/remove 호출.
 *
 * 주의: setValue()로 변경된 셀은 onEdit 트리거가 발화되지만
 *       e.user가 undefined, e.value가 user input일 때만 신뢰 가능.
 *       무한 루프 방지를 위해 e.value === DONE_STATUS 조건이 핵심.
 */
function onSheetEdit(e) {
  if (!e || !e.range) return;

  var sheet = e.range.getSheet();
  var props = PropertiesService.getScriptProperties();
  var targetSheetName = props.getProperty('SHEET_NAME') || '멘션트래커';
  if (sheet.getName() !== targetSheetName) return;

  var row = e.range.getRow();
  var col = e.range.getColumn();
  if (col !== STATUS_COL) return;
  if (row < 2) return;

  var newValue = e.value;
  var oldValue = e.oldValue;

  var token = props.getProperty('SLACK_USER_TOKEN');
  if (!token || token === 'xoxp-your-user-token-here') {
    console.log('[onEdit] SLACK_USER_TOKEN 없음');
    return;
  }

  var linkFormula = sheet.getRange(row, SLACK_LINK_COL).getFormula();
  var tsValue = sheet.getRange(row, TS_COL).getValue();
  var meta = extractChannelAndTs(linkFormula, tsValue);
  if (!meta) {
    console.log('[onEdit] row ' + row + ': 슬랙 정보 파싱 실패');
    return;
  }

  if (newValue === DONE_STATUS && oldValue !== DONE_STATUS) {
    var added = addSlackReaction(token, meta.channelId, meta.ts, DONE_EMOJI);
    console.log('[onEdit] row ' + row + ' → ✅ 부착 ' + (added ? '성공' : '실패'));
  } else if (oldValue === DONE_STATUS && newValue !== DONE_STATUS) {
    var removed = removeSlackReaction(token, meta.channelId, meta.ts, DONE_EMOJI);
    console.log('[onEdit] row ' + row + ' → ✅ 제거 ' + (removed ? '성공' : '실패'));
  }
}

// ════════════════════════════════════════
// 슬랙 → 시트: 5분 폴링
// ════════════════════════════════════════

/**
 * 시트의 미완료 row 중 최근 N개를 검사하여, 슬랙 메시지에 ✅가 붙어있으면
 * D열을 '완료'로 자동 변경합니다.
 *
 * 효율: row마다 reactions.get 1 call. Tier 3 API (50+/min) 한도 내.
 * setValue()로 D열을 바꿔도 installable onSheetEdit은 발화되지만
 * e.value가 'undefined'로 들어와 reactions.add가 호출되지 않음 → 안전.
 */
function syncFromSlackReactions() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_USER_TOKEN');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetName = props.getProperty('SHEET_NAME') || '멘션트래커';
  var limit = parseInt(props.getProperty('REACTION_SYNC_LIMIT') || DEFAULT_REACTION_SYNC_LIMIT, 10);

  if (!token || token === 'xoxp-your-user-token-here') {
    console.log('[sync] SLACK_USER_TOKEN 없음'); return;
  }
  if (!spreadsheetId) { console.log('[sync] SPREADSHEET_ID 없음'); return; }

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { console.log('[sync] 시트 없음: ' + sheetName); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { console.log('[sync] row 없음'); return; }

  var statusValues = sheet.getRange(2, STATUS_COL, lastRow - 1, 1).getValues();
  var linkFormulas = sheet.getRange(2, SLACK_LINK_COL, lastRow - 1, 1).getFormulas();
  var tsValues = sheet.getRange(2, TS_COL, lastRow - 1, 1).getValues();

  // 최근 row부터 거꾸로 훑어 미완료 row 인덱스 수집 (limit 개까지)
  var pendingRows = [];
  for (var i = statusValues.length - 1; i >= 0 && pendingRows.length < limit; i--) {
    if (statusValues[i][0] !== DONE_STATUS) {
      pendingRows.push(i);
    }
  }
  console.log('[sync] 검사 대상 미완료 row: ' + pendingRows.length + '건 (limit=' + limit + ')');

  var updateCount = 0;
  for (var j = 0; j < pendingRows.length; j++) {
    var idx = pendingRows[j];
    var rowNum = idx + 2;
    var meta = extractChannelAndTs(linkFormulas[idx][0], tsValues[idx][0]);
    if (!meta) continue;

    try {
      if (checkReactionExists(token, meta.channelId, meta.ts, DONE_EMOJI)) {
        sheet.getRange(rowNum, STATUS_COL).setValue(DONE_STATUS);
        console.log('[sync] row ' + rowNum + ' (ts ' + meta.ts + ') → 완료');
        updateCount++;
      }
    } catch (e) {
      console.log('[sync] row ' + rowNum + ' 검사 실패: ' + e.message);
    }
  }

  console.log('[sync] 완료 — ' + updateCount + '건 업데이트');
}

// ════════════════════════════════════════
// Slack API 헬퍼
// ════════════════════════════════════════

function addSlackReaction(token, channelId, ts, emoji) {
  try {
    var response = UrlFetchApp.fetch('https://slack.com/api/reactions.add', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: { channel: channelId, timestamp: ts, name: emoji },
      muteHttpExceptions: true,
    });
    var result = JSON.parse(response.getContentText());
    if (!result.ok) {
      if (result.error === 'already_reacted') return true;
      console.log('[reactions.add] 실패 (ts=' + ts + '): ' + result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.log('[reactions.add] 예외: ' + e.message);
    return false;
  }
}

function removeSlackReaction(token, channelId, ts, emoji) {
  try {
    var response = UrlFetchApp.fetch('https://slack.com/api/reactions.remove', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: { channel: channelId, timestamp: ts, name: emoji },
      muteHttpExceptions: true,
    });
    var result = JSON.parse(response.getContentText());
    if (!result.ok) {
      if (result.error === 'no_reaction') return true;
      console.log('[reactions.remove] 실패 (ts=' + ts + '): ' + result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.log('[reactions.remove] 예외: ' + e.message);
    return false;
  }
}

function checkReactionExists(token, channelId, ts, emoji) {
  var url = 'https://slack.com/api/reactions.get' +
    '?channel=' + encodeURIComponent(channelId) +
    '&timestamp=' + encodeURIComponent(ts);

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  var result = JSON.parse(response.getContentText());

  if (!result.ok) {
    if (result.error === 'message_not_found') return false;
    throw new Error(result.error);
  }

  var reactions = (result.message && result.message.reactions) || [];
  for (var i = 0; i < reactions.length; i++) {
    if (reactions[i].name === emoji) return true;
  }
  return false;
}

// ════════════════════════════════════════
// 보조: HYPERLINK 수식 + ts → {channelId, ts}
// ════════════════════════════════════════

/**
 * H열 HYPERLINK 수식과 J열 ts에서 channelId와 message ts를 추출.
 *
 * 예: '=HYPERLINK("https://gowid.slack.com/archives/C12345/p1234567890123456","열기")'
 * → { channelId: 'C12345', ts: J열에서 '1234567890.123456' }
 */
function extractChannelAndTs(linkFormula, tsValue) {
  if (!linkFormula) return null;

  var urlMatch = linkFormula.match(/HYPERLINK\("([^"]+)"/);
  if (!urlMatch) return null;
  var url = urlMatch[1];

  var idMatch = url.match(/\/archives\/([^/]+)\/p(\d+)/);
  if (!idMatch) return null;

  var channelId = idMatch[1];
  var ts;
  if (tsValue) {
    ts = tsValue.toString();
  } else {
    var pTs = idMatch[2];
    if (pTs.length >= 16) {
      ts = pTs.substring(0, 10) + '.' + pTs.substring(10);
    } else {
      return null;
    }
  }
  return { channelId: channelId, ts: ts };
}

// ════════════════════════════════════════
// 테스트 함수
// ════════════════════════════════════════

/**
 * 시트 마지막 row의 슬랙 메시지에 ✅를 부착 시도 (시트→슬랙 검증).
 * 실행 후 슬랙에서 ✅가 새로 붙었는지 확인하세요.
 */
function testReactionAdd() {
  console.log('=== testReactionAdd 시작 ===');

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_USER_TOKEN');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetName = props.getProperty('SHEET_NAME') || '멘션트래커';

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { console.log('[테스트] row 없음'); return; }

  var linkFormula = sheet.getRange(lastRow, SLACK_LINK_COL).getFormula();
  var tsValue = sheet.getRange(lastRow, TS_COL).getValue();
  var meta = extractChannelAndTs(linkFormula, tsValue);

  if (!meta) {
    console.log('[테스트] 슬랙 정보 파싱 실패. linkFormula=' + linkFormula);
    return;
  }

  console.log('[테스트] 대상: row=' + lastRow + ', channel=' + meta.channelId + ', ts=' + meta.ts);
  var ok = addSlackReaction(token, meta.channelId, meta.ts, DONE_EMOJI);
  console.log('[테스트] ' + (ok ? '✅ 부착 성공 → 슬랙에서 확인' : '실패'));
  console.log('=== testReactionAdd 완료 ===');
}

/**
 * 슬랙 → 시트 동기화 1회 수동 실행.
 * 슬랙에서 미리 ✅를 부착해둔 메시지가 시트 '완료'로 바뀌는지 확인.
 */
function testReactionSync() {
  console.log('=== testReactionSync 시작 ===');
  syncFromSlackReactions();
  console.log('=== testReactionSync 완료 — 시트 D열 확인 ===');
}
