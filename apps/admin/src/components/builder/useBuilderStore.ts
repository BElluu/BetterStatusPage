import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { arrayMove } from '@dnd-kit/sortable'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'

interface BuilderState {
  tree: LayoutTree
  selectedId: string | null
  isDirty: boolean

  setTree: (tree: LayoutTree) => void
  selectNode: (id: string | null) => void
  markClean: () => void

  addNode: (parentId: string, node: Omit<LayoutNode, 'id'>) => void
  updateNode: (id: string, patch: Partial<LayoutNode>) => void
  deleteNode: (id: string) => void

  // Reorder within the same parent
  reorderInParent: (parentId: string, activeId: string, overId: string) => void
  // Move a node from its current parent to a new parent at a given index
  moveToParent: (nodeId: string, newParentId: string, overNodeId?: string) => void
}

// ── tree helpers ──────────────────────────────────────────────────────────────

function getChildren(tree: LayoutTree, parentId: string): LayoutNode[] | null {
  if (parentId === 'root') return tree.children
  const node = findNode(tree.children, parentId)
  return node?.type === 'group' ? (node as GroupNode).children : null
}

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

/** Returns the parent id ('root' or a group node id) for the given nodeId */
export function findParentId(tree: LayoutTree, nodeId: string): string | null {
  function search(children: LayoutNode[], parentId: string): string | null {
    for (const child of children) {
      if (child.id === nodeId) return parentId
      if (child.type === 'group') {
        const found = search((child as GroupNode).children, child.id)
        if (found) return found
      }
    }
    return null
  }
  return search(tree.children, 'root')
}

function removeFromParent(tree: LayoutTree, nodeId: string): [LayoutTree, LayoutNode | null] {
  let removed: LayoutNode | null = null

  function strip(children: LayoutNode[]): LayoutNode[] {
    const result: LayoutNode[] = []
    for (const child of children) {
      if (child.id === nodeId) {
        removed = child
        continue
      }
      if (child.type === 'group') {
        const g = child as GroupNode
        result.push({ ...g, children: strip(g.children) })
      } else {
        result.push(child)
      }
    }
    return result
  }

  const newTree = { ...tree, children: strip(tree.children) }
  return [newTree, removed]
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
    set((state) => {
      const tree = structuredClone(state.tree)
      const children = getChildren(tree, parentId)
      if (children) children.push(node)
      return { tree, isDirty: true }
    })
  },

  updateNode: (id, patch) => {
    set((state) => {
      function update(children: LayoutNode[]): LayoutNode[] {
        return children.map((child) => {
          if (child.id === id) return { ...child, ...patch } as LayoutNode
          if (child.type === 'group') {
            const g = child as GroupNode
            return { ...g, children: update(g.children) }
          }
          return child
        })
      }
      return { tree: { ...state.tree, children: update(state.tree.children) }, isDirty: true }
    })
  },

  deleteNode: (id) => {
    set((state) => {
      const [tree] = removeFromParent(state.tree, id)
      return {
        tree,
        isDirty: true,
        selectedId: state.selectedId === id ? null : state.selectedId,
      }
    })
  },

  reorderInParent: (parentId, activeId, overId) => {
    set((state) => {
      const tree = structuredClone(state.tree)
      const children = getChildren(tree, parentId)
      if (!children) return state
      const oldIdx = children.findIndex((n) => n.id === activeId)
      const newIdx = children.findIndex((n) => n.id === overId)
      if (oldIdx === -1 || newIdx === -1) return state
      const reordered = arrayMove(children, oldIdx, newIdx)
      if (parentId === 'root') {
        return { tree: { ...tree, children: reordered }, isDirty: true }
      }
      // Update the group node in the tree
      function updateGroup(nodes: LayoutNode[]): LayoutNode[] {
        return nodes.map((n) => {
          if (n.id === parentId && n.type === 'group') {
            return { ...n, children: reordered } as GroupNode
          }
          if (n.type === 'group') {
            return { ...(n as GroupNode), children: updateGroup((n as GroupNode).children) }
          }
          return n
        })
      }
      return { tree: { ...tree, children: updateGroup(tree.children) }, isDirty: true }
    })
  },

  moveToParent: (nodeId, newParentId, overNodeId) => {
    set((state) => {
      // 1. Remove from current parent
      let [tree, node] = removeFromParent(state.tree, nodeId)
      if (!node) return state

      // 2. Insert into new parent
      function insertInto(children: LayoutNode[], parentId: string): LayoutNode[] {
        if (parentId === 'root') {
          // Insert after overNodeId if provided, else at end
          if (overNodeId) {
            const idx = children.findIndex((n) => n.id === overNodeId)
            if (idx !== -1) {
              const result = [...children]
              result.splice(idx + 1, 0, node!)
              return result
            }
          }
          return [...children, node!]
        }
        return children.map((child) => {
          if (child.id === parentId && child.type === 'group') {
            const g = child as GroupNode
            const newChildren = overNodeId
              ? (() => {
                const idx = g.children.findIndex((n) => n.id === overNodeId)
                if (idx !== -1) {
                  const arr = [...g.children]
                  arr.splice(idx + 1, 0, node!)
                  return arr
                }
                return [...g.children, node!]
              })()
              : [...g.children, node!]
            return { ...g, children: newChildren }
          }
          if (child.type === 'group') {
            const g = child as GroupNode
            return { ...g, children: insertInto(g.children, parentId) }
          }
          return child
        })
      }

      const newTree = { ...tree, children: insertInto(tree.children, newParentId) }
      return { tree: newTree, isDirty: true }
    })
  },
}))

// ── factories ─────────────────────────────────────────────────────────────────

export function createMonitorNode(monitorId: number): Omit<MonitorNode, 'id'> {
  return { type: 'monitor', monitorId, showUptimeBar: true, showResponseTime: true }
}

export function createGroupNode(label: string): Omit<GroupNode, 'id'> {
  return { type: 'group', label, collapsible: true, children: [] }
}
