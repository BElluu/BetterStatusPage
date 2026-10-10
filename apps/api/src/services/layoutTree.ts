import { clip } from '../lib/clip.js'

/** What the status page builder can place. Mirrors NodeType in @bsp/shared. */
export const LAYOUT_NODE_TYPES = ['page', 'group', 'monitor', 'text', 'divider', 'incidents', 'chart'] as const
type LayoutNodeType = typeof LAYOUT_NODE_TYPES[number]

const MAX_DEPTH = 12
const MAX_NODES = 2_000

const CONTAINERS: readonly LayoutNodeType[] = ['page', 'group']
const NAMES_A_MONITOR: readonly LayoutNodeType[] = ['monitor', 'chart']

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

export type Report = (path: string, message: string) => void

/**
 * Checks a layout tree from a configuration file and returns it as the builder stores it: `monitorKey` replaced by
 * `monitorId`, in the same place of each node. Every problem is reported rather than stopping at the first.
 */
export function layoutFromConfig(
  tree: unknown,
  monitorIdOf: (key: string) => number | undefined,
  report: Report,
  path = 'layout',
): Json {
  const ids = new Set<string>()
  let count = 0

  function node(value: unknown, at: string, depth: number, isRoot: boolean): Json {
    if (!isObject(value)) {
      report(at, 'must be an object')
      return {}
    }
    if (++count > MAX_NODES) {
      if (count === MAX_NODES + 1) report(at, `the layout has more than ${MAX_NODES} nodes`)
      return {}
    }
    if (depth > MAX_DEPTH) {
      report(at, `is nested deeper than ${MAX_DEPTH} levels`)
      return {}
    }

    const id = value['id']
    if (typeof id !== 'string' || !id.trim()) report(`${at}.id`, 'is required and must be text')
    else if (ids.has(id)) report(`${at}.id`, `"${clip(id)}" is used by another node`)
    else ids.add(id)

    const type = value['type']
    const known = typeof type === 'string' && (LAYOUT_NODE_TYPES as readonly string[]).includes(type)
    if (!known) report(`${at}.type`, `must be one of: ${LAYOUT_NODE_TYPES.join(', ')}`)
    else if (isRoot && type !== 'page') report(`${at}.type`, 'the root of the layout must be a page')
    else if (!isRoot && type === 'page') report(`${at}.type`, 'a page can only be the root of the layout')

    const nodeType = known ? type as LayoutNodeType : undefined
    if (nodeType && NAMES_A_MONITOR.includes(nodeType)) {
      if ('monitorId' in value) report(`${at}.monitorId`, 'a configuration file names the monitor with monitorKey, not its numeric id')
      const key = value['monitorKey']
      if (typeof key !== 'string' || !key) report(`${at}.monitorKey`, 'is required and must be the key of a monitor')
      else if (monitorIdOf(key) === undefined) {
        report(`${at}.monitorKey`, key.startsWith('(deleted') ? `${clip(key)} refers to a monitor that no longer exists; remove the node or point it at a monitor` : `unknown monitor "${clip(key)}"`)
      }
    } else if ('monitorKey' in value) {
      report(`${at}.monitorKey`, `a ${clip(String(type))} node does not show a monitor`)
    }

    const container = !!nodeType && CONTAINERS.includes(nodeType)
    if (!container && 'children' in value) report(`${at}.children`, `a ${clip(String(type))} node cannot have children`)
    if (container && value['children'] !== undefined && !Array.isArray(value['children'])) report(`${at}.children`, 'must be a list of nodes')

    return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
      if (key === 'monitorKey' && typeof inner === 'string') return ['monitorId', monitorIdOf(inner) ?? 0]
      if (key === 'children' && container && Array.isArray(inner)) return [key, inner.map((child, index) => node(child, `${at}.children[${index}]`, depth + 1, false))]
      return [key, inner]
    }).concat(container && !('children' in value) ? [['children', []]] : []))
  }

  return node(tree, path, 0, true)
}
