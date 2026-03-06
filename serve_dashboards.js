#!/usr/bin/env node
const express = require('express');
const path = require('path');

const app = express();
const PORT = 3100;
const DIR = __dirname;

// 정적 파일 서빙
app.use(express.static(DIR, { extensions: ['html'] }));

// 루트 → 대시보드 목록
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GoWid Dashboards</title>
<style>body{font-family:system-ui;max-width:600px;margin:60px auto;color:#1e293b}
h1{font-size:20px;margin-bottom:24px}a{display:block;padding:12px 16px;margin:8px 0;
background:#f1f5f9;border-radius:8px;color:#3b82f6;text-decoration:none;font-weight:600}
a:hover{background:#e0e7ff}.sub{font-size:12px;color:#64748b;font-weight:400}</style></head>
<body><h1>GoWid Dashboards</h1>
<a href="/card_issuance_dashboard.html">신규 입회 고객 행태 분석<br><span class="sub">card_issuance_dashboard.html</span></a>
<a href="/limit_increase_dashboard.html">한도상향 / 카드사추가 퍼널<br><span class="sub">limit_increase_dashboard.html</span></a>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard server running at http://0.0.0.0:${PORT}`);
  console.log(`  - http://localhost:${PORT}`);
  console.log(`  - http://192.168.12.193:${PORT} (LAN)`);
});
