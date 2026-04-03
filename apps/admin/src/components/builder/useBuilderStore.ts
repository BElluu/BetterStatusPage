import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { arrayMove } from '@dnd-kit/sortable'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode, TextNode, GridPos } from '@bsp/shared'

interface BuilderState {
  tree: LayoutTree
  selectedId: string | null
  isDirty: boolean

  setTree: (tree: LayoutTree) => void
  selectNode: (id: string | null) => void
  markClean: () => void

  /** Add a node to parentId='root' or a group id. For root nodes, include grid in the node data. */
  addNode: (parentId: string, node: Omit<LayoutNode, 'id'>) => void
  updateNode: (id: string, patch: Partial<LayoutNode>) => void
  deleteNode: (id: string) => void

  /** Batch-update grid positions from react-grid-layout's onLayoutChange */
  applyGridLayout: (items: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void

  /** Reorder children inside a group (for @dnd-kit within-group DnD) */
  reorderGroupChildren: (groupId: string, fromId: string, toId: string) => void
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function findNode(children: LayoutNode[], id: string): LayoutNode | null {
  for (const child of children) {
    if (child.id === id) return child
    if (child.type === 'group') {
      const found = findNode((child as GroupNode).children, id)
      if (found) return found
    }
  }
  return null
}

function mapTree(children: LayoutNode[], fn: (n: LayoutNode) => LayoutNode): LayoutNode[] {
  return children.map((child) => {
    const updated = fn(child)
    if (updated.type === 'group') {
      const g = updated as GroupNode
      return { ...g, children: mapTree(g.children, fn) }
    }
    return updated
  })
}

// ── store ─────────────────────────────────────────────────────────────────────

export const useBuilderStore = create<BuilderState>((set) => ({
  tree: { id: 'root', type: 'page', children: [] },
  selectedId: null,
  isDirty: false,

  setTree: (tree) => set({ tree, isDirty: false }),
  selectNode: (id) => set({ selectedId: id }),
  markClean: () => set({ isDirty: false }),

  addNode: (parentId, nodeWithoutId) => {
    const node = { ...nodeWithoutId, id: nanoid(8) } as LayoutNode
    set((s) => {
      if (parentId === 'root') {
        return { tree: { ...s.tree, children: [...s.tree.children, node] }, isDirty: true }
      }
      const children = mapTree(s.tree.children, (n) => {
        if (n.id === parentId && n.type === 'group') {
          const g = n as GroupNode
          return { ...g, children: [...g.children, node] }
        }
        return n
      })
      return { tree: { ...s.tree, children }, isDirty: true }
    })
  },

  updateNode: (id, patch) => {
    set((s) => ({
      tree: {
        ...s.tree,
        children: mapTree(s.tree.children, (n) => (n.id === id ? ({ ...n, ...patch } as LayoutNode) : n)),
      },
      isDirty: true,
    }))
  },

  deleteNode: (id) => {
    function strip(children: LayoutNode[]): LayoutNode[] {
      const result: LayoutNode[] = []
      for (const child of children) {
        if (child.id === id) continue
        if (child.type === 'group') {
          const g = child as GroupNode
          result.push({ ...g, children: strip(g.children) })
        } else {
          result.push(child)
        }
      }
      return result
    }
    set((s) => ({
      tree: { ...s.tree, children: strip(s.tree.children) },
      isDirty: true,
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
  },

  applyGridLayout: (items) => {
    const posMap = new Map(items.map((i) => [i.i, { x: i.x, y: i.y, w: i.w, h: i.h }]))
    set((s) => {
      const children = s.tree.children.map((node) => {
        const pos = posMap.get(node.id)
        if (!pos) return node
        const current = node.grid
        if (current?.x === pos.x && current.y === pos.y && current.w === pos.w && current.h === pos.h) {
          return node
        }
        return { ...node, grid: pos } as LayoutNode
      })
      return { tree: { ...s.tree, children }, isDirty: true }
    })
  },

  reorderGroupChildren: (groupId, fromId, toId) => {
    set((s) => {
      const children = mapTree(s.tree.children, (n) => {
        if (n.id !== groupId || n.type !== 'group') return n
        const g = n as GroupNode
        const oldIdx = g.children.findIndex((c) => c.id === fromId)
        const newIdx = g.children.findIndex((c) => c.id === toId)
        if (oldIdx === -1 || newIdx === -1) return n
        return { ...g, children: arrayMove(g.children, oldIdx, newIdx) }
      })
      return { tree: { ...s.tree, children }, isDirty: true }
    })
  },
}))

// ── factories ─────────────────────────────────────────────────────────────────

const DEFAULT_GRIDS: Record<string, GridPos> = {
  monitor: { x: 0, y: 0, w: 4, h: 1 },
  group:   { x: 0, y: 0, w: 6, h: 5 },
  text:    { x: 0, y: 0, w: 12, h: 2 },
  divider: { x: 0, y: 0, w: 12, h: 1 },
}

export function defaultGrid(type: string): GridPos {
  return DEFAULT_GRIDS[type] ?? { x: 0, y: 0, w: 4, h: 2 }
}

export function createMonitorNode(monitorId: number): Omit<MonitorNode, 'id'> {
  return { type: 'monitor', monitorId, showUptimeBar: true, showResponseTime: true, uptimeBarPosition: 'right' }
}

export function createGroupNode(label: string): Omit<GroupNode, 'id'> {
  return { type: 'group', label, collapsible: true, children: [] }
}

export function createTextNode(): Omit<TextNode, 'id'> {
  return { type: 'text', markdown: '## Tytuł sekcji\nOpis…' }
}
