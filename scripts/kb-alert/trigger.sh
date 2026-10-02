#!/bin/bash
# 검수 큐에 미발송 건이 있으면 GHA kb-alert를 즉시 실행 (launchd 5분 주기)
# 슬랙 봇 토큰은 GHA 시크릿에만 있으므로 발송은 GHA가 한다
K='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9raWlwY3h4YXl3dmNtZWVjcXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDM5NjEsImV4cCI6MjA5MDUxOTk2MX0.xldBRKo6laOy89zGaWT_Z3azPc30-c4iUFVixt3ZvcY'
N=$(curl -s "https://okiipcxxaywvcmeecqvx.supabase.co/rest/v1/kb_review_queue?select=id&alerted_at=is.null&limit=1" -H "apikey: $K" -H "Authorization: Bearer $K" | grep -c '"id"')
[ "$N" = "0" ] && exit 0
RUNNING=$(gh run list -R 5yuna5/yuna-test --workflow=kb-alert.yml --json status -q '[.[]|select(.status!="completed")]|length' 2>/dev/null)
[ "${RUNNING:-0}" != "0" ] && { echo "$(date '+%F %T') 실행 중 — 건너뜀"; exit 0; }
gh workflow run kb-alert.yml -R 5yuna5/yuna-test && echo "$(date '+%F %T') 미발송 건 있음 — kb-alert 실행"
