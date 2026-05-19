/**
 * ============================================================
 * 슬랙 멘션 트래커 (Google Apps Script)
 * ============================================================
 *
 * 슬랙 워크스페이스에서 지정한 사용자/사용자그룹(@카드bizops,
 * @오유나, @신현덕, @김소은) 에 대한 신규 멘션을 5분마다 폴링하여
 * Google Sheet에 자동 적재합니다.
 *
 * FUEL Lead 앱 벤치마크 — 멘션 진척상황을 시트 기반 현황판으로 관리.
 *
 * 설정 방법:
 * 1. Google Apps Script 프로젝트 생성 (script.google.com)
 * 2. 이 코드를 Code.gs에 붙여넣기
 * 3. setupProperties() 실행 → Script Properties에서 실제 값 입력
 * 4. setupSheet() 실행 → 시트 헤더/드롭다운/서식 생성
 * 5. testFetchMentions → testWriteRow → testFullPipeline 순서로 검증
 * 6. setupTrigger() 실행 → 5분 간격 자동화 시작
 *
 * 필요한 권한:
 * - 외부 HTTP 요청 (UrlFetchApp) — Slack search.messages, users.info
 * - Google Sheets 접근 (SpreadsheetApp)
 */

// ════════════════════════════════════════
// 설정
// ════════════════════════════════════════

/**
 * Script Properties에 초기 설정값을 시드합니다.
 * 최초 1회 수동 실행 후, 각 값을 실제 값으로 수정하세요.
 *
 * 입력 방법: Apps Script 편집기 좌측 > 프로젝트 설정 > 스크립트 속성
 */
function setupProperties() {
  var props = PropertiesService.getScriptProperties();

  props.setProperties({
    // Slack User Token (xoxp-) — search:read, users:read scope 필요
    // crm-slack-bot .env의 SLACK_USER_TOKEN 재사용 가능
    'SLACK_USER_TOKEN': 'xoxp-your-user-token-here',

    // Google Sheet ID — URL의 /d/{SHEET_ID}/edit 에서 복사
    'SPREADSHEET_ID': 'your-spreadsheet-id-here',

    // 시트 이름 (기본: 멘션트래커)
    'SHEET_NAME': '멘션트래커',

    // 추적할 개인 User ID 목록 (콤마 구분, U-prefix)
    // 예: U01OUNA123,U02HJCHOI456,U03SEKIM789
    // 조회 방법: Slack 사용자 프로필 → 우측 ... → "Copy member ID"
    'WATCH_USER_IDS': 'U_OUNA,U_HJ,U_SE',

    // 추적할 사용자그룹 ID 목록 (콤마 구분, S-prefix)
    // 예: S067BIZOPS123
    // 조회 방법: https://gowid.slack.com/admin/user_groups 또는 usergroups.list API
    'WATCH_SUBTEAM_IDS': 'S_BIZOPS',

    // ID → 이름 매핑 JSON (추적 대상 ID를 사람이 읽기 좋은 이름으로 변환)
    // 예: {"U01OUNA123":"오유나","U02HJCHOI456":"신현덕","U03SEKIM789":"김소은","S067BIZOPS123":"카드bizops"}
    'WATCH_NAMES_JSON': '{"U_OUNA":"오유나","U_HJ":"신현덕","U_SE":"김소은","S_BIZOPS":"카드bizops"}',

    // 마지막으로 처리한 메시지의 Slack ts (초기값 0, 자동 갱신됨)
    'LAST_PROCESSED_TS': '0',
  });

  console.log('[설정] Properties 초기화 완료. Script Properties에서 실제 값으로 수정하세요.');
  console.log('[설정] SLACK_USER_TOKEN, SPREADSHEET_ID, WATCH_USER_IDS, WATCH_SUBTEAM_IDS, WATCH_NAMES_JSON 필수 입력');
}

