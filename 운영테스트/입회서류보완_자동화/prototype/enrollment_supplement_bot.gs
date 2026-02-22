/**
 * ============================================================
 * 입회서류보완 자동 안내 봇 (Google Apps Script)
 * ============================================================
 *
 * 슬랙 채널(bot-카드사-입회서류보완)을 모니터링하여
 * 카드사 서류보완 요청 시 고객에게 자동 안내 메일을 발송합니다.
 *
 * 실제 슬랙 메시지 포맷 (2026-02-22 확인):
 * ─────────────────────────────────────────
 * > *[롯데_입회서류 보완 알림]*
 * >
 * >  법인명: 주식회사 XXX
 * >  사업자번호: 123-45-67890
 * >  서류보완메모: 사실상지배자리스트 첨부 및 전산등록 요청
 * ─────────────────────────────────────────
 *
 * 설정 방법:
 * 1. Google Apps Script 프로젝트 생성 (script.google.com)
 * 2. 이 코드를 붙여넣기
 * 3. 고급 서비스에서 BigQuery API 활성화 (리소스 > 고급 Google 서비스)
 * 4. Script Properties에 설정값 입력 (setupProperties 함수 실행)
 * 5. setupTrigger() 실행하여 5분 간격 트리거 등록
 *
 * 필요한 권한:
 * - Gmail 발송 (GmailApp)
 * - Google Drive 폴더 생성 (DriveApp)
 * - 외부 HTTP 요청 (UrlFetchApp) - Slack API
 * - BigQuery (Advanced Service) - 고객 이메일 조회
 */

// ============================================================
// 설정
// ============================================================

/**
 * 초기 설정값을 Script Properties에 저장합니다.
 * 최초 1회 수동 실행 후, 각 값을 실제 값으로 수정하세요.
 */
function setupProperties() {
  var props = PropertiesService.getScriptProperties();

  props.setProperties({
    'SLACK_BOT_TOKEN': 'xoxb-your-slack-bot-token',     // 슬랙 봇 토큰
    'SLACK_CHANNEL_ID': 'C057EMUTZQR',                  // bot-카드사-입회서류보완 채널 ID
    'DRIVE_ROOT_FOLDER_ID': 'your-drive-folder-id',     // 서류 업로드 루트 폴더 ID
    'CC_EMAILS': '',                                      // 참조 이메일 (쉼표 구분)
    'BIGQUERY_PROJECT_ID': 'gowid-prd',                  // BigQuery 프로젝트 ID
    'LAST_PROCESSED_TS': '0',                             // 마지막 처리한 메시지 타임스탬프
  });

  Logger.log('Properties 설정 완료. Script Properties에서 실제 값으로 수정하세요.');
}

/**
 * 5분 간격 트리거를 등록합니다. 최초 1회 수동 실행.
 */
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'main') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('main')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('5분 간격 트리거 등록 완료');
}

// ============================================================
// 메인 실행 함수
// ============================================================

/**
 * 메인 함수 - 트리거에 의해 5분마다 실행됩니다.
 */
