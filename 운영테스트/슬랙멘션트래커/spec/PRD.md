---
title: 슬랙 멘션 트래커 PRD
version: 1.0.0
status: DRAFT
owner: 카드 운영팀
last_updated: 2026-05-13
---

# 슬랙 멘션 트래커

## 1. 개요 및 배경

Slack FUEL Lead 앱 벤치마크. 운영팀이 @카드bizops, @오유나, @신현덕, @김소은에 대한
멘션을 놓치지 않고, 진척 상황을 Google Sheet 현황판으로 관리할 수 있게 한다.

**문제**: 슬랙 멘션이 여러 채널에 흩어져 있어 담당자가 놓치거나 처리 현황 파악이 어려움.

**해결**: Apps Script가 5분마다 Slack 워크스페이스를 폴링 → 신규 멘션을 시트에 자동 적재.

---

## 2. 추적 대상

| 구분 | 슬랙 핸들 | ID 타입 | 조회 방법 |
|------|----------|---------|----------|
| 사용자그룹 | @카드bizops | S-prefix | admin/user_groups 또는 usergroups.list API |
| 개인 | @오유나 | U-prefix | Slack 프로필 → Copy member ID |
| 개인 | @신현덕 | U-prefix | Slack 프로필 → Copy member ID |
| 개인 | @김소은 | U-prefix | Slack 프로필 → Copy member ID |

---

## 3. 시트 컬럼 (9개 + dedup ts 1개)

| # | 컬럼명 | 열 | 입력 방식 | 비고 |
|---|--------|-----|----------|------|
| 1 | 문의접수일(KST) | A | 자동 | Slack ts → KST yyyy-MM-dd HH:mm:ss |
| 2 | 요청자 | B | 자동 | users.info real_name (실패 시 userId) |
| 3 | 처리담당자 | C | 자동 | 멘션된 ID → WATCH_NAMES_JSON 매핑, 콤마 구분 |
| 4 | 진행상황 | D | 드롭다운 | 5단계 + 조건부 서식 색상 |
| 5 | 완료예정일 | E | 수동 | 운영자 직접 입력 |
| 6 | 특이사항 | F | 수동 | 운영자 직접 입력 |
| 7 | 메시지원문 | G | 자동 | 500자 truncate |
| 8 | 슬랙링크 | H | 자동 | `=HYPERLINK("permalink","열기")` 수식 |
| 9 | 채널명 | I | 자동 | `#channel-name` |
| 10 | ts | J | 자동 | Slack 메시지 ts (dedup용, 열 숨김) |

---

## 4. 진행상황 드롭다운 5단계

| 값 | 배경색 | 의미 |
|----|--------|------|
| 미확인 | 빨강 (#f4cccc) | 아직 확인 안 됨 (기본값) |
| 확인 | 없음 | 담당자가 확인함 |
| 처리중 | 노랑 (#fff2cc) | 처리 진행 중 |
| 완료 | 초록 (#d9ead3) | 처리 완료 |
| 보류 | 회색 (#d9d9d9) | 보류/대기 |

---

## 5. 시스템 아키텍처

| 컴포넌트 | 기술 | 이유 |
|---------|------|------|
| 폴링 엔진 | Apps Script time-driven trigger (5분) | 무료, 서버리스, Google Workspace 네이티브 |
| 멘션 검색 | Slack search.messages (User Token xoxp-) | 워크스페이스 전체 검색, search:read scope |
| 저장소 | Google Sheet | 운영자가 즉시 편집 가능, 드롭다운/서식 지원 |
| 사용자명 조회 | Slack users.info (캐시) | 요청자 실명 표시, 세션 내 캐시로 중복 API 호출 방지 |
| 중복방지 | ScriptProperties LAST_PROCESSED_TS + 시트 ts 컬럼 Set | 이중 가드로 재시작/재배포 시에도 중복 적재 방지 |

---

## 6. Slack Query 설계

```
(<@U_OUNA> OR <@U_HJ> OR <@U_SE> OR <!subteam^S_BIZOPS>) after:YYYY-MM-DD
```

- 정렬: `sort=timestamp&sort_dir=asc` (오래된 것부터 처리)
- 페이지 크기: `count=100`
- after: LAST_PROCESSED_TS → KST yyyy-MM-dd 변환값 사용
- 복수 대상이 동시 멘션: mentionedTargets 배열에 모두 포함 → 처리담당자 콤마 구분 표기

---

## 7. Properties 설정값

| 키 | 값 예시 | 설명 |
|----|---------|------|
| SLACK_USER_TOKEN | xoxp-000-... | Slack User Token (search:read, users:read) |
| SPREADSHEET_ID | 1BxiMVs0X... | Google Sheet URL /d/{ID}/edit |
| SHEET_NAME | 멘션트래커 | 시트 이름 (기본값) |
| WATCH_USER_IDS | U01ABC,U02DEF,U03GHI | 개인 User ID (콤마 구분) |
| WATCH_SUBTEAM_IDS | S067BIZOPS | 사용자그룹 ID (콤마 구분) |
| WATCH_NAMES_JSON | {"U01ABC":"오유나",...} | ID→이름 매핑 JSON |
| LAST_PROCESSED_TS | 0 | 마지막 처리 ts (자동 갱신, 초기값 0) |

---

## 8. 프로토타입 범위 (Phase 1)

**포함:**
- Slack search.messages 5분 폴링
- 개인 + 사용자그룹 멘션 동시 추적
- Google Sheet 자동 적재 (10개 컬럼)
- 진행상황 드롭다운 5단계 + 조건부 서식
- 중복방지 이중 가드 (LAST_PROCESSED_TS + ts Set)
- 요청자 실명 조회 (users.info 캐시)
- 배포 전 검증용 테스트 함수 4개 (testFetchMentions/testWriteRow/testFullPipeline/resetLastProcessedTs)

**제외 (피드백 후 결정):**
- 스레드 자동 답장 ("접수되었습니다 + 시트링크")
- 완료 시 요청자 DM 알림
- Mixpanel/BigQuery 적재
- AI 요약 (Anthropic Haiku)
- 우선순위 자동 분류 (긴급 키워드 기반)
- card-squad 운영 어드민 페이지 임베드

---

## 9. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| 멘션 누락 | 미처리 건 발생 | after:YYYY-MM-DD (초 단위) + 시트 ts Set 이중 가드 |
| User ID 변경 | 요청자 이름 오표시 | WATCH_NAMES_JSON으로 ID→이름 명시 매핑, users.info 캐시 |
| Rate limit (search:read Tier 2) | 호출 차단 | 5분 폴링 → 충분히 여유 있음 (1회/5분) |
| Sheet 권한 | 운영자 접근 불가 | Apps Script 실행 계정으로 시트 공유 필수 |
| Users.info 실패 | 요청자 이름 미표시 | 실패 시 userId 그대로 표시, 파이프라인 계속 진행 |
