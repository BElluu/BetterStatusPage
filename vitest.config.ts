import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['apps/{admin,status}/src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['apps/admin/src/components/**/*.tsx', 'apps/status/src/components/**/*.tsx'],
      exclude: ['**/*.test.tsx'],
      thresholds: {
        lines: 20,
        functions: 15,
        statements: 20,
        branches: 20,
      },
    },
  },
})