function main() {
  var props = PropertiesService.getScriptProperties();
  var slackToken = props.getProperty('SLACK_BOT_TOKEN');
  var channelId = props.getProperty('SLACK_CHANNEL_ID');
  var lastTs = props.getProperty('LAST_PROCESSED_TS') || '0';

  if (!slackToken || slackToken === 'xoxb-your-slack-bot-token') {
    Logger.log('SLACK_BOT_TOKEN이 설정되지 않았습니다.');
    return;
  }

  // 1. 슬랙 채널에서 새 메시지 가져오기
  var messages = fetchSlackMessages(slackToken, channelId, lastTs);

  if (messages.length === 0) {
    Logger.log('새 메시지 없음');
    return;
  }

  Logger.log(messages.length + '개의 새 메시지 발견');

  var latestTs = lastTs;

  // 2. 각 메시지 처리
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    try {
      // 봇 메시지만 처리 (사람이 쓴 메시지 무시)
      if (!msg.bot_id && msg.subtype !== 'bot_message') {
        continue;
      }

      // 메시지 파싱
      var parsed = parseSupplementMessage(msg.text);

      if (!parsed) {
        Logger.log('파싱 실패 (보완요청 메시지가 아닐 수 있음): ' + msg.ts);
        continue;
      }

      // 중복 체크
      if (isDuplicate(parsed.businessNumber)) {
        Logger.log('중복 발송 방지: ' + parsed.businessNumber);
        continue;
      }

      // 3. BigQuery에서 고객 이메일 조회
      var email = lookupCustomerEmail(parsed.businessNumber);
      if (!email) {
        Logger.log('이메일 조회 실패: ' + parsed.corpName + ' (' + parsed.businessNumber + ')');
        postSlackThread(slackToken, channelId, msg.ts,
          '⚠️ *이메일 조회 실패 - 수기 처리 필요*\n' +
          '• 법인: ' + parsed.corpName + '\n' +
          '• 사업자번호: ' + parsed.businessNumber + '\n' +
          '• 원인: BigQuery에서 해당 법인의 관리자 이메일을 찾을 수 없음');
        continue;
      }
      parsed.email = email;

      // 4. Google Drive 폴더 생성
      var folder = createDriveFolder(parsed);

      // 5. 안내 이메일 발송
      sendNotificationEmail(parsed, folder.url);

      // 6. 슬랙에 처리 완료 알림
      postSlackThread(slackToken, channelId, msg.ts, formatCompletionMessage(parsed, folder.url));

      // 7. 중복 방지 기록
      markAsProcessed(parsed.businessNumber);

      Logger.log('처리 완료: ' + parsed.corpName);

    } catch (e) {
      Logger.log('처리 중 오류: ' + e.message);
      try {
        postSlackThread(slackToken, channelId, msg.ts, formatErrorMessage(e.message));
      } catch (e2) {
        Logger.log('슬랙 알림 발송도 실패: ' + e2.message);
      }
    }

    // 최신 타임스탬프 갱신
    if (parseFloat(msg.ts) > parseFloat(latestTs)) {
      latestTs = msg.ts;
    }
  }

  // 마지막 처리 타임스탬프 저장
  props.setProperty('LAST_PROCESSED_TS', latestTs);
}

// ============================================================
// Slack API
// ============================================================

function fetchSlackMessages(token, channelId, oldestTs) {
  var url = 'https://slack.com/api/conversations.history' +
    '?channel=' + channelId +
    '&oldest=' + oldestTs +
    '&limit=20' +
    '&inclusive=false';

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });

  var result = JSON.parse(response.getContentText());

  if (!result.ok) {
    throw new Error('Slack API 오류: ' + result.error);
  }

  // 오래된 것부터 처리하기 위해 역순 정렬
  return (result.messages || []).reverse();
}

function postSlackThread(token, channelId, threadTs, text) {
  var url = 'https://slack.com/api/chat.postMessage';

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({
      channel: channelId,
      thread_ts: threadTs,
      text: text,
    }),
    muteHttpExceptions: true,
  });

  var result = JSON.parse(response.getContentText());
  if (!result.ok) {
    Logger.log('Slack 스레드 답글 실패: ' + result.error);
  }
}

// ============================================================
// 메시지 파싱 (실제 포맷 기반)
// ============================================================

/**
 * 실제 슬랙 봇 메시지를 파싱합니다.
 *
 * 실제 포맷:
 * > *[롯데_입회서류 보완 알림]*
 * >
 * >  법인명: 주식회사 XXX
 * >  사업자번호: 123-45-67890
 * >  서류보완메모: 사실상지배자리스트 첨부 및 전산등록 요청
 *
 * 멀티라인 메모 예시:
 * >  서류보완메모: 1. '24년 재무제표 전산등록후 재심사 요청
 * 2. 사실상지배자리스트 첨부 및 전산등록 요청
 *
 * 반환: { cardCompany, corpName, businessNumber, supplementMemo, email }
 * 파싱 실패 시: null
 */
