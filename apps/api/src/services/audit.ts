import { db } from '../db/client.js'
import { auditLog } from '../db/schema.js'

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|credential|vaultconfig|encryptedvalue|recoverycode)/i

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return redactObj(value as Record<string, unknown>)
  return value
}

/** Mask sensitive keys in a flat object. */
function redactObj(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v)
  }
  return out
}

/**
 * Compute a field-level diff between two flat objects.
 * Only changed keys are included. Sensitive keys are masked.
 */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff[key] = {
        from: SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(before[key]),
        to: SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(after[key]),
      }
    }
  }
  return diff
}

/** Snapshot of an entity for a create/delete entry. Sensitive keys masked. */
export function snapshot(obj: Record<string, unknown>): Record<string, unknown> {
  return redactObj(obj)
}

interface Actor {
  userId: number
  userEmail: string
}

/**
 * Write an audit log entry. Failures are swallowed so they never break the
 * primary operation.
 */
export async function writeAudit(
  actor: Actor,
  action: 'create' | 'update' | 'delete',
  entityType: string,
  entityId: number | string | null,
  entityName: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: actor.userId,
      userEmail: actor.userEmail,
      action,
      entityType,
      entityId: entityId !== null ? String(entityId) : null,
      entityName,
      diff: diff ? JSON.stringify(redactObj(diff)) : null,
      timestamp: Date.now(),
    })
  } catch (err) {
    console.error('[audit] write failed:', err)
  }
}
