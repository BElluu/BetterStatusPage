// Dependency boundaries of the shared "Better" modules (see the module graph in CLAUDE.md).
// `apps/*` may use `packages/*`; a package may only use the packages it lists here; nothing outside a package
// reaches into its `src/`. The scope is one constant, so a rename stays mechanical.
export const BETTER_SCOPE = '@better-forge'

/** package folder -> the @better packages it may import. */
export const PACKAGE_GRAPH = {
  contracts: [],
  db: ['contracts'],
  audit: ['db'],
  auth: ['db', 'audit'],
  vault: ['db'],
  mirror: [],
  notify: ['db', 'vault', 'audit'],
  backup: ['db', 'audit'],
  'config-as-code': ['db', 'contracts'],
  mcp: [],
  runtime: ['db'],
  ui: ['contracts'],
}

const APP_PACKAGES = ['@bsp/api', '@bsp/admin', '@bsp/status']

const noApps = {
  group: [...APP_PACKAGES.flatMap((app) => [app, `${app}/*`]), '**/apps/**'],
  message: 'Packages never import from apps/*.',
}
const noDeepImports = {
  group: [`${BETTER_SCOPE}/*/src`, `${BETTER_SCOPE}/*/src/**`],
  message: 'Import a package through its public entry points, not its src/.',
}
const rule = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

/** Flat-config blocks to spread into the ESLint config. */
export function boundaryConfigs() {
  const everyone = Object.keys(PACKAGE_GRAPH)
  const forPackage = ([name, allowed]) => {
    // contracts holds only browser-safe types and is the base layer every package may use.
    const forbidden = everyone.filter((other) => other !== name && other !== 'contracts' && !allowed.includes(other))
    const outsideGraph = forbidden.length
      ? [{
          group: forbidden.flatMap((other) => [`${BETTER_SCOPE}/${other}`, `${BETTER_SCOPE}/${other}/*`]),
          message: `${name} may only depend on: ${allowed.join(', ') || 'nothing'}.`,
        }]
      : []
    return { files: [`packages/${name}/**/*.{ts,tsx}`], rules: rule(noApps, noDeepImports, ...outsideGraph) }
  }
  return [
    ...Object.entries(PACKAGE_GRAPH).map(forPackage),
    { files: ['packages/shared/**/*.{ts,tsx}'], rules: rule(noApps) },
    { files: ['apps/**/*.{ts,tsx}'], rules: rule(noDeepImports) },
    // The template proves the shared modules stand on their own: it uses nothing of the products built on them.
    { files: ['apps/template/**/*.{ts,tsx}'], rules: rule(noDeepImports, { group: ['@bsp/*'], message: 'The template is built from the shared modules only.' }) },
  ]
}
