# 한도 정합성 알럿 (limit-integrity-alert)

한도가 단계 사이에서 끊긴 법인을 매일 찾아 시트 + 슬랙으로 알린다.
배경: 발급 땐 정상 한도였는데 실제 부여한도가 0원이 되어 고객이 카드를 못 쓴 사고 (기러기둥지, 2026-08-20).

- ① 보증금: 계약서 값(승인 보증금, 모두싸인 금액 대체) = 입금액 = 현재 한도
- ② 발급: 발급 승인한도 = 현재 한도 (내부 CardLimit / 카드사 DW 총한도)

| 항목 | 값 |
|---|---|
| 시트 | https://docs.google.com/spreadsheets/d/1jqRXfZl8X8JKBNMaZOWpKAJ_9eQntRDYE_tc4l2MFSU (탭: 가이드/보증금/발급/해소) |
| 슬랙 | C068EG4N7QA, 온보딩 퍼널 알림 봇 부모 메시지 스레드 답글 ("한도 정합성 알림") |
| 스케줄 | `.github/workflows/limit-integrity-alert.yml` (KST 09시대, piggyback + 분산 cron) |

```bash
node index.js --dry-run    # 판정 결과 + 슬랙 미리보기만
node index.js --no-slack   # 시트만 갱신
node index.js --force      # 오늘 이미 보냈어도 슬랙 재발송
```

판정 규칙·데이터 함정은 `index.js` 상단 주석과 시트 '가이드' 탭 참고.
