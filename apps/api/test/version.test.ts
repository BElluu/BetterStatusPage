import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PACKAGE_VERSION, resolveAppVersion } from '../src/version.js'

interface PackageMetadata {
  name?: string
  version?: string
}

interface LockfileMetadata extends PackageMetadata {
  packages?: Record<string, PackageMetadata>
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workspacePackages = [
  'package.json',
  'apps/admin/package.json',
  'apps/api/package.json',
  'apps/status/package.json',
  'packages/shared/package.json',
]

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T
}

describe('application version', () => {
  it('keeps every workspace and lockfile entry aligned with the root package version', () => {
    const rootPackage = readJson<PackageMetadata>('package.json')
    assert.equal(rootPackage.version, PACKAGE_VERSION)

    for (const relativePath of workspacePackages) {
      const metadata = readJson<PackageMetadata>(relativePath)
      assert.equal(
        metadata.version,
        rootPackage.version,
        `${relativePath} version must match the root package version`,
      )
    }

    const lockfile = readJson<LockfileMetadata>('package-lock.json')
    assert.equal(lockfile.version, rootPackage.version, 'package-lock.json version must match')
    for (const relativePath of workspacePackages) {
      const lockfileKey = relativePath === 'package.json'
        ? ''
        : relativePath.replace(/\/package\.json$/, '')
      assert.equal(
        lockfile.packages?.[lockfileKey]?.version,
        rootPackage.version,
        `package-lock.json entry for ${lockfileKey || 'root'} must match`,
      )
    }
  })

  it('uses the package version by default and allows Docker to override it', () => {
    assert.equal(resolveAppVersion({}), PACKAGE_VERSION)
    assert.equal(resolveAppVersion({ APP_VERSION: ' 9.8.7-container ' }), '9.8.7-container')
  })
})
