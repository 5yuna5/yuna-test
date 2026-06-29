# bizops-due-alert

매일 11:00 KST에 Linear **BizOps** 팀에서 **오늘(KST) 마감(dueDate)** 이고 **미완료**
(state.type ∉ {completed, canceled})인 이슈를 모아 Slack 채널 `C068EG4N7QA`
(#온보딩 퍼널별 고객 터치 알림)에 **담당자별 그룹**으로 발송한다.

당일 마감 미완료 건을 매일 아침 자동 가시화해 누락을 방지하는 것이 목적이다.

## 실행

```bash
cd ~/yuna-test/ops/bizops-due-alert
npm install           # 최초 1회 (node_modules 생성)

node index.js             # 발송 (멱등 가드 적용)
node index.js --dry-run   # Slack 미발송, 콘솔 미리보기만
node index.js --force     # 멱등 가드 무시하고 강제 재발송
```

## 스케줄

- launchd `com.gowid.bizops-due-alert` 가 매일 **11:00 KST** (맥 로컬 타임존 = Asia/Seoul) 실행.
- 실제 호출: `run.sh` → `node index.js`.
- 로그: `~/yuna-test/ops/bizops-due-alert/bizops-due-alert.log`

등록/확인:

```bash
launchctl unload ~/Library/LaunchAgents/com.gowid.bizops-due-alert.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.gowid.bizops-due-alert.plist
launchctl list | grep bizops-due-alert
```

## 멱등 가드

- 발송 전 채널 최근 30개 메시지에서 **봇 자신(username `BizOps 마감 알림`)이 오늘(KST) 보낸 메시지**가
  있으면 skip 한다.
- launchd가 (잠자기 깨어남 등으로) 같은 날 중복 트리거해도 안전.
- `--force` 로 가드를 무시하고 강제 재발송할 수 있다(수동 확인용).

## 메시지 포맷

- **0건**: `✅ 오늘(MM/DD) 마감 미완료 건 없음` 한 줄.
- **1건 이상**: 헤더 `📌 오늘 마감 미완료 — MM/DD` + 담당자별 그룹 섹션.
  각 줄: `<링크|식별자> 제목  [라벨요약]  · Project  {담당자}`. 미배정은 "미배정" 그룹(마지막).
- **담당자 표시**: Linear `name`(실제 이름, 예 "신현덕") 우선 → `displayName`(handle) → "미배정".
  그룹 헤더도 실제 이름 사용.

## 담당자 멘션 — 자동 승격 설계 (핵심)

각 고유 assignee.email에 대해 Slack `users.lookupByEmail`을 호출한다(런당 1회, 중복 이메일 캐시):

- **성공(ok=true)**: 실제 멘션 `<@USERID>` 렌더 → 해당 담당자에게 Slack 알림이 간다.
- **실패(missing_scope / users_not_found / 이메일 없음 등)**: 폴백으로 볼드 이름 `*신현덕*` 텍스트 렌더.
  **에러로 죽지 않는다** (lookup 실패는 조용히 폴백).

> **현재 상태(v1)**: 봇(crm-history-bot)에 `users:read.email` 스코프가 없어 lookup이 `missing_scope`로
> 실패 → **담당자 이름 텍스트**로 표기된다.
>
> **자동 승격**: 나중에 봇에 **`users:read.email` 스코프만 추가**하면, 코드 변경 없이
> 위 lookup이 성공하여 **실제 @멘션으로 자동 전환**된다(담당자 Slack 알림 발생). 메시지 하단
> context 줄도 멘션 모드에 따라 문구가 자동으로 바뀐다.

## not_in_channel 처리

- 봇이 채널에 초대되지 않은 경우(`not_in_channel`), 콘솔에
  `봇이 채널 C068EG4N7QA에 없습니다. /invite @봇 실행 후 재시도하세요.` 안내 후 **graceful exit(0)** 한다.
- 슬랙에서 해당 채널에 봇을 `/invite` 한 뒤 재실행하면 정상 발송된다.

## 인증 / 시크릿

- **SLACK_BOT_TOKEN**: `~/yuna-test/pm/context/card/operations/crm-slack-bot/.env` 재사용(xoxb-).
- **Linear API 키**: macOS keychain 서비스명 `linear-api-key`
  (`security find-generic-password -s "linear-api-key" -w`). Bearer 아님, 키 문자열 그대로 Authorization 헤더.
- 외부 HTTP 의존성 없음(Linear/Slack 호출 모두 `https` 내장 모듈 또는 @slack/web-api).

## 상수

- 채널: `C068EG4N7QA`
- BizOps 팀 id: `ba7b57b7-3f9e-4f81-b7f4-7e24ed38c074`