/**
 * 5분 간격 main() 트리거를 등록합니다. 기존 main 트리거를 먼저 제거한 뒤 재등록.
 * 최초 1회 수동 실행 (setupSheet, 테스트 함수 검증 완료 후).
 */
function setupTrigger() {
  // 기존 main 트리거 제거
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'main') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // 5분 간격 트리거 등록
  ScriptApp.newTrigger('main')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log('[트리거] 5분 간격 main() 트리거 등록 완료');
}

/**
 * Google Sheet에 헤더, 드롭다운, 조건부 서식을 초기화합니다.
 * setupProperties() 완료 후, testFetchMentions 전에 실행하세요.
 */
function setupSheet() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetName = props.getProperty('SHEET_NAME') || '멘션트래커';

  if (!spreadsheetId || spreadsheetId === 'your-spreadsheet-id-here') {
    console.log('[시트] SPREADSHEET_ID가 설정되지 않았습니다. Properties에서 입력 후 재실행하세요.');
    return;
  }

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    console.log('[시트] 새 시트 생성: ' + sheetName);
  }

  // ─── 헤더 행 ───
  var headers = [
    '문의접수일(KST)',   // A: 자동
    '요청자',            // B: users.info 조회
    '처리담당자',        // C: 멘션된 대상 콤마 구분
    '진행상황',          // D: 드롭다운 5단계
    '완료예정일',        // E: 수동
    '특이사항',          // F: 수동
    '메시지원문',        // G: 500자 truncate
    '슬랙링크',          // H: HYPERLINK 수식
    '채널명',            // I: #channel
    'ts',               // J: dedup용 숨김 인덱스
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // 헤더 스타일: 굵게 + 배경 회색
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#e0e0e0');

  // 첫 행 고정
  sheet.setFrozenRows(1);

  // ─── D열 드롭다운 (진행상황 5단계) ───
  var dropdownRange = sheet.getRange('D2:D1000');
  var dropdownRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['미확인', '확인', '처리중', '완료', '보류'], true)
    .setAllowInvalid(false)
    .build();
  dropdownRange.setDataValidation(dropdownRule);

  // ─── D열 조건부 서식 ───
  var sheetRange = sheet.getRange('D2:D1000');

  // 미확인 = 빨강 배경
  var ruleRed = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('미확인')
    .setBackground('#f4cccc')
    .setRanges([sheetRange])
    .build();

  // 처리중 = 노랑 배경
  var ruleYellow = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('처리중')
    .setBackground('#fff2cc')
    .setRanges([sheetRange])
    .build();

  // 완료 = 초록 배경
  var ruleGreen = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('완료')
    .setBackground('#d9ead3')
    .setRanges([sheetRange])
    .build();

  // 보류 = 회색 배경
  var ruleGray = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('보류')
    .setBackground('#d9d9d9')
    .setRanges([sheetRange])
    .build();

  sheet.setConditionalFormatRules([ruleRed, ruleYellow, ruleGreen, ruleGray]);

  // J열(ts) 숨김
  sheet.hideColumns(10);

  // 열 너비 조정
  sheet.setColumnWidth(1, 150);  // A: 문의접수일
  sheet.setColumnWidth(2, 120);  // B: 요청자
  sheet.setColumnWidth(3, 150);  // C: 처리담당자
  sheet.setColumnWidth(4, 80);   // D: 진행상황
  sheet.setColumnWidth(5, 110);  // E: 완료예정일
  sheet.setColumnWidth(6, 200);  // F: 특이사항
  sheet.setColumnWidth(7, 350);  // G: 메시지원문
  sheet.setColumnWidth(8, 80);   // H: 슬랙링크
  sheet.setColumnWidth(9, 120);  // I: 채널명

  console.log('[시트] 헤더/드롭다운/조건부서식 초기화 완료: ' + sheetName);
}

// ════════════════════════════════════════
// 메인 파이프라인
// ════════════════════════════════════════