function parseSupplementMessage(text) {
  if (!text) return null;

  // 슬랙 마크다운 정리
  var cleanText = text
    .replace(/&gt;\s*/g, '')           // HTML 엔코딩된 > 제거
    .replace(/^>\s*/gm, '')            // 인용 블록 제거
    .replace(/\*([^*]+)\*/g, '$1');    // 볼드 제거

  // 헤더에서 카드사 추출: [롯데_입회서류 보완 알림] 또는 [BC_입회서류 보완 알림]
  var headerMatch = cleanText.match(/\[([^_]+)_입회서류\s*보완\s*알림\]/);
  if (!headerMatch) return null;

  var cardCompany = headerMatch[1].trim(); // "롯데", "BC" 등

  // 필드 추출
  var corpName = extractField(cleanText, /법인명\s*[:：]\s*(.+)/);
  var businessNumber = extractField(cleanText, /사업자번호\s*[:：]\s*([\d\-]+)/);

  // 서류보완메모 추출 (멀티라인 지원)
  var supplementMemo = extractSupplementMemo(cleanText);

  // 필수 필드 검증
  if (!corpName || !businessNumber) {
    Logger.log('필수 필드 부족: 법인명=' + corpName + ', 사업자번호=' + businessNumber);
    return null;
  }

  return {
    cardCompany: cardCompany,
    corpName: corpName.trim(),
    businessNumber: businessNumber.trim(),
    supplementMemo: supplementMemo || '(메모 없음)',
    email: '', // BigQuery에서 별도 조회
  };
}

function extractField(text, regex) {
  var match = text.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * 서류보완메모를 추출합니다.
 * 메모가 멀티라인인 경우 (번호 매기기) 전체를 합칩니다.
 *
 * 케이스 1 (단일 라인):
 *   서류보완메모: 사실상지배자리스트 첨부 및 전산등록 요청
 *
 * 케이스 2 (멀티라인):
 *   서류보완메모: 1. '24년 재무제표 전산등록후 재심사 요청
 *   2. 사실상지배자리스트 첨부 및 전산등록 요청
 */
function extractSupplementMemo(text) {
  var lines = text.split('\n');
  var memoLines = [];
  var inMemo = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    if (/서류보완메모\s*[:：]/.test(line)) {
      // 서류보완메모 시작 - 콜론 뒤 내용 추출
      var afterColon = line.replace(/.*서류보완메모\s*[:：]\s*/, '');
      if (afterColon) {
        memoLines.push(afterColon.trim());
      }
      inMemo = true;
      continue;
    }

    if (inMemo) {
      // 다음 필드가 나오면 종료
      if (/^(법인명|사업자번호|카드종류|메일)\s*[:：]/.test(line)) {
        break;
      }
      // 빈 줄이면 종료
      if (line === '') {
        break;
      }
      // 번호 매기기(2. xxx) 또는 연속 텍스트
      if (/^\d+\.\s*/.test(line) || line.length > 0) {
        memoLines.push(line);
      }
    }
  }

  return memoLines.join('\n');
}

// ============================================================
// BigQuery 이메일 조회
// ============================================================

/**
 * 사업자번호로 BigQuery에서 고객(관리자) 이메일을 조회합니다.
 *
 * 조회 로직:
 * 1. 사업자번호(하이픈 제거) → dw_dimension.corporation에서 corp_id 조회
 * 2. corp_id → dw_dimension.user에서 슈퍼 관리자 또는 카드 총괄관리자 이메일 조회
 *
 * BigQuery Advanced Service 필요 (고급 서비스 활성화 필수)
 */
