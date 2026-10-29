import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { z } from 'zod'
import { boundedJson, cleanDeep, cleanText, crossSiteProblem, defineTool, McpToolError, query, registerMcpEndpoint } from '@better-kit/mcp'

const char = (code: number) => String.fromCharCode(code)

describe('cleanText', () => {
  it('strips control, escape and invisible characters, keeping tabs and line breaks', () => {
    const dirty = `a${char(0)}b${char(27)}[1mc${char(0x200b)}d${char(0x202e)}e\tf\ng`
    assert.equal(cleanText(dirty), 'abcde\tf\ng')
  })

  it('cuts long text, and cleans every string of a nested result, keys included', () => {
    assert.equal(cleanText('x'.repeat(5000)).length, 2001)
    const cleaned = cleanDeep({ [`k${char(0x200b)}`]: [{ text: `a${char(0)}b` }], n: 1, ok: true, none: null })
    assert.deepEqual(cleaned, { k: [{ text: 'ab' }], n: 1, ok: true, none: null })
  })
})

describe('what people cannot see', () => {
  it('removes tag characters, variation selectors, bidi marks and fillers', () => {
    const tag = String.fromCodePoint(0xe0049, 0xe0067)
    const hidden = [0xfe0f, 0xe0100, 0x061c, 0x2028, 0x00ad, 0x3164].map((code) => String.fromCodePoint(code)).join('')
    assert.equal(cleanText(`ok${tag}${hidden}!`), 'ok!')
  })

  it('does not pass anything on unchecked below the depth limit', () => {
    let nested: unknown = { text: `a${char(0)}b` }
    for (let level = 0; level < 20; level++) nested = { inner: nested }
    assert.ok(JSON.stringify(cleanDeep(nested)).includes('[nested too deep]'))
    assert.ok(!JSON.stringify(cleanDeep(nested)).includes('"text"'))
  })
})

describe('boundedJson', () => {
  it('shortens a list under `items` that is too large, and says so', () => {
    const items = Array.from({ length: 4000 }, (_, index) => ({ index, text: 'y'.repeat(100) }))
    const shortened = JSON.parse(boundedJson({ total: 4000, items })) as { items: unknown[]; truncated: boolean; returnedItems: number }
    assert.equal(shortened.truncated, true)
    assert.equal(shortened.items.length, shortened.returnedItems)
    assert.ok(shortened.returnedItems > 0 && shortened.returnedItems < 4000)
  })

  it('refuses a result that cannot be shortened', () => {
    assert.throws(() => boundedJson({ blob: 'z'.repeat(100_000) }), McpToolError)
  })
})

describe('crossSiteProblem', () => {
  it('lets a client without Origin through', () => {
    assert.equal(crossSiteProblem({}, undefined), null)
    assert.equal(crossSiteProblem({ host: 'anything' }, undefined), null)
  })

  it('refuses any Origin but the public one, and any other Host once the public URL is known', () => {
    assert.ok(crossSiteProblem({ origin: 'https://evil.example' }, undefined))
    assert.equal(crossSiteProblem({ origin: 'https://s.example.com', host: 'S.example.com' }, 'https://s.example.com'), null)
    assert.ok(crossSiteProblem({ origin: 'https://evil.example', host: 's.example.com' }, 'https://s.example.com'))
    assert.ok(crossSiteProblem({ host: 'rebind.evil.example' }, 'https://s.example.com'))
    assert.ok(crossSiteProblem({}, 'https://s.example.com'))
  })

  it('ignores a public URL that cannot be parsed', () => {
    assert.equal(crossSiteProblem({}, 'not a url'), null)
  })
})

describe('the endpoint', () => {
  const echo = defineTool({
    name: 'echo', title: 'Echo', description: 'Echoes', scope: 'things:read', input: { word: z.string() },
    async handler(args, ctx) { return { word: args.word, canWrite: ctx.can('things:write'), seen: await ctx.get('/data') } },
  })
  const secret = defineTool({ name: 'secret', title: 'Secret', description: 'Needs more', scope: 'secrets:read', input: {}, async handler() { return {} } })

  async function build(scopes: string[]) {
    const app = Fastify({ logger: false })
    app.get('/data', async (req) => ({ authorization: req.headers.authorization }))
    registerMcpEndpoint(app, {
      path: '/mcp', name: 'test', version: '1.0.0', instructions: 'Static.', tools: [echo, secret],
      enabled: () => true, allowChanges: () => true, publicUrl: () => undefined,
      authenticate: async (req) => (req.headers.authorization === 'Bearer good' ? { authorization: 'Bearer good', scopes } : null),
    })
    await app.ready()
    return app
  }
  const post = (app: Awaited<ReturnType<typeof build>>, method: string, params?: unknown) => app.inject({
    method: 'POST', url: '/mcp', headers: { authorization: 'Bearer good', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  })

  it('lists the tools the caller may use and runs one with the caller\'s own credentials', async () => {
    const app = await build(['things:read'])
    const listed = (await post(app, 'tools/list')).json() as { result: { tools: Array<{ name: string }> } }
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['echo'])

    const called = (await post(app, 'tools/call', { name: 'echo', arguments: { word: 'hi' } })).json() as { result: { content: Array<{ text: string }> } }
    assert.deepEqual(JSON.parse(called.result.content[0]!.text), { word: 'hi', canWrite: false, seen: { authorization: 'Bearer good' } })
    await app.close()
  })

  it('answers 401 without a caller', async () => {
    const app = await build(['things:read'])
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: {} })
    assert.equal(response.statusCode, 401)
    assert.equal(response.headers['www-authenticate'], 'Bearer realm="mcp"')
    await app.close()
  })
})