/**
 * 메인 함수 — 트리거에 의해 5분마다 실행됩니다.
 * 신규 멘션을 가져와 Google Sheet에 row로 적재합니다.
 */
function main() {
  var props = PropertiesService.getScriptProperties();

  // ─── 필수 Properties 로드 ───
  var token = props.getProperty('SLACK_USER_TOKEN');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetName = props.getProperty('SHEET_NAME') || '멘션트래커';
  var lastTs = props.getProperty('LAST_PROCESSED_TS') || '0';

  // 필수 값 검증
  if (!token || token === 'xoxp-your-user-token-here') {
    console.log('[main] SLACK_USER_TOKEN이 설정되지 않았습니다. Properties 확인 후 재실행하세요.');
    return;
  }
  if (!spreadsheetId || spreadsheetId === 'your-spreadsheet-id-here') {
    console.log('[main] SPREADSHEET_ID가 설정되지 않았습니다. Properties 확인 후 재실행하세요.');
    return;
  }

  // 추적 대상 파싱
  var userIdsRaw = props.getProperty('WATCH_USER_IDS') || '';
  var subteamIdsRaw = props.getProperty('WATCH_SUBTEAM_IDS') || '';
  var namesJson = props.getProperty('WATCH_NAMES_JSON') || '{}';

  var watchUserIds = userIdsRaw ? userIdsRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var watchSubteamIds = subteamIdsRaw ? subteamIdsRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

  if (watchUserIds.length === 0 && watchSubteamIds.length === 0) {
    console.log('[main] 추적 대상이 없습니다. WATCH_USER_IDS 또는 WATCH_SUBTEAM_IDS를 설정하세요.');
    return;
  }

  var namesMap = {};
  try {
    namesMap = JSON.parse(namesJson);
  } catch (e) {
    console.log('[main] WATCH_NAMES_JSON 파싱 실패 (계속 진행): ' + e.message);
  }

  // ─── 시트 열기 ───
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    console.log('[main] 시트를 찾을 수 없습니다: ' + sheetName + '. setupSheet()를 먼저 실행하세요.');
    return;
  }

  // ─── 기존 ts 집합 로드 (시트 레벨 dedup) ───
  var processedTsSet = loadProcessedTsSet(sheet);
  console.log('[main] 기존 ts 집합 로드 완료: ' + processedTsSet.size + '건');

  // ─── Slack 멘션 조회 ───
  var matches = [];
  try {
    matches = fetchMentions(token, watchUserIds, watchSubteamIds, lastTs);
  } catch (e) {
    console.log('[main] 멘션 조회 실패: ' + e.message);
    return;
  }

  console.log('[main] 신규 멘션 후보: ' + matches.length + '건');

  if (matches.length === 0) {
    console.log('[main] 새 멘션 없음');
    props.setProperty('LAST_PROCESSED_TS', lastTs);
    return;
  }

  // ─── 멘션 처리 루프 ───
  var userInfoCache = {};
  var latestTs = lastTs;
  var newCount = 0;

  for (var i = 0; i < matches.length; i++) {
    var match = matches[i];

    // Properties LAST_PROCESSED_TS 가드: lastTs 이하 ts는 스킵
    if (parseFloat(match.ts) <= parseFloat(lastTs)) {
      continue;
    }

    // 시트 ts Set 중복 체크
    if (processedTsSet.has(match.ts)) {
      console.log('[main] 중복 ts 스킵: ' + match.ts);
      continue;
    }

    try {
      appendMentionRow(sheet, match, namesMap, token, userInfoCache);
      processedTsSet.add(match.ts);
      newCount++;
    } catch (e) {
      console.log('[main] row 적재 실패 (ts=' + match.ts + '): ' + e.message);
    }

    // 최신 ts 갱신
    if (parseFloat(match.ts) > parseFloat(latestTs)) {
      latestTs = match.ts;
    }
  }

  // ─── LAST_PROCESSED_TS 갱신 ───
  props.setProperty('LAST_PROCESSED_TS', latestTs);

  console.log('[main] 완료 — 신규 적재: ' + newCount + '건, 최신 ts: ' + latestTs);
}

