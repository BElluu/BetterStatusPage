// The shared "Better" modules (@better-forge/*) live in their own repository and come from npm. What is guarded here:
// nothing reaches into a module's src/ or dist/, and packages/shared does not import from the apps.
export const BETTER_SCOPE = '@better-forge'

const APP_PACKAGES = ['@bsp/api', '@bsp/admin', '@bsp/status']

const noApps = {
  group: [...APP_PACKAGES.flatMap((app) => [app, `${app}/*`]), '**/apps/**'],
  message: 'Packages never import from apps/*.',
}
const noDeepImports = {
  group: [`${BETTER_SCOPE}/*/src`, `${BETTER_SCOPE}/*/src/**`, `${BETTER_SCOPE}/*/dist`, `${BETTER_SCOPE}/*/dist/**`],
  message: 'Import a package through its public entry points, not its src/ or dist/.',
}
const rule = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

/** Flat-config blocks to spread into the ESLint config. */
export function boundaryConfigs() {
  return [
    { files: ['packages/shared/**/*.{ts,tsx}'], rules: rule(noApps, noDeepImports) },
    { files: ['apps/**/*.{ts,tsx}'], rules: rule(noDeepImports) },
  ]
}
