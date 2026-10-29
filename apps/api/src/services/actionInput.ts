import { inArray } from 'drizzle-orm'
import { placeholderInAuthority } from '@better-forge/notify'
import { db } from '../db/client.js'
import { vaultSecrets } from '../db/schema.js'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH']

/** A secret is given a name, and its placeholders are `{{secret_<name>}}`: letters and digits, so the name ends at the next underscore. */
export const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,23}$/
export const MAX_ACTION_SECRETS = 10

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** The `{{secret_…}}` placeholders a configuration uses in its URL, header values and body. */
export function secretPlaceholders(config: Json): string[] {
  const headers = isObject(config['headers']) ? Object.values(config['headers']) : []
  const text = [config['url'], config['body'], ...headers].filter((part) => typeof part === 'string').join('\n')
  return [...new Set([...text.matchAll(/\{\{(secret_\w+)\}\}/g)].map((match) => match[1]!))]
}

/** `secret_jenkins_basic` is the secret named `jenkins` and the part `basic`; `secret_jenkins` has no part. */
function placeholderParts(placeholder: string): { name: string; part: string } {
  const [name = '', ...rest] = placeholder.slice('secret_'.length).split('_')
  return { name, part: rest.join('_') }
}

/** Whether a placeholder sits in the user or password of a URL, which the request cannot carry (credentials go in a header). */
export function placeholderInCredentials(url: string): boolean {
  if (!url.includes('{{')) return false
  const credentialsFor = (value: string): string | null => {
    try {
      const parsed = new URL(url.replace(/\{\{\w+\}\}/g, value))
      return `${parsed.username}:${parsed.password}`
    } catch { return null }
  }
  const first = credentialsFor('aaaa')
  return first !== null && first !== credentialsFor('bbbb')
}

interface SecretRef { name: string; vaultId: number; secretId: number }

/** The secrets of a configuration, or what is wrong with them. */
function readSecrets(value: unknown): { refs: SecretRef[] } | { error: string } {
  if (value === undefined) return { refs: [] }
  if (!Array.isArray(value)) return { error: 'secrets must be a list of { name, vault }' }
  if (value.length > MAX_ACTION_SECRETS) return { error: `an action can read at most ${MAX_ACTION_SECRETS} secrets` }
  const refs: SecretRef[] = []
  for (const item of value) {
    const vault = isObject(item) ? item['vault'] : undefined
    if (!isObject(item) || typeof item['name'] !== 'string' || !SECRET_NAME_PATTERN.test(item['name'])) {
      return { error: 'each secret needs a name of letters and digits (up to 24, starting with a letter)' }
    }
    if (!isObject(vault) || !Number.isSafeInteger(vault['vaultId']) || !Number.isSafeInteger(vault['secretId'])) {
      return { error: `secret "${item['name']}" must name a vault secret` }
    }
    if (vault['fieldMapping'] !== undefined) return { error: 'vault field mapping is not supported for actions' }
    if (refs.some((ref) => ref.name === item['name'])) return { error: `the secret name "${item['name']}" is used twice` }
    refs.push({ name: item['name'], vaultId: vault['vaultId'] as number, secretId: vault['secretId'] as number })
  }
  return { refs }
}

