import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { checkForUpdate, getAvailableUpdate, isNewerVersion, resetUpdateCheck, startUpdateCheck, updateCheckEnabled } from '../src/services/updateCheck.js'
import { resolveAppVersion } from '../src/version.js'

const RELEASE_URL = 'https://github.com/BElluu/BetterStatusPage/releases/tag/v99.0.0'

function releaseResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('isNewerVersion', () => {
  it('compares plain x.y.z versions numerically', () => {
    assert.equal(isNewerVersion('0.10.0', '0.9.9'), true)
    assert.equal(isNewerVersion('v1.0.0', '0.2.1'), true)
    assert.equal(isNewerVersion('0.2.1', '0.2.1'), false)
    assert.equal(isNewerVersion('0.2.0', '0.2.1'), false)
    assert.equal(isNewerVersion('1.0.0-rc.1', '0.2.1'), false)
    assert.equal(isNewerVersion('1.0.0', 'dev'), false)
  })
})

describe('update check', () => {
  beforeEach(() => {
    resetUpdateCheck()
    delete process.env['UPDATE_CHECK']
  })
  afterEach(() => {
    resetUpdateCheck()
    mock.restoreAll()
    delete process.env['UPDATE_CHECK']
  })

  it('reports a newer release once the check has run, and nothing before', async () => {
    mock.method(globalThis, 'fetch', async () => releaseResponse({ tag_name: 'v99.0.0', html_url: RELEASE_URL }))
    assert.equal(getAvailableUpdate(), null)
    assert.equal(await checkForUpdate(), true)
    assert.deepEqual(getAvailableUpdate(), { version: '99.0.0', url: RELEASE_URL })
  })

  it('reports nothing when up to date', async () => {
    mock.method(globalThis, 'fetch', async () => releaseResponse({ tag_name: `v${resolveAppVersion()}`, html_url: RELEASE_URL }))
    await checkForUpdate()
    assert.equal(getAvailableUpdate(), null)
  })

  it('ignores failures, prereleases and links outside the project repository', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
    assert.equal(await checkForUpdate(), false)
    assert.equal(getAvailableUpdate(), null)
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => releaseResponse({}, 404))
    assert.equal(await checkForUpdate(), false)
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => releaseResponse({ tag_name: 'v99.0.0', html_url: RELEASE_URL, prerelease: true }))
    assert.equal(await checkForUpdate(), true)
    assert.equal(getAvailableUpdate(), null)
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => releaseResponse({ tag_name: 'v99.0.0', html_url: 'https://evil.example/x' }))
    await checkForUpdate()
    assert.equal(getAvailableUpdate(), null)
  })

  it('starts in the background without waiting for GitHub', async () => {
    let answer: (response: Response) => void = () => {}
    const fetchMock = mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { answer = resolve }))
    startUpdateCheck()
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(getAvailableUpdate(), null)
    answer(releaseResponse({ tag_name: 'v99.0.0', html_url: RELEASE_URL }))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(getAvailableUpdate(), { version: '99.0.0', url: RELEASE_URL })
  })

  it('makes no request when UPDATE_CHECK=false', async () => {
    process.env['UPDATE_CHECK'] = 'false'
    const fetchMock = mock.method(globalThis, 'fetch', async () => releaseResponse({}))
    assert.equal(updateCheckEnabled(), false)
    startUpdateCheck()
    assert.equal(getAvailableUpdate(), null)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})
