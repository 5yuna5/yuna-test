module.exports = {
  apps: [
    {
      name: 'dashboard-server',
      script: 'serve_dashboards.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
    },
    {
      name: 'update-limit-dashboard',
      script: 'update_limit_data.js',
      cwd: __dirname,
      cron_restart: '0 7-23 * * *',  // 매일 7시~23시, 매 정각
      watch: false,
      autorestart: false,
      max_restarts: 0,
    },
    {
      name: 'update-issuance-dashboard',
      script: 'update_data.js',
      cwd: __dirname,
      cron_restart: '0 7-23 * * *',  // 매일 7시~23시, 매 정각
      watch: false,
      autorestart: false,
      max_restarts: 0,
    },
  ],
};