/** The first problem with an HTTP action configuration, or null. `{{variables}}` are filled in only when it runs. */
export function actionConfigError(config: Json): string | null {
  if (typeof config['url'] !== 'string' || !/^https?:\/\//i.test(config['url'])) return 'url must start with http:// or https://'
  if (typeof config['method'] !== 'string' || !METHODS.includes(config['method'])) return `method must be one of: ${METHODS.join(', ')}`
  if (config['body'] !== undefined && typeof config['body'] !== 'string') return 'body must be text'
  if (config['body'] && config['method'] === 'GET') return 'a GET request cannot have a body'
  if (typeof config['body'] === 'string' && config['body'].trim()) {
    // Variables sit inside string values ("{{status}}"), so a valid template is valid JSON as written.
    try { JSON.parse(config['body']) } catch { return 'body must be valid JSON, with {{variables}} inside string values' }
  }
  const headers = config['headers']
  if (headers !== undefined && (!isObject(headers) || !Object.values(headers).every((v) => typeof v === 'string'))) {
    return 'headers must be an object of text values'
  }
  if (placeholderInAuthority(config['url'])) return 'a placeholder cannot be part of the host of the URL: a value filled in when the action runs would choose where the request goes'
  if (placeholderInCredentials(config['url'])) return 'a placeholder cannot be in the user or password of the URL: send credentials in the Authorization header (for example {{secret_name_basic}})'
  const secrets = readSecrets(config['secrets'])
  if ('error' in secrets) return secrets.error

  const placeholders = secretPlaceholders(config)
  for (const placeholder of placeholders) {
    if (!secrets.refs.some((ref) => ref.name === placeholderParts(placeholder).name)) {
      return `{{${placeholder}}} refers to a secret named "${placeholderParts(placeholder).name}", which this action does not read`
    }
  }
  const unused = secrets.refs.find((ref) => !placeholders.some((placeholder) => placeholderParts(placeholder).name === ref.name))
  if (unused) return `the secret "${unused.name}" is chosen, but nothing uses it: put {{secret_${unused.name}}} (or a part of it) in a header, the URL or the body`
  return null
}

const PARTS_BY_TYPE: Record<string, readonly string[] | undefined> = {
  value: [''],
  userpass: ['username', 'password', 'basic'],
}

/** What a secret of a type offers, as the placeholders a configuration may use for it. */
export function offeredPlaceholders(name: string, type: string): string[] {
  const parts = PARTS_BY_TYPE[type]
  return parts ? parts.map((part) => (part ? `{{secret_${name}_${part}}}` : `{{secret_${name}}}`)) : [`{{secret_${name}_<key>}}`]
}

/** Whether every placeholder is one the type of its secret offers; null if fine. `typeBySecretId` holds the types of the secrets the configuration reads. */
export function actionSecretTypeProblem(config: Json, typeBySecretId: ReadonlyMap<number, string>): string | null {
  const secrets = readSecrets(config['secrets'])
  if ('error' in secrets) return null
  for (const placeholder of secretPlaceholders(config)) {
    const { name, part } = placeholderParts(placeholder)
    const ref = secrets.refs.find((candidate) => candidate.name === name)
    const type = ref ? typeBySecretId.get(ref.secretId) : undefined
    const allowed = type ? PARTS_BY_TYPE[type] : undefined
    if (ref && type && allowed && !allowed.includes(part)) {
      return `{{${placeholder}}} is not available from the ${type === 'value' ? 'single-value' : 'user and password'} secret "${name}" (use ${offeredPlaceholders(name, type).join(', ')})`
    }
    if (ref && type && !allowed && !part) return `{{${placeholder}}} needs a key of the JSON secret "${name}": {{secret_${name}_<key>}}`
  }
  return null
}

/** Whether every chosen secret exists and offers the placeholders the configuration uses; null if fine. */
export async function actionVaultProblem(config: Json): Promise<string | null> {
  const secrets = readSecrets(config['secrets'])
  if ('error' in secrets || secrets.refs.length === 0) return null
  const rows = await db.select({ id: vaultSecrets.id, vaultId: vaultSecrets.vaultId, type: vaultSecrets.type }).from(vaultSecrets)
    .where(inArray(vaultSecrets.id, secrets.refs.map((ref) => ref.secretId)))
  for (const ref of secrets.refs) {
    if (!rows.some((row) => row.id === ref.secretId && row.vaultId === ref.vaultId)) return `The vault secret chosen for "${ref.name}" does not exist`
  }
  return actionSecretTypeProblem(config, new Map(rows.map((row) => [row.id, row.type])))
}
