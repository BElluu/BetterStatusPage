import type { AuditAction } from '@better-kit/contracts'
import { audit } from '../kit/audit.js'
import type { Actor } from '@better-kit/audit'

export type { Actor }

// Forwards to the audit instance in ../kit/audit.ts; kept so call sites do not change.
export function diffObjects(before: Record<string, unknown>, after: Record<string, unknown>) {
  return audit.diffObjects(before, after)
}

export function snapshot(obj: Record<string, unknown>) {
  return audit.snapshot(obj)
}

export function auditActor(identity: { userId: number; email: string }): Actor {
  return audit.actor(identity)
}

export function writeAudit(
  actor: Actor,
  action: AuditAction,
  entityType: string,
  entityId: number | string | null,
  entityName: string,
  diff?: Record<string, unknown>,
): Promise<void> {
  return audit.write(actor, action, entityType, entityId, entityName, diff)
}