describe('what a tool may send', () => {
  const sender = defineTool({
    name: 'send', title: 'Send', description: 'Sends what it is told to', scope: 'things:write', access: 'write',
    input: { method: z.string(), path: z.string() },
    async handler(args, ctx) { return ctx.send(args.method as never, args.path, { a: 1 }) },
  })

  async function ask(method: string, path: string) {
    const app = Fastify({ logger: false })
    app.post('/data', async () => ({ ok: true }))
    app.put('/data', async () => ({ ok: true }))
    app.delete('/data', async () => ({ ok: true }))
    registerMcpEndpoint(app, {
      path: '/mcp', name: 'test', version: '1.0.0', instructions: 'Static.', tools: [sender], enabled: () => true, allowChanges: () => true, publicUrl: () => undefined,
      authenticate: async () => ({ authorization: 'Bearer good', scopes: ['things:write'] }),
    })
    await app.ready()
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send', arguments: { method, path } } },
    })
    await app.close()
    return (response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
  }

  it('lets a read have a query, even one that contains two dots', async () => {
    const app = Fastify({ logger: false })
    app.get('/data', async (req) => ({ tag: (req.query as { tag?: string }).tag }))
    const lookup = defineTool({ name: 'look', title: 'Look', description: 'Reads with a query', scope: 'things:read', input: { tag: z.string() }, async handler(args, ctx) { return ctx.get('/data' + query({ tag: args.tag })) } })
    registerMcpEndpoint(app, {
      path: '/mcp', name: 'test', version: '1.0.0', instructions: 'Static.', tools: [lookup], enabled: () => true, allowChanges: () => true, publicUrl: () => undefined,
      authenticate: async () => ({ authorization: 'Bearer good', scopes: ['things:read'] }),
    })
    await app.ready()
    const response = await app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'look', arguments: { tag: 'v1..2' } } },
    })
    const result = (response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0]!.text), { tag: 'v1..2' })
    await app.close()
  })

  it('sends POST, PATCH and PUT to a path of the host', async () => {
    for (const method of ['POST', 'PUT']) assert.equal((await ask(method, '/data')).isError, undefined, method)
  })

  it('refuses DELETE and other methods, and paths that could leave or change meaning', async () => {
    const refusedCalls: Array<[string, string]> = [['POST', '/data/%2e%2e/admin'], ['POST', '/data\\admin'], ['POST', '/data?prune=true'], ['PUT', '/data?x=1'], ['DELETE', '/data'], ['GET', '/data'], ['TRACE', '/data'], ['POST', 'http://evil.example/data'], ['POST', '//evil.example/data'], ['POST', '/data/../admin'], ['POST', '/data#frag'], ['POST', '/da ta']]
    for (const [method, path] of refusedCalls) {
      const result = await ask(method, path)
      assert.equal(result.isError, true, `${method} ${path}`)
      assert.match(result.content[0]!.text, /not allowed/, `${method} ${path}`)
    }
  })
})

describe('the gate', () => {
  const reader = defineTool({ name: 'look', title: 'Look', description: 'Reads something', scope: 'things:read', input: {}, async handler() { return { seen: true } } })
  const writer = defineTool({ name: 'touch', title: 'Touch', description: 'Changes something', scope: 'things:write', access: 'write', input: {}, async handler() { return {} } })

  async function build(on: { enabled: boolean | Error; allowChanges: boolean }) {
    const app = Fastify({ logger: false })
    let authenticated = 0
    registerMcpEndpoint(app, {
      path: '/mcp', name: 'test', version: '1.0.0', instructions: 'Static.', tools: [reader, writer],
      enabled: () => { if (on.enabled instanceof Error) throw on.enabled; return on.enabled },
      allowChanges: () => on.allowChanges, publicUrl: () => undefined,
      authenticate: async () => { authenticated++; return { authorization: 'Bearer good', scopes: ['things:write'] } },
    })
    await app.ready()
    return { app, authenticated: () => authenticated }
  }
  const list = (app: Awaited<ReturnType<typeof build>>['app']) => app.inject({
    method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })

  it('answers 404 before anything else when off, and also when it cannot tell', async () => {
    for (const enabled of [false, new Error('database not ready')]) {
      const { app, authenticated } = await build({ enabled, allowChanges: true })
      assert.equal((await list(app)).statusCode, 404)
      assert.equal((await app.inject({ method: 'GET', url: '/mcp' })).statusCode, 404)
      assert.equal(authenticated(), 0, 'the caller was never looked at')
      await app.close()
    }
  })

  it('offers the tools that change data only while changes are allowed', async () => {
    for (const [allowChanges, expected] of [[false, ['look']], [true, ['look', 'touch']]] as const) {
      const { app } = await build({ enabled: true, allowChanges })
      const tools = ((await list(app)).json() as { result: { tools: Array<{ name: string }> } }).result.tools
      assert.deepEqual(tools.map((tool) => tool.name), expected)
      await app.close()
    }
  })
})

describe('query', () => {
  it('leaves out what was not given', () => {
    assert.equal(query({ a: 1, b: undefined, c: 'x y', d: false }), '?a=1&c=x+y&d=false')
    assert.equal(query({ a: undefined }), '')
  })
})
