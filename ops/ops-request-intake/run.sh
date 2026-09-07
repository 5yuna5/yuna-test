#!/usr/bin/env bash
# 운영팀 업무요청 인테이크 — launchd 실행 래퍼 (5분 간격 권장)
# launchd는 최소 환경이라 node 절대경로 사용. 작업 디렉토리 고정 후 실행.
cd /Users/gowid/yuna-test/ops/ops-request-intake || exit 1
exec /Users/gowid/local/node/bin/node index.js
