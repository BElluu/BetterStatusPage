import { buildWebhookRequest } from './notifier.js'
import { resolveVaultSecret } from '../kit/resolveSecret.js'
import { placeholderInAuthority } from '@better-kit/notify'
import { secretPlaceholders } from '../services/actionInput.js'
import { db } from '../db/client.js'
import { vaultSecrets } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import type { ActionHttpConfig } from '@bsp/shared'

const REQUEST_TIMEOUT_MS = 15_000
/** What is read of an answer, and how much of it is kept for the history and the test panel. */
const MAX_READ_BYTES = 4096
const SNIPPET_CHARS = 500
const ERROR_SNIPPET_CHARS = 300
/** Shorter secrets are not redacted: they would blank out ordinary words. */
const MIN_REDACTED_LENGTH = 4
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g

export interface ActionHttpResult {
  ok: boolean
  status?: number
  /** The start of the answer on one line, with secrets removed. */
  snippet: string
  /** Why it failed, with secrets removed; unset on success. */
  error?: string
}

/**
 * The variables the vault secrets of an action provide to the request (`{{secret_<name>}}` and friends), kept apart from
 * the variables of the run: they live in memory for one request and are never stored.
 */
export async function loadActionSecrets(config: ActionHttpConfig): Promise<Record<string, string>> {
  const variables: Record<string, string> = {}
  for (const { name, vault } of config.secrets ?? []) {
    const resolved = await resolveVaultSecret({ vaultId: vault.vaultId, secretId: vault.secretId })
    // What the placeholders mean follows the type of the secret, the same rule the form and the API check when it is saved.
    const [row] = await db.select({ type: vaultSecrets.type }).from(vaultSecrets)
      .where(and(eq(vaultSecrets.id, vault.secretId), eq(vaultSecrets.vaultId, vault.vaultId)))
    if (row?.type === 'value') {
      variables[`secret_${name}`] = resolved['value'] ?? ''
    } else if (row?.type === 'userpass') {
      variables[`secret_${name}_username`] = resolved['username'] ?? ''
      variables[`secret_${name}_password`] = resolved['password'] ?? ''
      variables[`secret_${name}_basic`] = Buffer.from(`${resolved['username'] ?? ''}:${resolved['password'] ?? ''}`).toString('base64')
    } else {
      for (const [key, value] of Object.entries(resolved)) if (/^\w+$/.test(key)) variables[`secret_${name}_${key}`] = value
    }
  }
  return variables
}

/** Every form a secret can take inside a request: as it is, in a URL, in a JSON string. */
function secretForms(secrets: Record<string, string>): string[] {
  const forms = new Set<string>()
  const addForms = (value: string) => {
    const json = JSON.stringify(value).slice(1, -1)
    forms.add(value)
    forms.add(encodeURIComponent(value))
    forms.add(json)
    // A target that echoes the body inside its own JSON answer escapes it a second time.
    forms.add(JSON.stringify(json).slice(1, -1))
  }
  for (const value of Object.values(secrets)) {
    if (value.length < MIN_REDACTED_LENGTH) continue
    addForms(value)
    // A secret with line breaks or repeated spaces also turns up in pieces, once the answer is printed on one line.
    for (const piece of value.split(/\s+/)) if (piece.length >= MIN_REDACTED_LENGTH && piece !== value) addForms(piece)
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

export function redact(text: string, secrets: Record<string, string>): string {
  let result = text
  for (const form of secretForms(secrets)) result = result.split(form).join('[secret]')
  return result
}

/** The start of an answer on one line. Secrets are removed before this: collapsing whitespace or cutting would hide them from `redact`. */
function oneLine(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < MAX_READ_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } catch { /* an answer that breaks off still gives what was read */ } finally {
    reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_READ_BYTES))
}

/** Fixed texts only: the message of a failed fetch can hold the whole URL, and the URL can hold a secret. */
function networkError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined
  return `Request failed: ${typeof cause?.code === 'string' ? cause.code : 'network error'}`
}

/**
 * Sends an action's request once. Redirects are not followed, so headers and body never go to another host than the
 * one that was configured; a 3xx is a failure that says so.
 */
export async function executeAction(config: ActionHttpConfig, variables: Record<string, string>): Promise<ActionHttpResult> {
  let secrets: Record<string, string> = {}
  try {
    secrets = await loadActionSecrets(config)
  } catch (error) {
    return { ok: false, snippet: '', error: `Vault secret could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }

  // Checked on the template: a monitor whose name happens to read {{secret}} is only text once it is filled in.
  const missing = secretPlaceholders(config as unknown as Record<string, unknown>).find((name) => !(name in secrets))
  if (missing) return { ok: false, snippet: '', error: `{{${missing}}} is not provided by the vault secret` }
  // The request goes wherever the URL points, and variables (a monitor name, or the message of a heartbeat) must not steer that.
  if (placeholderInAuthority(config.url)) {
    return { ok: false, snippet: '', error: 'A placeholder in the host of the URL is not allowed' }
  }
  // In the URL every value is one piece of a path or query, so it cannot add a segment, a dot segment or a host.
  const { url, init } = buildWebhookRequest(config, { ...variables, ...secrets })

  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const snippet = oneLine(redact(await readBody(response), secrets))
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, snippet, error: `HTTP ${response.status} (redirect not followed)` }
    }
    if (!response.ok) {
      return { ok: false, status: response.status, snippet, error: `HTTP ${response.status}${snippet ? `: ${snippet.slice(0, ERROR_SNIPPET_CHARS)}` : ''}` }
    }
    return { ok: true, status: response.status, snippet }
  } catch (error) {
    return { ok: false, snippet: '', error: networkError(error) }
  }
}
