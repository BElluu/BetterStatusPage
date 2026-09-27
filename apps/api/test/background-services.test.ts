import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import http from 'node:http'
import Fastify from 'fastify'
import { startBackgroundServices, stopBackgroundServices } from '../src/services/backgroundServices.js'
import { createRuntimeShutdown } from '../src/services/shutdown.js'

describe('background service lifecycle', () => {
  it('starts and stops every service', () => {
    const services = {
      startMonitorScheduler: mock.fn(),
      startBackupScheduler: mock.fn(),
      startNotificationRetryWorker: mock.fn(),
      stopMonitorScheduler: mock.fn(),
      stopBackupScheduler: mock.fn(),
      stopNotificationRetryWorker: mock.fn(),
    }

    startBackgroundServices(services)
    stopBackgroundServices(services)

    for (const service of Object.values(services)) assert.equal(service.mock.callCount(), 1)
  })
})

describe('runtime shutdown', () => {
  function steps(closeServer: () => Promise<void>, forceExitMs?: number) {
    const order: string[] = []
    return {
      order,
      steps: {
        stopIntake: mock.fn(() => { order.push('stopIntake') }),
        closeServer: mock.fn(() => { order.push('closeServer'); return closeServer() }),
        releaseResources: mock.fn(() => { order.push('release') }),
        exit: mock.fn((code: number) => { order.push(`exit:${code}`) }),
        ...(forceExitMs !== undefined ? { forceExitMs } : {}),
      },
    }
  }

  it('keeps the DB and app lock until the server has drained', async () => {
    let drained!: () => void
    const { order, steps: s } = steps(() => new Promise<void>((resolve) => { drained = resolve }))
    const runtime = createRuntimeShutdown(s)
    runtime.shutdown()
    assert.deepEqual(order, ['stopIntake', 'closeServer'])
    // The onClose hook fires while draining; it must not release resources a second time later.
    drained()
    await new Promise((resolve) => setImmediate(resolve))
    runtime.cleanup()
    assert.deepEqual(order, ['stopIntake', 'closeServer', 'release', 'exit:0'])
  })

  it('exits non-zero when closing fails and still releases resources', async () => {
    const { order, steps: s } = steps(() => Promise.reject(new Error('close failed')))
    createRuntimeShutdown(s).shutdown()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, ['stopIntake', 'closeServer', 'release', 'exit:1'])
  })

  it('force-exits when draining hangs', async () => {
    const { order, steps: s } = steps(() => new Promise<void>(() => {}), 10)
    createRuntimeShutdown(s).shutdown()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(order, ['stopIntake', 'closeServer', 'release', 'exit:1'])
  })

  it('lets an in-flight request finish against an open DB', async () => {
    let dbOpen = true
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let requestArrived!: () => void
    const arrived = new Promise<void>((resolve) => { requestArrived = resolve })
    let exited!: (code: number) => void
    const exitCode = new Promise<number>((resolve) => { exited = resolve })

    const app = Fastify({ logger: false })
    app.get('/slow', async () => { requestArrived(); await gate; return { dbOpen } })
    const runtime = createRuntimeShutdown({
      stopIntake: () => {},
      closeServer: () => app.close(),
      releaseResources: () => { dbOpen = false },
      exit: exited,
    })
    app.addHook('onClose', async () => { runtime.cleanup() })
    const address = await app.listen({ port: 0, host: '127.0.0.1' })

    const response = new Promise<{ dbOpen: boolean }>((resolve, reject) => {
      // agent: false sends Connection: close, so the drained socket does not linger in keep-alive.
      http.get(`${address}/slow`, { agent: false }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString() })
        res.on('end', () => resolve(JSON.parse(body) as { dbOpen: boolean }))
      }).on('error', reject)
    })
    await arrived
    runtime.shutdown()
    assert.equal(dbOpen, true)
    openGate()
    assert.deepEqual(await response, { dbOpen: true })
    assert.equal(await exitCode, 0)
    assert.equal(dbOpen, false)
  })
})