// ════════════════════════════════════════
// Slack search.messages 호출
// ════════════════════════════════════════

/**
 * Slack search.messages API로 멘션을 조회합니다.
 *
 * @param {string} token        Slack User Token (xoxp-)
 * @param {string[]} userIds    추적할 개인 User ID 배열 (U-prefix)
 * @param {string[]} subteamIds 추적할 사용자그룹 ID 배열 (S-prefix)
 * @param {string} sinceTs      마지막 처리 ts (epoch seconds 문자열, '0'이면 전체)
 * @returns {Array}             멘션 match 배열 { ts, text, user, channelId, channelName, permalink, mentionedTargets[] }
 */
function fetchMentions(token, userIds, subteamIds, sinceTs) {
  // ─── Query 구성 ───
  var parts = [];

  for (var i = 0; i < userIds.length; i++) {
    parts.push('<@' + userIds[i] + '>');
  }
  for (var j = 0; j < subteamIds.length; j++) {
    parts.push('<!subteam^' + subteamIds[j] + '>');
  }

  if (parts.length === 0) {
    throw new Error('추적 대상(userIds, subteamIds)이 모두 비어있습니다.');
  }

  var query = '(' + parts.join(' OR ') + ')';

  // after:YYYY-MM-DD 조건 추가 (sinceTs > 0)
  if (sinceTs && parseFloat(sinceTs) > 0) {
    var sinceDate = tsToKstDate(parseFloat(sinceTs));
    query += ' after:' + sinceDate;
  }

  var encodedQuery = encodeURIComponent(query);
  var url = 'https://slack.com/api/search.messages' +
    '?query=' + encodedQuery +
    '&sort=timestamp' +
    '&sort_dir=asc' +
    '&count=100';

  console.log('[Slack] search.messages 호출: ' + query);

  // ─── API 호출 ───
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });

  var result = JSON.parse(response.getContentText());

  if (!result.ok) {
    throw new Error('Slack API 오류: ' + result.error);
  }

  var rawMatches = (result.messages && result.messages.matches) ? result.messages.matches : [];
  console.log('[Slack] 멘션 ' + rawMatches.length + '건 발견');

  // ─── 정규화 ───
  var normalized = [];
  for (var k = 0; k < rawMatches.length; k++) {
    var m = rawMatches[k];

    // sinceTs 이후 메시지만
    if (parseFloat(m.ts) <= parseFloat(sinceTs)) {
      continue;
    }

    var channelId = (m.channel && m.channel.id) ? m.channel.id : '';
    var channelName = (m.channel && m.channel.name) ? m.channel.name : '';

    // 어떤 대상이 멘션됐는지 파싱
    var mentioned = parseMentionedTargets(m.text || '', userIds, subteamIds);

    normalized.push({
      ts: m.ts,
      text: m.text || '',
      user: m.user || '',
      channelId: channelId,
      channelName: channelName,
      permalink: m.permalink || '',
      mentionedTargets: mentioned,
    });
  }

  return normalized;
}

// ════════════════════════════════════════
// 멘션 대상 파싱
// ════════════════════════════════════════

/**
 * 메시지 텍스트에서 실제 멘션된 추적 대상 ID를 추출합니다.
 *
 * @param {string}   text        메시지 원문
 * @param {string[]} userIds     추적 대상 개인 ID 배열
 * @param {string[]} subteamIds  추적 대상 사용자그룹 ID 배열
 * @returns {string[]}           멘션된 ID 배열 (교집합)
 */
