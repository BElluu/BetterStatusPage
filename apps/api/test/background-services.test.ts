import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { startBackgroundServices, stopBackgroundServices } from '../src/services/backgroundServices.js'

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
