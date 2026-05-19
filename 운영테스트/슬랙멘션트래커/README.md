---
project: slack_mention_tracker
title: 슬랙 멘션 트래커
status: PROTOTYPE
created: 2026-05-13
---

# 슬랙 멘션 트래커

@카드bizops, @오유나, @신현덕, @김소은 멘션을 5분마다 자동으로 Google Sheet에 적재하는 Apps Script 프로토타입입니다.
**사전 준비부터 차례로 읽으세요.** 순서를 건너뛰면 동작하지 않습니다.

## 디렉토리 구조

```
슬랙멘션트래커/
├── README.md                        # 이 파일 — 배포·테스트 전체 절차
├── spec/
│   └── PRD.md                       # 시스템 명세 (아키텍처, 컬럼, 리스크)
└── prototype/
    └── slack_mention_tracker.gs     # Apps Script 코드 본체
```

---

## 사전 준비

### Step 1: Slack User Token 확인

crm-slack-bot에서 이미 사용 중인 **xoxp- User Token**을 그대로 재사용합니다.

```bash
cat ~/yuna-test/pm/context/card/operations/crm-slack-bot/.env | grep SLACK_USER_TOKEN
```

필요한 scope: `search:read`, `users:read`

scope가 부족하면 https://api.slack.com/apps → 앱 선택 → OAuth & Permissions → Scopes에서 추가 후 재발급.

---

### Step 2: 추적 대상 ID 조회

**개인 User ID 조회 (오유나, 신현덕, 김소은)**

Slack 클라이언트에서:
1. 해당 사람의 프로필 클릭
2. 우측 상단 점 세 개(...) 메뉴
3. **"Copy member ID"** 클릭 → `U0XXXXXXX` 형태

**사용자그룹(@카드bizops) ID 조회 — 방법 1: Admin 페이지**

브라우저에서 https://gowid.slack.com/admin/user_groups 접속 → `카드bizops` 클릭 → URL에서 `S0XXXXXXX` 부분 복사.

**사용자그룹(@카드bizops) ID 조회 — 방법 2: curl**

```bash
SLACK_USER_TOKEN="xoxp-여기에-토큰-붙여넣기"

curl -s -H "Authorization: Bearer $SLACK_USER_TOKEN" \
  "https://slack.com/api/usergroups.list" | \
  python3 -c "import sys,json; [print(g['id'], g['handle'], g['name']) for g in json.load(sys.stdin).get('usergroups',[])]"
```

출력 예시:
```
S067ABCDE  card-bizops  카드bizops
```

---

### Step 3: Google Sheet 생성

1. https://drive.google.com 접속
2. 좌측 상단 **+ 새로 만들기 → Google 스프레드시트 → 빈 스프레드시트**
3. 시트 이름 변경 (예: "슬랙 멘션 트래커")
4. URL 형태: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
5. `{SPREADSHEET_ID}` 부분 복사 (약 44자 영숫자 문자열)

---

## 배포 절차

### 1. Apps Script 프로젝트 생성

1. https://script.google.com 접속
2. **새 프로젝트** 클릭
3. 좌측 상단 프로젝트 이름 클릭 → "슬랙멘션트래커" 입력
4. `Code.gs` 파일 전체 내용 삭제
5. `prototype/slack_mention_tracker.gs` 내용 전체 복사 → `Code.gs`에 붙여넣기
6. Ctrl+S (저장)

### 2. Script Properties 입력

Apps Script 편집기 좌측 사이드바 → **프로젝트 설정 (톱니바퀴 아이콘)** → 스크롤 하단 → **스크립트 속성** → **스크립트 속성 추가**.

아래 7개 키를 모두 입력하세요:

| 키 | 값 예시 | 설명 |
|----|---------|------|
| `SLACK_USER_TOKEN` | `xoxp-0000-0000-...` | crm-slack-bot .env의 SLACK_USER_TOKEN |
| `SPREADSHEET_ID` | `1BxiMVs0XWrn...` | Step 3에서 복사한 Sheet ID |
| `SHEET_NAME` | `멘션트래커` | 시트 탭 이름 (기본값 유지 권장) |
| `WATCH_USER_IDS` | `U01ABC,U02DEF,U03GHI` | 오유나/신현덕/김소은 User ID 콤마 구분 |
| `WATCH_SUBTEAM_IDS` | `S067BIZOPS` | 카드bizops 사용자그룹 ID |
| `WATCH_NAMES_JSON` | `{"U01ABC":"오유나","U02DEF":"신현덕","U03GHI":"김소은","S067BIZOPS":"카드bizops"}` | ID→이름 매핑 JSON |
| `LAST_PROCESSED_TS` | `0` | 초기값 0 (자동 갱신됨, 변경 불필요) |

입력 완료 후 **저장** 클릭.

### 3. 필요 권한 동의

최초 함수 실행 시 Google OAuth 동의 화면이 나타납니다:
- **외부 데이터 액세스** (UrlFetchApp — Slack API 호출)
- **Google Sheets 편집** (SpreadsheetApp)

"계속" → 본인 Google 계정 선택 → "고급" → "슬랙멘션트래커(으)로 이동" → "허용" 클릭.