function lookupCustomerEmail(businessNumber) {
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('BIGQUERY_PROJECT_ID') || 'gowid-prd';

  // 사업자번호에서 하이픈 제거 → corp_id (INT64)
  var corpId = businessNumber.replace(/-/g, '');

  var sql =
    'SELECT u.email, u.name, u.role ' +
    'FROM `gowid-prd.dw_dimension.user` u ' +
    'WHERE u.corp_id = ' + corpId + ' ' +
    '  AND u.is_deleted = false ' +
    '  AND u.status = "ACTIVE" ' +
    '  AND u.is_email_allowed = 1 ' +
    '  AND ("슈퍼 관리자" IN UNNEST(u.role) OR "카드 총괄관리자" IN UNNEST(u.role)) ' +
    'ORDER BY ' +
    '  CASE WHEN "슈퍼 관리자" IN UNNEST(u.role) THEN 0 ELSE 1 END, ' +
    '  u.created_at ASC ' +
    'LIMIT 1';

  try {
    var request = { query: sql, useLegacySql: false };
    var queryResults = BigQuery.Jobs.query(request, projectId);

    if (queryResults.totalRows > 0 && queryResults.rows && queryResults.rows.length > 0) {
      var email = queryResults.rows[0].f[0].v;
      var name = queryResults.rows[0].f[1].v;
      Logger.log('이메일 조회 성공: ' + name + ' <' + email + '>');
      return email;
    }

    // 슈퍼관리자/카드총괄이 없으면 아무 활성 사용자라도 찾기
    var fallbackSql =
      'SELECT u.email, u.name ' +
      'FROM `gowid-prd.dw_dimension.user` u ' +
      'WHERE u.corp_id = ' + corpId + ' ' +
      '  AND u.is_deleted = false ' +
      '  AND u.status = "ACTIVE" ' +
      '  AND u.is_email_allowed = 1 ' +
      'ORDER BY u.created_at ASC ' +
      'LIMIT 1';

    var fallbackResults = BigQuery.Jobs.query({ query: fallbackSql, useLegacySql: false }, projectId);

    if (fallbackResults.totalRows > 0 && fallbackResults.rows && fallbackResults.rows.length > 0) {
      var fbEmail = fallbackResults.rows[0].f[0].v;
      var fbName = fallbackResults.rows[0].f[1].v;
      Logger.log('이메일 폴백 조회 성공: ' + fbName + ' <' + fbEmail + '>');
      return fbEmail;
    }

    Logger.log('이메일 조회 결과 없음: corp_id=' + corpId);
    return null;

  } catch (e) {
    Logger.log('BigQuery 조회 오류: ' + e.message);
    return null;
  }
}

// ============================================================
// Google Drive
// ============================================================

function createDriveFolder(parsed) {
  var props = PropertiesService.getScriptProperties();
  var rootFolderId = props.getProperty('DRIVE_ROOT_FOLDER_ID');

  if (!rootFolderId || rootFolderId === 'your-drive-folder-id') {
    throw new Error('DRIVE_ROOT_FOLDER_ID가 설정되지 않았습니다.');
  }

  var rootFolder = DriveApp.getFolderById(rootFolderId);

  // 폴더명: {법인명}_{사업자번호}_{날짜}
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var bizNum = parsed.businessNumber.replace(/-/g, '');
  var folderName = parsed.corpName + '_' + bizNum + '_' + today;

  var folder = rootFolder.createFolder(folderName);

  // 안내 파일 생성
  var guideContent = createUploadGuide(parsed);
  folder.createFile('서류_업로드_안내.txt', guideContent, MimeType.PLAIN_TEXT);

  // 공유 설정: 링크가 있는 모든 사용자가 편집 가능
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);

  return {
    id: folder.getId(),
    url: folder.getUrl(),
    name: folderName,
  };
}

function createUploadGuide(parsed) {
  var cardName = getCardCompanyName(parsed.cardCompany);

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '  ' + parsed.corpName + ' - ' + cardName + ' 입회서류 보완',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '카드사 요청 내용:',
    parsed.supplementMemo,
    '',
    '이 폴더에 해당 서류를 업로드해 주세요.',
    '',
    '※ 파일 형식: PDF, JPG, PNG 권장',
    '※ 파일명에 서류 종류를 포함해 주시면 처리가 빨라집니다.',
    '   예) 재무제표_2025.pdf, 주주명부.pdf',
    '',
    '문의: help@gowid.com',
  ].join('\n');
}

// ============================================================
// 이메일 발송
// ============================================================

