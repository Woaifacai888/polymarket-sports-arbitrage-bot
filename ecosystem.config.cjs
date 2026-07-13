const path = require('path');

const botScript = path.join(__dirname, 'dist/src/index.js');

/** @type {import('pm2').StartOptions[]} */
const apps = [
  {
    name: 'polymarket-bot-sim',
    script: botScript,
    args: '--mode sim',
    interpreter: 'node',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 15,
    min_uptime: '10s',
    restart_delay: 5000,
    watch: false,
    env: {
      MODE: 'sim',
      NODE_ENV: 'production',
    },
    error_file: path.join(__dirname, 'logs/pm2-sim-error.log'),
    out_file: path.join(__dirname, 'logs/pm2-sim-out.log'),
    merge_logs: true,
    time: true,
  },
  {
    name: 'polymarket-bot-live',
    script: botScript,
    args: '--mode live --confirm-live',
    interpreter: 'node',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 15,
    min_uptime: '10s',
    restart_delay: 5000,
    watch: false,
    env: {
      MODE: 'live',
      CONFIRM_LIVE: 'true',
      NODE_ENV: 'production',
    },
    error_file: path.join(__dirname, 'logs/pm2-live-error.log'),
    out_file: path.join(__dirname, 'logs/pm2-live-out.log'),
    merge_logs: true,
    time: true,
  },
];

module.exports = { apps };
