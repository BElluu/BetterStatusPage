import { defineConfig, devices } from '@playwright/test'

const apiPort = process.env['E2E_API_PORT'] ?? '3000'
const apiUrl = `http://127.0.0.1:${apiPort}`
const dataDir = process.env['E2E_DATA_DIR'] ?? './.e2e'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx apps/api/src/index.ts',
      url: `${apiUrl}/api/v1/setup/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development',
        DATA_DIR: dataDir,
        PORT: apiPort,
        DATABASE_PATH: `${dataDir}/db.sqlite`,
        SETUP_CONFIG_PATH: `${dataDir}/setup.json`,
        UPLOAD_DIR: `${dataDir}/uploads`,
        JWT_SECRET: 'e2e-jwt-secret-with-sufficient-entropy',
        VAULT_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
      },
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/admin --config apps/admin/vite.config.ts --port 5173',
      url: 'http://127.0.0.1:5173/admin/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_PROXY_TARGET: apiUrl },
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/status --config apps/status/vite.config.ts --port 5174',
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_PROXY_TARGET: apiUrl },
    },
  ],
})