---

## 테스트 절차 (순서대로)

Apps Script 편집기 상단 함수 드롭다운에서 함수를 선택한 뒤 **실행(▶)** 버튼을 누릅니다.

### 1단계: `setupSheet` 실행

- **확인:** Google Sheet에 헤더 행(문의접수일 ~ ts)이 생성되고, D열에 드롭다운이 설정되며, 첫 행이 고정됩니다.
- **확인:** 헤더가 굵게 + 회색 배경으로 표시됩니다.

### 2단계: `testFetchMentions` 실행

- **확인:** Apps Script 하단 **실행 로그**에 `[Slack] 멘션 N건 발견` 메시지가 출력됩니다.
- **확인:** match 객체(ts, 채널명, 처리담당자, 원문 앞 80자)가 최대 5건 출력됩니다.
- **시트 변화 없음** — 이 단계에서 row가 추가되면 안 됩니다.

오류 발생 시:
- `not_authed` → SLACK_USER_TOKEN 재확인
- `missing_scope` → search:read, users:read scope 추가

### 3단계: `testWriteRow` 실행

- **확인:** 시트 마지막 행에 더미 row 1개가 추가됩니다.
  - 문의접수일: `2286-11-21 09:46:39` (ts=9999999999)
  - 요청자: `테스트 사용자`
  - 처리담당자: `카드bizops, 오유나`
  - 진행상황: `미확인` (빨강 배경)
  - 메시지원문: `[테스트 메시지] ...`
- **이후:** 시트에서 해당 더미 row를 **수동으로 삭제**하세요.

### 4단계: `testFullPipeline` 실행

- **확인:** `main()`이 1회 실행되며, 실제 멘션이 존재하면 시트에 row가 추가됩니다.
- 멘션이 없으면 `[main] 새 멘션 없음` 로그가 출력됩니다.
- `resetLastProcessedTs()` 실행 후 재시도하면 최근 7일치 멘션을 다시 수집합니다.

### 5단계: `setupTrigger` 실행 → 자동화 시작

- **확인:** Apps Script 편집기 좌측 **트리거 (시계 아이콘)** 메뉴에서 `main` 함수의 5분 트리거가 등록되어 있습니다.
- 이후 5분마다 신규 멘션이 자동으로 시트에 추가됩니다.

---

## 운영 가이드

- **진행상황 갱신:** D열 드롭다운에서 미확인 → 확인 → 처리중 → 완료 순서로 선택합니다. 값 변경 시 색상이 즉시 바뀝니다.
- **신규 멘션:** 5분마다 자동으로 row가 추가됩니다. 시트를 새로고침하면 최신 row가 보입니다.
- **재테스트 필요 시:** `resetLastProcessedTs()` 실행 → 시트 데이터 row(2행~) 전체 삭제 → `testFullPipeline` 재실행.
- **트리거 일시 정지:** Apps Script 편집기 → 트리거 메뉴 → 해당 트리거 삭제. 재시작 시 `setupTrigger()` 재실행.

---

## 트러블슈팅

| 증상 | 원인 | 해결 방법 |
|------|------|----------|
| `Slack API 오류: not_authed` | 토큰 미설정 또는 만료 | SLACK_USER_TOKEN 재확인, xoxp-로 시작하는지 확인 |
| `Slack API 오류: missing_scope` | 토큰에 scope 부족 | api.slack.com/apps → OAuth & Permissions → search:read, users:read 추가 후 재발급 |
| 시트에 row가 추가 안 됨 | SPREADSHEET_ID 오류 또는 권한 없음 | SPREADSHEET_ID 재확인, Apps Script 실행 계정이 시트 편집 권한 있는지 확인 |
| 같은 멘션이 두 번 적재됨 | ts 컬럼(J열) 비어있음 | setupSheet() 재실행 → J열 데이터 갱신 |
| 요청자 이름이 User ID로 표시됨 | users.info 호출 실패 | token에 users:read scope 확인. 정상 scope이면 일시적 오류로 다음 주기에 해결 |
| 처리담당자가 ID로 표시됨 | WATCH_NAMES_JSON 매핑 누락 | WATCH_NAMES_JSON에 해당 ID 추가 (setupProperties 재실행 불필요, Properties에서 직접 수정) |
| `setupSheet() 실행 오류` | SPREADSHEET_ID 미설정 | Properties 확인 후 setupSheet 재실행 |

---

## Phase 2 후보 (피드백 후 결정)

- **스레드 자동 답장:** 멘션 발생 시 "접수되었습니다. 시트 링크: ..." 자동 답변
- **완료 DM 알림:** 진행상황 → 완료 변경 시 요청자에게 자동 DM
- **우선순위 자동 분류:** "긴급", "ASAP" 등 키워드 기반 자동 태그
- **AI 요약:** Anthropic Haiku로 메시지 3줄 요약
- **card-squad 어드민 임베드:** `/admin/mentions` 페이지에서 시트 현황 조회

---

## 변경 이력

| 날짜 | 변경 내용 | 작성자 |
|------|----------|--------|
| 2026-05-13 | Phase 1 프로토타입 초안 작성 (Apps Script + PRD + README) | AI |
