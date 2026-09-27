import { globSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Entry points and static translation tables carry no testable logic.
const COVERAGE_EXCLUDE = ['**/*.test.{ts,tsx}', '**/main.tsx', '**/i18n/defaults.ts', '**/i18n/statusDefaults.ts']

/**
 * Per-file floor for admin pages and the public status page. The global thresholds below are an
 * average, so a single untested page could hide behind well-tested ones. Vitest's glob thresholds
 * are also aggregates, and `perFile` would turn the global thresholds per-file for every source,
 * so instead each matching file gets its own threshold entry: a new page or status source with no
 * tests fails the gate on its own.
 */
const PER_FILE_GATED = ['apps/admin/src/pages/*.tsx', 'apps/status/src/**/*.{ts,tsx}']
const PER_FILE_FLOOR = { lines: 40, statements: 40, functions: 30, branches: 30 }
// Files that legitimately cannot meet the floor yet. Each entry needs a reason; keep this empty if possible.
const PER_FILE_EXEMPT: string[] = []

const perFileThresholds = Object.fromEntries(
  globSync(PER_FILE_GATED, { cwd: import.meta.dirname, exclude: [...COVERAGE_EXCLUDE, ...PER_FILE_EXEMPT] })
    .map((file) => file.replaceAll('\\', '/'))
    .sort()
    .map((file) => [file, PER_FILE_FLOOR]),
)

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Node 25+ defines its own `localStorage` global (Web Storage), which is undefined unless
    // --localstorage-file is given. Because jsdom's window is the global object in tests, that getter
    // shadows jsdom's working Storage. Turning Node's implementation off in the workers lets jsdom's through.
    execArgv: ['--no-webstorage'],
    include: ['apps/{admin,status}/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['apps/admin/src/**/*.{ts,tsx}', 'apps/status/src/**/*.{ts,tsx}'],
      exclude: COVERAGE_EXCLUDE,
      thresholds: {
        lines: 45,
        functions: 40,
        statements: 40,
        branches: 40,
        ...perFileThresholds,
      },
    },
  },
})
