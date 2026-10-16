import { defineConfig, devices } from '@playwright/test'

const apiPort = process.env['TEMPLATE_API_PORT'] ?? '3100'
const webPort = process.env['TEMPLATE_WEB_PORT'] ?? '5175'
const dataDir = process.env['TEMPLATE_DATA_DIR'] ?? './.e2e-template'

// Starts the template (its server and its web interface) on an empty data directory and uses it in a browser.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['html', { open: 'never' }], ['list']] : 'list',
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node -e "require('node:fs').rmSync('${dataDir}', { recursive: true, force: true })" && node --import tsx src/server/index.ts`,
      url: `http://127.0.0.1:${apiPort}/api/v1/setup/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development',
        DATA_DIR: dataDir,
        PORT: apiPort,
        JWT_SECRET: 'template-e2e-secret-with-sufficient-entropy',
        VAULT_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
      },
    },
    {
      command: `node ../../node_modules/vite/bin/vite.js --config web/vite.config.ts --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    },
  ],
})
