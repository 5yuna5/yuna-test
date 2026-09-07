# ops-request-intake

Slack 업무요청 Workflow 메시지를 **Linear BizOps(OPS) 이슈**로 자동 생성한다.

```
Slack Workflow 폼 → 인테이크 채널에 구조화 메시지
  → (이 스크립트) 파싱 → BQ 법인 조회 → Linear 이슈 생성 → 원본 스레드에 링크 회신
```

## 제목 규칙 (고정 4토큰)

```
[업무요청] {요청유형}_{신규|기존}_{제휴사}_{법인명}
```

예) `[업무요청] 제휴사 확인_기존_비씨카드_서윤웰스(주)`
빈 값은 `해당없음`으로 채워 **항상 4토큰을 유지**한다.

- `요청유형` — 폼 값을 축약형으로 정규화 (제휴사 확인 / 정책 확인 / 진행상황 확인 / 처리 요청 / 고객 안내 / 데이터 추출 / 장애 신고 / 예외 승인)
- `신규|기존` — **폼에서 묻지 않는다.** `ods_stream_gowid.CardIssuanceInfo` 발급 이력으로 자동 판정
  (발급 1건 이상 = 기존 / 0건 = 신규 / 조회 실패·동명이인 = 미확인)
- `제휴사` — 폼 선택값 그대로. 카드사명은 `dw_dimension.card_company` 표준명(**국민카드**, ≠KB국민카드)
- `법인명` — BQ `Corp.resCompanyNm` **정본으로 교정**. 요청자가 오타를 내도 제목은 정확하다

## Workflow 메시지 포맷 (반드시 이 형태여야 파싱된다)

```
📥 신규 운영 요청
요청자 :: {요청자}
요청유형 :: {Q1}
업무영역 :: {Q2}
제휴사 :: {Q3}
법인 :: {Q4}
고객영향 :: {Q7}
━ 요청내용 ━
{Q5}
━ 완료기준 ━
{Q6}
━ 참고 ━
{Q8}
```

- 단일행 필드는 ` :: `, 다중행 필드는 `━ 섹션명 ━`
- `신규 운영 요청` 문자열이 트리거. 이게 없으면 무시한다
- `법인`에 사업자번호(10자리) 또는 법인명 중 **아는 쪽 하나만** 넣는다. 내부 건은 `내부`

## 매핑

| 고객영향 | priority | 기한 | 최초 회신 목표 |
|---|---|---|---|
| 고객이 지금 못 쓰고 있음 | Urgent | 당일 | 30분 |
| 고객이 답변을 기다리는 중 | High | +1영업일 | 2시간 |
| 고객에겐 아직 안 알림 | Medium | +2영업일 | 당일 |
| 고객 건 아님 | Low | +5영업일 | 2영업일 |

| 요청유형 | `대기/` 초기 라벨 |
|---|---|
| 제휴사 확인 | 대기/카드사 |
| 장애 신고 | 대기/타팀 |
| 그 외 | 대기/내부 |

`대기/` 라벨은 **지금 공이 누구 코트에 있는가**를 뜻하며, `bizops-due-alert` 미결 알럿의 멘션 대상을 가른다.

## 실행

```bash
node index.js                 # 처리 + Linear 생성 + 스레드 회신
node index.js --dry-run       # 파싱·조회·제목생성까지만 (쓰기 없음)
node index.js --since 7d      # 조회 시작 시점 (기본 3d)
OPS_INTAKE_CHANNEL=C019ZSK6NNR node index.js   # 채널 override (테스트)
```

기본 인테이크 채널: `C068EG4N7QA` (business-unit-카드)

## 인증

| 대상 | 경로 |
|---|---|
| Linear | macOS keychain `linear-api-key` |
| Slack | `~/.claude.json` → `mcpServers.slack.env.SLACK_BOT_TOKEN` (env `SLACK_BOT_TOKEN`로 override) |
| BigQuery | `~/.claude/credentials/gowid-prd-bigquery-key.json` |

## 멱등성

봇 토큰에 `reactions:write` 스코프가 없어 이모지 마커를 쓸 수 없다.
→ 처리 완료된 메시지 ts를 `state/processed.json`에 적재한다 (60일 후 자동 정리).
**이 파일이 지워지면 재실행 시 중복 생성된다.**

## ⚠️ 주의

- **yuna-test cron이 매시간 `git reset --hard origin/main`을 실행한다.**
  이 디렉터리 변경은 반드시 origin에 push해야 살아남는다. `node_modules`·`state/`는 untracked라 생존.
- `dw_fact.card_issuance`는 stale하다. 발급 판정은 반드시 ODS `CardIssuanceInfo`를 쓴다.
- `Corp.resCompanyNumber`는 **전화번호**다. 사업자번호는 `resCompanyIdentityNo`.

## launchd 등록 (5분 간격)

```bash
# ~/Library/LaunchAgents/com.gowid.ops-request-intake.plist 생성 후
launchctl load ~/Library/LaunchAgents/com.gowid.ops-request-intake.plist
```