function parseMentionedTargets(text, userIds, subteamIds) {
  var found = [];

  // <@U_USER_ID> 패턴 추출
  var userRegex = /<@([A-Z0-9]+)>/g;
  var userMatch;
  while ((userMatch = userRegex.exec(text)) !== null) {
    var uid = userMatch[1];
    if (userIds.indexOf(uid) !== -1 && found.indexOf(uid) === -1) {
      found.push(uid);
    }
  }

  // <!subteam^S_GROUP_ID> 또는 <!subteam^S_GROUP_ID|@handle> 패턴 추출
  var subteamRegex = /<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/g;
  var subteamMatch;
  while ((subteamMatch = subteamRegex.exec(text)) !== null) {
    var sid = subteamMatch[1];
    if (subteamIds.indexOf(sid) !== -1 && found.indexOf(sid) === -1) {
      found.push(sid);
    }
  }

  return found;
}

// ════════════════════════════════════════
// 시트 적재
// ════════════════════════════════════════

/**
 * 멘션 match 1건을 Google Sheet에 row로 추가합니다.
 *
 * @param {Sheet}   sheet          Google Sheet 객체
 * @param {Object}  match          fetchMentions에서 반환된 정규화 match
 * @param {Object}  namesMap       ID → 이름 매핑 { "U_OUNA": "오유나", ... }
 * @param {string}  token          Slack User Token (users.info 조회용)
 * @param {Object}  userInfoCache  users.info 응답 캐시 (Map 또는 plain object)
 */
function appendMentionRow(sheet, match, namesMap, token, userInfoCache) {
  // A: 문의접수일(KST)
  var receivedAt = Utilities.formatDate(
    new Date(parseFloat(match.ts) * 1000),
    'Asia/Seoul',
    'yyyy-MM-dd HH:mm:ss'
  );

  // B: 요청자 (users.info 조회, 캐시 활용)
  var requester = lookupUserName(match.user, token, userInfoCache);

  // C: 처리담당자 (멘션된 ID → 이름 매핑, 콤마 구분)
  var assignees = '';
  if (match.mentionedTargets && match.mentionedTargets.length > 0) {
    assignees = match.mentionedTargets.map(function(id) {
      return namesMap[id] || id;
    }).join(', ');
  }

  // D: 진행상황 (기본값 미확인)
  var status = '미확인';

  // E, F: 운영자 수동 입력
  var dueDate = '';
  var notes = '';

  // G: 메시지원문 (500자 truncate)
  var messageText = match.text || '';
  if (messageText.length > 500) {
    messageText = messageText.substring(0, 500) + '...';
  }

  // H: 슬랙링크 (HYPERLINK 수식)
  var slackLink = match.permalink
    ? '=HYPERLINK("' + match.permalink + '","열기")'
    : '';

  // I: 채널명
  var channelName = match.channelName ? '#' + match.channelName : '';

  // J: ts (dedup용, 숨김)
  var ts = match.ts;

  sheet.appendRow([
    receivedAt,   // A
    requester,    // B
    assignees,    // C
    status,       // D
    dueDate,      // E
    notes,        // F
    messageText,  // G
    slackLink,    // H
    channelName,  // I
    ts,           // J
  ]);

  console.log('[시트] row 추가: ' + receivedAt + ' | ' + requester + ' → ' + assignees);
}

// ════════════════════════════════════════
// 보조 함수
// ════════════════════════════════════════

/**
 * Slack users.info API로 사용자 이름을 조회합니다.
 * 결과는 캐시(plain object)에 저장하여 중복 호출을 방지합니다.
 *
 * @param {string} userId         Slack User ID
 * @param {string} token          Slack User Token
 * @param {Object} cache          캐시 객체 (함수 호출 전 초기화: {})
 * @returns {string}              사용자 이름 (실패 시 userId 그대로 반환)
 */
