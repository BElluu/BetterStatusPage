import type { FastifyInstance } from 'fastify'
import type { AdminStaticMirror, StaticMirrorSettings } from '@bsp/shared'
import { requestIdentity } from '../kit/authMiddleware.js'
import { auditActor, diffObjects, writeAudit } from '../kit/audit.js'
import {
  checkStaticMirrorAccess, getAdminStaticMirror, getStaticMirrorSettings, runStaticMirror, saveStaticMirrorSettings, StaticMirrorError, storedMirrorSecret,
} from '../services/staticMirror.js'

export async function adminStaticMirrorRoutes(app: FastifyInstance) {
  app.get('/', async (): Promise<AdminStaticMirror> => getAdminStaticMirror())

  app.put<{ Body: Partial<StaticMirrorSettings> }>('/', async (req, reply) => {
    const before = await getStaticMirrorSettings()
    const secretBefore = await storedMirrorSecret()
    try {
      await saveStaticMirrorSettings(req.body ?? {})
    } catch (error) {
      if (error instanceof StaticMirrorError) return reply.code(400).send({ error: error.message })
      throw error
    }
    const result = await getAdminStaticMirror()
    // The secret is masked on both sides: the diff says that it was replaced, never what it is.
    const secretChanged = !!result.settings.secretAccessKey && secretBefore !== await storedMirrorSecret()
    const diff = diffObjects(
      { ...before, secretAccessKey: secretChanged && before.secretAccessKey ? '(previous)' : before.secretAccessKey },
      { ...result.settings, secretAccessKey: secretChanged ? '(replaced)' : result.settings.secretAccessKey },
    )
    if (Object.keys(diff).length) {
      await writeAudit(auditActor(requestIdentity(req)), 'update', 'static_mirror', 1, 'Static fallback', diff)
    }
    return result
  })

  // Tries the key of the form, saved or not, without pushing anything.
  app.post<{ Body: Partial<StaticMirrorSettings> }>('/check', async (req, reply) => {
    try {
      return await checkStaticMirrorAccess(req.body ?? {})
    } catch (error) {
      if (error instanceof StaticMirrorError) return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  // Pushes once now. A mirror that is switched off pushes nothing, by hand either.
  app.post('/test', async (_req, reply) => {
    if (!(await getStaticMirrorSettings()).enabled) {
      return reply.code(409).send({ error: 'Static fallback is off. Turn it on and save before pushing.' })
    }
    // By hand it is a full push: the copy on the storage may have lost files the memory of the last push still counts.
    await runStaticMirror({ full: true })
    return getAdminStaticMirror()
  })
}
