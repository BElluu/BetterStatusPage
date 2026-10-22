import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import type { LookupFunction } from 'node:net'
import { checkHttps } from '../src/workers/https.js'
import { testHttps } from '../src/workers/testRunner.js'
import { readCertificate } from '../src/workers/certificate.js'
import { guardedFetch, guardedLookup, metadataTargetsAllowed, refusalReason } from '../src/services/ssrfGuard.js'

const METADATA = '169.254.169.254'

describe('refusalReason', () => {
  it('refuses link-local and cloud metadata addresses and hosts', () => {
    for (const host of [METADATA, '169.254.0.1', '100.100.100.200', 'fd00:ec2::254', '[fd00:ec2::254]', 'fd20:ce::254', 'fe80::1', '::ffff:169.254.169.254', 'metadata.google.internal', 'Metadata.Google.Internal', 'metadata.google.internal.']) {
      assert.notEqual(refusalReason(host, {}), null, host)
    }
  })

  it('leaves private networks and loopback alone, they are what is monitored', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.0.5', 'fd12::1', 'localhost', 'example.com']) {
      assert.equal(refusalReason(host, {}), null, host)
    }
  })

  it('is lifted by MONITOR_ALLOW_METADATA', () => {
    assert.equal(metadataTargetsAllowed({ MONITOR_ALLOW_METADATA: 'true' }), true)
    assert.equal(refusalReason(METADATA, { MONITOR_ALLOW_METADATA: 'true' }), null)
  })
})

describe('guardedLookup', () => {
  const answering = (address: string, family = 4): LookupFunction => (_host, _options, callback) => callback(null, [{ address, family }])
  const resolve = (inner: LookupFunction, host = 'innocent.example') =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((done) => {
      guardedLookup(inner)(host, {}, (error, address) => done({ error, address }))
    })

  it('refuses a name that resolves to a metadata address, which is what DNS rebinding returns', async () => {
    const { error } = await resolve(answering(METADATA))
    assert.equal(error?.code, 'EBLOCKED')
    assert.match(error?.message ?? '', /Refusing to connect to innocent\.example/)
  })

  it('refuses when any of several answers is a metadata address', async () => {
    const mixed: LookupFunction = (_h, _o, callback) => callback(null, [{ address: '10.0.0.5', family: 4 }, { address: METADATA, family: 4 }])
    assert.equal((await resolve(mixed)).error?.code, 'EBLOCKED')
  })

  it('answers for a private address', async () => {
    const { error, address } = await resolve(answering('10.0.0.5'))
    assert.equal(error, null)
    assert.equal(address, '10.0.0.5')
  })

  it('lets a metadata address through with MONITOR_ALLOW_METADATA=true', async () => {
    process.env['MONITOR_ALLOW_METADATA'] = 'true'
    try {
      const { error, address } = await resolve(answering(METADATA), 'metadata.google.internal')
      assert.equal(error, null)
      assert.equal(address, METADATA)
    } finally {
      delete process.env['MONITOR_ALLOW_METADATA']
    }
  })
})

describe('monitors cannot read the metadata service', () => {
  let internalUrl = ''
  const server = createServer((req, res) => {
    if (req.url === '/to-metadata') res.writeHead(302, { Location: `http://${METADATA}/latest/meta-data/` }).end()
    else res.writeHead(200).end('ok')
  })
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    internalUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  after(() => { server.close() })

  const metadata = `http://${METADATA}/latest/meta-data/iam/security-credentials/role`
  const refused = /^Refusing to connect to /

  it('refuses the address in a scheduled check, with or without TLS verification', async () => {
    for (const ignoreTls of [false, true]) {
      for (const url of [metadata, `${internalUrl}/to-metadata`]) {
        const r = await checkHttps({ url, method: 'GET', expectedStatus: 200, ignoreTls }, 3_000)
        assert.equal(r.status, 'down')
        assert.match(r.error ?? '', refused, `${url} ignoreTls=${ignoreTls}`)
      }
    }
  })

  it('says why in the test run, for an address, a name and a redirect', async () => {
    for (const url of [metadata, 'http://metadata.google.internal/', `${internalUrl}/to-metadata`]) {
      const r = await testHttps({ url, method: 'GET', expectedStatus: 200 }, 3_000)
      assert.equal(r.overall, 'error', url)
      assert.match(r.steps.map((s) => s.detail ?? '').join('\n'), /Refusing to connect to/, url)
    }
  })

  it('refuses it when reading a certificate and in a one-off request', async () => {
    await assert.rejects(readCertificate(`https://${METADATA}/`, 2_000), /Refusing to connect/)
    await assert.rejects(guardedFetch(metadata), (error: Error) => (error.cause as { code?: string } | undefined)?.code === 'EBLOCKED')
  })

  it('still reaches a service on a private address', async () => {
    const r = await checkHttps({ url: `${internalUrl}/ok`, method: 'GET', expectedStatus: 200 }, 3_000)
    assert.equal(r.status, 'up')
  })
})