function lookupUserName(userId, token, cache) {
  if (!userId) return '';

  // 캐시 히트
  if (cache && cache[userId]) {
    return cache[userId];
  }

  var url = 'https://slack.com/api/users.info?user=' + encodeURIComponent(userId);

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true,
    });

    var result = JSON.parse(response.getContentText());

    if (!result.ok) {
      console.log('[users.info] 조회 실패 (userId=' + userId + '): ' + result.error);
      if (cache) cache[userId] = userId;
      return userId;
    }

    var name = (result.user && result.user.real_name) ? result.user.real_name : userId;
    if (cache) cache[userId] = name;
    return name;

  } catch (e) {
    console.log('[users.info] 예외 (userId=' + userId + '): ' + e.message);
    if (cache) cache[userId] = userId;
    return userId;
  }
}

/**
 * Google Sheet J열(ts 컬럼)에서 기존 처리된 ts 집합을 읽어 반환합니다.
 * 중복 적재 방지를 위해 main()에서 최초 1회 호출합니다.
 *
 * @param {Sheet} sheet  Google Sheet 객체
 * @returns {Set}        ts 값들의 Set
 */
function loadProcessedTsSet(sheet) {
  var lastRow = sheet.getLastRow();
  var tsSet = {};  // GAS에는 Set 미지원 → plain object로 구현

  if (lastRow < 2) {
    return {
      has: function(v) { return !!tsSet[v]; },
      add: function(v) { tsSet[v] = true; },
      size: 0,
    };
  }

  // J열(10번째 컬럼) 전체 읽기
  var tsValues = sheet.getRange(2, 10, lastRow - 1, 1).getValues();
  var count = 0;

  for (var i = 0; i < tsValues.length; i++) {
    var v = tsValues[i][0];
    if (v) {
      tsSet[v.toString()] = true;
      count++;
    }
  }

  return {
    has: function(v) { return !!tsSet[v ? v.toString() : '']; },
    add: function(v) { if (v) { tsSet[v.toString()] = true; count++; } },
    size: count,
  };
}

/**
 * epoch seconds를 KST 기준 YYYY-MM-DD 문자열로 변환합니다.
 * Slack search.messages after: 파라미터에 사용합니다.
 *
 * @param {number} epochSeconds  Unix timestamp (seconds)
 * @returns {string}             KST 날짜 문자열 (yyyy-MM-dd)
 */
function tsToKstDate(epochSeconds) {
  if (!epochSeconds || epochSeconds <= 0) return '';
  return Utilities.formatDate(
    new Date(epochSeconds * 1000),
    'Asia/Seoul',
    'yyyy-MM-dd'
  );
}

// ════════════════════════════════════════
// 테스트 함수 (Apps Script UI에서 직접 실행)
// ════════════════════════════════════════

/**
 * 최근 7일치 멘션을 가져와 콘솔에 출력합니다 (시트 적재 없음).
 * 배포 전 Slack 연결 및 멘션 파싱이 정상인지 검증합니다.
 *
 * 확인 포인트:
 * - 콘솔 로그에 '[Slack] 멘션 N건 발견' 메시지 출력
 * - match 객체에 ts, text, channelName, mentionedTargets 포함
 */
function testFetchMentions() {
  console.log('=== testFetchMentions 시작 ===');

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_USER_TOKEN');
  var userIdsRaw = props.getProperty('WATCH_USER_IDS') || '';
  var subteamIdsRaw = props.getProperty('WATCH_SUBTEAM_IDS') || '';

  if (!token || token === 'xoxp-your-user-token-here') {
    console.log('[테스트] SLACK_USER_TOKEN이 설정되지 않았습니다.');
    return;
  }

  var watchUserIds = userIdsRaw ? userIdsRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var watchSubteamIds = subteamIdsRaw ? subteamIdsRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

  // 최근 7일치 (현재 시간 - 7일 epoch seconds)
  var sevenDaysAgo = (Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60).toString();

  try {
    var matches = fetchMentions(token, watchUserIds, watchSubteamIds, sevenDaysAgo);

    console.log('[테스트] 최근 7일 멘션: ' + matches.length + '건');

    // 최대 5건 출력
    var preview = matches.slice(0, 5);
    for (var i = 0; i < preview.length; i++) {
      var m = preview[i];
      console.log('  [' + (i + 1) + '] ts=' + m.ts +
        ' | 채널=#' + m.channelName +
        ' | 대상=' + (m.mentionedTargets.join(', ') || '(없음)') +
        ' | 원문=' + m.text.substring(0, 80).replace(/\n/g, ' '));
    }

    if (matches.length > 5) {
      console.log('  ... 나머지 ' + (matches.length - 5) + '건 생략');
    }

  } catch (e) {
    console.log('[테스트] 오류: ' + e.message);
  }

  console.log('=== testFetchMentions 완료 ===');
}

