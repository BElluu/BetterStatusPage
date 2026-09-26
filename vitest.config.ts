import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['apps/{admin,status}/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['apps/admin/src/**/*.{ts,tsx}', 'apps/status/src/**/*.{ts,tsx}'],
      // Entry points and static translation tables carry no testable logic.
      exclude: ['**/*.test.{ts,tsx}', '**/main.tsx', '**/i18n/defaults.ts', '**/i18n/statusDefaults.ts'],
      thresholds: {
        lines: 45,
        functions: 40,
        statements: 40,
        branches: 40,
      },
    },
  },
})
