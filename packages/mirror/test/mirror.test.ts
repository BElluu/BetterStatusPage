import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { describe, it } from 'node:test'
import {
  createIntervalRunner, createMirrorPublisher, createS3Transport, sha256Hex, signRequest,
  type MirrorObject, type MirrorTransport,
} from '@better-kit/mirror'

describe('SigV4', () => {
  // The "PUT Object" example of the S3 documentation.
  it('signs like the published example', () => {
    const body = 'Welcome to Amazon S3.'
    const signed = signRequest({
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: sha256Hex(body),
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    assert.equal(
      signed['authorization'],
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, '
      + 'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    )
  })
})

async function withServer(status: number, reply: string, run: (url: string, seen: Array<{ req: IncomingMessage; body: string }>) => Promise<void>) {
  const seen: Array<{ req: IncomingMessage; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { seen.push({ req, body }); res.statusCode = status; res.end(reply) })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, seen)
  } finally {
    server.close()
  }
}

const object: MirrorObject = { key: 'snapshot.json', body: '{"a":1}', contentType: 'application/json', cacheControl: 'no-cache' }
const credentials = { bucket: 'b', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'SECRETVALUE' }

describe('S3 transport', () => {
  it('puts a signed object below the prefix, path style on a custom endpoint', async () => {
    await withServer(200, '', async (endpoint, seen) => {
      await createS3Transport({ ...credentials, endpoint, prefix: 'status/' }).put(object)
      const { req, body } = seen[0]!
      assert.equal(req.method, 'PUT')
      assert.equal(req.url, '/b/status/snapshot.json')
      assert.equal(body, '{"a":1}')
      assert.equal(req.headers['content-type'], 'application/json')
      assert.equal(req.headers['cache-control'], 'no-cache')
      assert.equal(req.headers['x-amz-content-sha256'], sha256Hex('{"a":1}'))
      assert.match(String(req.headers['authorization']), /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    })
  })

  it('deletes a signed object', async () => {
    await withServer(204, '', async (endpoint, seen) => {
      await createS3Transport({ ...credentials, endpoint }).delete('x.txt')
      const { req } = seen[0]!
      assert.equal(req.method, 'DELETE')
      assert.equal(req.url, '/b/x.txt')
      assert.match(String(req.headers['authorization']), /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    })
  })

  it('reports the status and error code, and nothing else of the reply', async () => {
    await withServer(403, '<Error><Code>SignatureDoesNotMatch</Code><Message>key AKID secret SECRETVALUE</Message></Error>', async (endpoint) => {
      await assert.rejects(
        createS3Transport({ ...credentials, endpoint }).put(object),
        (err: Error) => err.message === 'Upload of snapshot.json failed: HTTP 403 SignatureDoesNotMatch',
      )
    })
  })
})

describe('redirects', () => {
  it('are not followed, so the body never goes to another host', async () => {
    let elsewhereHit = false
    const elsewhere = createServer((_req, res) => { elsewhereHit = true; res.end() })
    await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
    const target = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/x`
    try {
      const redirecting = createServer((_req, res) => { res.statusCode = 307; res.setHeader('location', target); res.end() })
      await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${(redirecting.address() as { port: number }).port}`
      try {
        await assert.rejects(createS3Transport({ ...credentials, endpoint }).put(object), /HTTP 307/)
        assert.equal(elsewhereHit, false)
      } finally {
        redirecting.close()
      }
    } finally {
      elsewhere.close()
    }
  })
})

describe('publisher', () => {
  function recorder() {
    const puts: string[] = []
    const transport: MirrorTransport = { async put(o) { puts.push(o.key) }, async delete() {} }
    return { puts, transport }
  }
  const file = (key: string, body: string): MirrorObject => ({ key, body, contentType: 'text/plain' })

  it('uploads in the given order and skips what has not changed', async () => {
    const { puts, transport } = recorder()
    const publisher = createMirrorPublisher({ transport })
    assert.deepEqual(await publisher.publish([file('a.js', '1'), file('index.html', 'x')]), { uploaded: ['a.js', 'index.html'], unchanged: 0 })
    assert.deepEqual(await publisher.publish([file('a.js', '1'), file('index.html', 'y')]), { uploaded: ['index.html'], unchanged: 1 })
    assert.deepEqual(puts, ['a.js', 'index.html', 'index.html'])
    publisher.reset()
    assert.equal((await publisher.publish([file('a.js', '1')])).uploaded.length, 1)
  })

  it('stops at the first failure and retries what was not uploaded', async () => {
    const puts: string[] = []
    let fail = true
    const publisher = createMirrorPublisher({
      transport: { async put(o) { if (fail && o.key === 'b') throw new Error('boom'); puts.push(o.key) }, async delete() {} },
    })
    const files = [file('a', '1'), file('b', '2'), file('c', '3')]
    await assert.rejects(publisher.publish(files), /boom/)
    assert.deepEqual(puts, ['a'])
    fail = false
    assert.deepEqual((await publisher.publish(files)).uploaded, ['b', 'c'])
  })
})

describe('interval runner', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('can stop without waiting for the run in progress, and then schedules nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let runs = 0
    let finished = false
    const runner = createIntervalRunner({ intervalMs: () => 5, job: async () => { runs++; await gate; finished = true } })
    runner.start()
    await runner.stop({ wait: false })
    assert.equal(finished, false)
    release()
    await wait(40)
    assert.equal(finished, true)
    assert.equal(runs, 1)
  })

  it('never runs two at once, and keeps going after a failure', async () => {
    let active = 0
    let maxActive = 0
    let runs = 0
    const runner = createIntervalRunner({
      intervalMs: () => 5,
      job: async () => {
        active++; maxActive = Math.max(maxActive, active); runs++
        await wait(10)
        active--
        if (runs === 1) throw new Error('first run fails')
      },
    })
    runner.start()
    void runner.runNow()
    await wait(80)
    await runner.stop()
    assert.equal(maxActive, 1)
    assert.ok(runs >= 3, `ran ${runs} times`)
    const after = runs
    await wait(30)
    assert.equal(runs, after)
  })
})