function sendNotificationEmail(parsed, driveUrl) {
  if (!parsed.email) {
    throw new Error('이메일 주소가 없어 메일 발송 불가 (법인: ' + parsed.corpName + ')');
  }

  var props = PropertiesService.getScriptProperties();
  var ccEmails = props.getProperty('CC_EMAILS') || '';

  var cardName = getCardCompanyName(parsed.cardCompany);
  var subject = '[고위드] ' + parsed.corpName + '님, ' + cardName + ' 입회서류 보완 안내';

  var htmlBody = buildEmailHtml(parsed, driveUrl);
  var plainBody = buildEmailPlain(parsed, driveUrl);

  var options = {
    htmlBody: htmlBody,
    name: '고위드',
  };

  if (ccEmails) {
    options.cc = ccEmails;
  }

  GmailApp.sendEmail(parsed.email, subject, plainBody, options);
  Logger.log('메일 발송 완료: ' + parsed.email);
}

function getCardCompanyName(cardCompany) {
  if (/롯데/i.test(cardCompany)) return '롯데카드';
  if (/BC|비씨/i.test(cardCompany)) return 'BC카드';
  if (/신한/i.test(cardCompany)) return '신한카드';
  if (/삼성/i.test(cardCompany)) return '삼성카드';
  return cardCompany + '카드';
}

function buildEmailHtml(parsed, driveUrl) {
  var cardName = getCardCompanyName(parsed.cardCompany);

  // 서류보완메모를 HTML로 변환 (번호 매기기 지원)
  var memoHtml = parsed.supplementMemo
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Noto Sans KR\',sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;padding:20px;">' +

    // 헤더
    '<div style="background:#1a1a2e;padding:24px 32px;border-radius:12px 12px 0 0;">' +
    '<h1 style="margin:0;color:#fff;font-size:18px;font-weight:600;">입회서류 보완 안내</h1>' +
    '<p style="margin:6px 0 0;color:#a0a0c0;font-size:13px;">고위드 법인카드 서비스</p>' +
    '</div>' +

    // 본문
    '<div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">' +

    '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#333;">' +
    '안녕하세요, <strong>' + parsed.corpName + '</strong> 담당자님.</p>' +

    '<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#333;">' +
    '고위드 법인카드 서비스를 이용해 주셔서 감사합니다.<br>' +
    cardName + ' 입회 심사 과정에서 아래 내용에 대한 서류 보완이 필요하다는 안내를 받았습니다.</p>' +

    // 보완 내용
    '<div style="margin:0 0 24px;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden;">' +
    '<div style="background:#f8f9fa;padding:12px 16px;border-bottom:1px solid #e8e8e8;">' +
    '<strong style="color:#333;font-size:14px;">카드사 요청 내용</strong></div>' +
    '<div style="padding:16px;font-size:14px;line-height:1.8;color:#333;">' +
    memoHtml + '</div></div>' +

    // CTA 버튼
    '<div style="margin:28px 0;text-align:center;">' +
    '<p style="margin:0 0 12px;font-size:14px;color:#666;">아래 버튼을 클릭하시면 전용 업로드 폴더로 이동합니다.</p>' +
    '<a href="' + driveUrl + '" style="display:inline-block;padding:14px 36px;background:#4285f4;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">' +
    '서류 업로드하기</a></div>' +

    // 안내 사항
    '<div style="margin:24px 0 0;padding:16px 20px;background:#f8f9fa;border-radius:8px;font-size:13px;color:#666;line-height:1.8;">' +
    '<strong style="color:#333;">안내 사항</strong><br>' +
    '&bull; 서류는 가급적 <strong>3영업일 이내</strong>에 제출해 주시면 입회 처리가 원활하게 진행됩니다.<br>' +
    '&bull; 서류 업로드 후 별도 회신은 필요 없습니다. 업로드가 확인되면 자동으로 처리를 진행합니다.<br>' +
    '&bull; 파일 형식은 PDF, JPG, PNG를 권장합니다.<br>' +
    '&bull; 서류 관련 문의: <a href="mailto:help@gowid.com" style="color:#4285f4;">help@gowid.com</a> 또는 ' +
    '<a href="https://gowid.com" style="color:#4285f4;">gowid.com</a> 우측 하단 채팅</div>' +

    '<p style="margin:24px 0 0;font-size:14px;color:#333;">감사합니다.<br><strong>고위드 팀</strong> 드림</p>' +

    '</div>' +

    // 푸터
    '<div style="padding:16px 32px;text-align:center;font-size:11px;color:#999;">' +
    '<p style="margin:0;">본 메일은 고위드 법인카드 서비스 관련 자동 발송 메일입니다.</p>' +
    '<p style="margin:4px 0 0;">주식회사 고위드 | help@gowid.com</p>' +
    '</div>' +

    '</div></body></html>';
}