/**
 * 더미 row 1개를 시트에 직접 적재합니다 (Slack 호출 없음).
 * 시트 연결, 헤더, 드롭다운이 올바른지 확인합니다.
 * 테스트 완료 후 시트에서 해당 row를 수동으로 삭제하세요.
 */
function testWriteRow() {
  console.log('=== testWriteRow 시작 ===');

  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetName = props.getProperty('SHEET_NAME') || '멘션트래커';

  if (!spreadsheetId || spreadsheetId === 'your-spreadsheet-id-here') {
    console.log('[테스트] SPREADSHEET_ID가 설정되지 않았습니다.');
    return;
  }

  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    console.log('[테스트] 시트를 찾을 수 없습니다: ' + sheetName + '. setupSheet() 먼저 실행하세요.');
    return;
  }

  // 더미 match 객체
  var dummyMatch = {
    ts: '9999999999.000001',  // 미래 ts (구분용)
    text: '[테스트 메시지] @카드bizops @오유나 안녕하세요, 이 row는 testWriteRow()로 생성된 더미 row입니다. 확인 후 삭제하세요.',
    user: 'U_TESTER',
    channelId: 'C_TEST',
    channelName: 'test-channel',
    permalink: 'https://gowid.slack.com/archives/C_TEST/p9999999999000001',
    mentionedTargets: ['S_BIZOPS', 'U_OUNA'],
  };

  var namesMap = { 'S_BIZOPS': '카드bizops', 'U_OUNA': '오유나' };
  var userInfoCache = { 'U_TESTER': '테스트 사용자' };

  try {
    appendMentionRow(sheet, dummyMatch, namesMap, '', userInfoCache);
    console.log('[테스트] 더미 row 추가 완료. 시트에서 마지막 row를 확인하세요.');
    console.log('[테스트] 확인 후 해당 row를 수동으로 삭제하세요.');
  } catch (e) {
    console.log('[테스트] row 추가 실패: ' + e.message);
  }

  console.log('=== testWriteRow 완료 ===');
}

/**
 * 전체 파이프라인을 1회 실행하여 실제 멘션이 시트에 적재되는지 확인합니다.
 * 실제로 멘션이 존재해야 row가 추가됩니다.
 */
function testFullPipeline() {
  console.log('=== testFullPipeline 시작 ===');

  try {
    main();
    console.log('[테스트] main() 실행 완료. 시트에서 신규 row 추가 여부를 확인하세요.');
  } catch (e) {
    console.log('[테스트] main() 실행 중 오류: ' + e.message);
  }

  console.log('=== testFullPipeline 완료 ===');
}

/**
 * LAST_PROCESSED_TS를 '0'으로 리셋합니다.
 * 재테스트 시 최근 멘션을 다시 수집하려면 이 함수를 실행하세요.
 * 실행 후 시트의 기존 row를 모두 삭제해야 중복 적재가 방지됩니다.
 */
function resetLastProcessedTs() {
  PropertiesService.getScriptProperties().setProperty('LAST_PROCESSED_TS', '0');
  console.log('[리셋] LAST_PROCESSED_TS를 0으로 초기화했습니다.');
  console.log('[리셋] 중복 방지를 위해 시트의 기존 데이터 row(2행~)를 모두 삭제한 후 testFullPipeline을 실행하세요.');
}
