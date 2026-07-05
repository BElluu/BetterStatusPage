import { defineConfig, devices } from '@playwright/test'

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
      url: 'http://127.0.0.1:3000/api/v1/setup/status',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_PATH: './.e2e/db.sqlite',
        SETUP_CONFIG_PATH: './.e2e/setup.json',
        UPLOAD_DIR: './.e2e/uploads',
        JWT_SECRET: 'e2e-jwt-secret-with-sufficient-entropy',
        VAULT_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
      },
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/admin --config apps/admin/vite.config.ts --port 5173',
      url: 'http://127.0.0.1:5173/admin/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js apps/status --config apps/status/vite.config.ts --port 5174',
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