function buildEmailPlain(parsed, driveUrl) {
  var cardName = getCardCompanyName(parsed.cardCompany);

  return [
    '안녕하세요, ' + parsed.corpName + ' 담당자님.',
    '',
    '고위드 법인카드 서비스를 이용해 주셔서 감사합니다.',
    cardName + ' 입회 심사 과정에서 아래 내용에 대한 서류 보완이 필요하다는 안내를 받았습니다.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '카드사 요청 내용:',
    parsed.supplementMemo,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '서류 제출 방법',
    '',
    '아래 링크를 클릭하시면 전용 업로드 폴더로 이동합니다.',
    '해당 폴더에 보완 서류를 업로드해 주세요.',
    '',
    '서류 업로드 바로가기: ' + driveUrl,
    '',
    '※ 서류 업로드 후 별도 회신은 필요 없습니다.',
    '  업로드가 확인되면 자동으로 처리를 진행합니다.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '안내 사항',
    '• 서류는 가급적 3영업일 이내에 제출해 주시면 원활하게 진행됩니다.',
    '• 파일 형식: PDF, JPG, PNG 권장',
    '• 문의: help@gowid.com 또는 gowid.com 우측 하단 채팅',
    '',
    '감사합니다.',
    '고위드 팀 드림',
  ].join('\n');
}

// ============================================================
// 중복 방지
// ============================================================

function isDuplicate(businessNumber) {
  if (!businessNumber) return false;

  var props = PropertiesService.getScriptProperties();
  var key = 'SENT_' + businessNumber.replace(/-/g, '');
  var lastSent = props.getProperty(key);

  if (!lastSent) return false;

  var lastSentTime = parseInt(lastSent, 10);
  var now = new Date().getTime();
  var hoursDiff = (now - lastSentTime) / (1000 * 60 * 60);

  return hoursDiff < 24;
}

function markAsProcessed(businessNumber) {
  if (!businessNumber) return;

  var props = PropertiesService.getScriptProperties();
  var key = 'SENT_' + businessNumber.replace(/-/g, '');
  props.setProperty(key, new Date().getTime().toString());
}

// ============================================================
// 알림 메시지 포맷
// ============================================================

