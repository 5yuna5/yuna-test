#!/usr/bin/env bash
# BizOps 마감/기한초과 알림 — launchd 매일 11:00 KST 실행 래퍼
# launchd는 최소 환경이라 node 절대경로 사용. 작업 디렉토리 고정 후 실행.
cd /Users/gowid/yuna-test/ops/bizops-due-alert || exit 1
exec /Users/gowid/local/node/bin/node index.js
