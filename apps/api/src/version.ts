import fs from 'node:fs'

function readPackageVersion(): string {
  const metadata: unknown = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (
    typeof metadata !== 'object'
    || metadata === null
    || !('version' in metadata)
    || typeof metadata.version !== 'string'
    || metadata.version.length === 0
  ) {
    throw new Error('apps/api/package.json does not contain a valid version')
  }
  return metadata.version
}

export const PACKAGE_VERSION = readPackageVersion()

export function resolveAppVersion(
  environment: { APP_VERSION?: string | undefined } = process.env,
): string {
  return environment.APP_VERSION?.trim() || PACKAGE_VERSION
}