function formatCompletionMessage(parsed, driveUrl) {
  return '✅ *자동 안내 메일 발송 완료*\n' +
    '• 수신자: ' + parsed.email + '\n' +
    '• 법인명: ' + parsed.corpName + '\n' +
    '• 카드사: ' + getCardCompanyName(parsed.cardCompany) + '\n' +
    '• 보완 내용: ' + parsed.supplementMemo.replace(/\n/g, ', ') + '\n' +
    '• Drive 폴더: ' + driveUrl + '\n' +
    '• 발송 시각: ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

function formatErrorMessage(errorMsg) {
  return '⚠️ *자동 처리 실패 - 수기 처리 필요*\n' +
    '• 원인: ' + errorMsg + '\n' +
    '• 시각: ' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + '\n' +
    '• 조치: 이 메시지의 원본을 확인하고 수기로 고객에게 안내해 주세요.';
}

// ============================================================
// 테스트 함수
// ============================================================

/**
 * 실제 슬랙 메시지 포맷으로 파서를 테스트합니다.
 */
function testParser() {
  // 실제 메시지 포맷 - 단일 라인 메모
  var msg1 = '> *[롯데_입회서류 보완 알림]*\n>\n> 법인명: 주식회사 메이져세븐컴퍼니 \n> 사업자번호: 372-86-00836 \n> 서류보완메모: 최근재무제표 전산등록 요청 \n';

  // 실제 메시지 포맷 - 멀티 라인 메모
  var msg2 = '> *[롯데_입회서류 보완 알림]*\n>\n> 법인명: 주식회사 베를로 \n> 사업자번호: 420-87-02727 \n> 서류보완메모: 1. \'24년 재무제표 전산등록후 재심사 요청\n2. 사실상지배자리스트 첨부 및 전산등록 요청 \n';

  // 영문 법인명 포함
  var msg3 = '> *[롯데_입회서류 보완 알림]*\n>\n> 법인명: 주식회사 금자(GEUMJA Co., Ltd.) \n> 사업자번호: 155-86-03539 \n> 서류보완메모: 사실상지배자리스트 첨부 및 전산등록 요청 \n';

  var tests = [
    { name: '단일 라인 메모', msg: msg1 },
    { name: '멀티 라인 메모', msg: msg2 },
    { name: '영문 법인명 포함', msg: msg3 },
  ];

  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    Logger.log('\n=== 테스트 ' + (i + 1) + ': ' + t.name + ' ===');
    var result = parseSupplementMessage(t.msg);
    if (result) {
      Logger.log('  카드사: ' + result.cardCompany);
      Logger.log('  법인명: ' + result.corpName);
      Logger.log('  사업자번호: ' + result.businessNumber);
      Logger.log('  서류보완메모: ' + result.supplementMemo);
    } else {
      Logger.log('  파싱 실패!');
    }
  }
}

/**
 * BigQuery 이메일 조회를 테스트합니다.
 * 실제 사업자번호로 테스트하세요.
 */
function testEmailLookup() {
  var email = lookupCustomerEmail('372-86-00836'); // 주식회사 메이져세븐컴퍼니
  Logger.log('조회 결과: ' + (email || '없음'));
}

/**
 * 본인 이메일로 테스트 메일을 발송합니다.
 */
function testEmailSend() {
  var testParsed = {
    cardCompany: '롯데',
    corpName: '주식회사 테스트',
    businessNumber: '000-00-00000',
    email: Session.getActiveUser().getEmail(),
    supplementMemo: '1. 최근재무제표 전산등록 요청\n2. 사실상지배자리스트 첨부 및 전산등록 요청',
  };

  var testDriveUrl = 'https://drive.google.com/drive/folders/example';
  sendNotificationEmail(testParsed, testDriveUrl);
  Logger.log('테스트 이메일 발송 완료: ' + testParsed.email);
}

/**
 * 전체 파이프라인을 실제 메시지 포맷으로 시뮬레이션합니다.
 */
function testFullPipeline() {
  Logger.log('=== 전체 파이프라인 테스트 시작 ===');

  var sampleMessage = '> *[롯데_입회서류 보완 알림]*\n>\n> 법인명: 테스트 주식회사 \n> 사업자번호: 000-00-00000 \n> 서류보완메모: 최근재무제표 전산등록 요청 \n';

  // 1. 파싱
  var parsed = parseSupplementMessage(sampleMessage);
  Logger.log('1. 파싱: ' + JSON.stringify(parsed));
  if (!parsed) { Logger.log('파싱 실패. 중단.'); return; }

  // 2. 이메일 (테스트용으로 본인 이메일)
  parsed.email = Session.getActiveUser().getEmail();
  Logger.log('2. 이메일: ' + parsed.email);

  // 3. Drive 폴더
  var folder = createDriveFolder(parsed);
  Logger.log('3. 폴더: ' + folder.url);

  // 4. 이메일 발송
  sendNotificationEmail(parsed, folder.url);
  Logger.log('4. 이메일 발송 완료');

  Logger.log('=== 전체 파이프라인 테스트 완료 ===');
}
