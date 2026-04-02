import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { LayoutTree, LayoutNode, GroupNode, MonitorNode } from '@bsp/shared'

interface BuilderState {
  tree: LayoutTree
  selectedId: string | null
  isDirty: boolean

  setTree: (tree: LayoutTree) => void
  selectNode: (id: string | null) => void
  addNode: (parentId: string, node: LayoutNode) => void
  updateNode: (id: string, patch: Partial<LayoutNode>) => void
  deleteNode: (id: string) => void
  moveNode: (nodeId: string, newParentId: string, newIndex: number) => void
  markClean: () => void
}

function findAndMutate(
  children: LayoutNode[],
  id: string,
  fn: (children: LayoutNode[], index: number) => void,
): boolean {
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.id === id) {
      fn(children, i)
      return true
    }
    const child = children[i]!
    if (child.type === 'group') {
      if (findAndMutate((child as GroupNode).children, id, fn)) return true
    }
  }
  return false
}

function findNode(children: LayoutNode[], id: string): LayoutNode | null {
  for (const child of children) {
    if (child.id === id) return child
    if (child.type === 'group') {
      const found = findNode((child as GroupNode).children, id)
      if (found) return found
    }
  }
  return null
}

function removeNode(children: LayoutNode[], id: string): LayoutNode | null {
  for (let i = 0; i < children.length; i++) {
    if (children[i]!.id === id) {
      const removed = children.splice(i, 1)[0]!
      return removed
    }
    const child = children[i]!
    if (child.type === 'group') {
      const removed = removeNode((child as GroupNode).children, id)
      if (removed) return removed
    }
  }
  return null
}

function getChildrenOf(tree: LayoutTree, parentId: string): LayoutNode[] | null {
  if (tree.id === parentId) return tree.children
  const node = findNode(tree.children, parentId)
  if (node && node.type === 'group') return (node as GroupNode).children
  return null
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  tree: { id: 'root', type: 'page', children: [] },
  selectedId: null,
  isDirty: false,

  setTree: (tree) => set({ tree, isDirty: false }),
  selectNode: (id) => set({ selectedId: id }),
  markClean: () => set({ isDirty: false }),

  addNode: (parentId, node) => {
    set((state) => {
      const tree = structuredClone(state.tree)
      const children = getChildrenOf(tree, parentId)
      if (children) {
        children.push({ ...node, id: nanoid(8) })
      }
      return { tree, isDirty: true }
    })
  },

  updateNode: (id, patch) => {
    set((state) => {
      const tree = structuredClone(state.tree)
      findAndMutate(tree.children, id, (arr, i) => {
        Object.assign(arr[i]!, patch)
      })
      return { tree, isDirty: true }
    })
  },

  deleteNode: (id) => {
    set((state) => {
      const tree = structuredClone(state.tree)
      removeNode(tree.children, id)
      return { tree, isDirty: true, selectedId: state.selectedId === id ? null : state.selectedId }
    })
  },

  moveNode: (nodeId, newParentId, newIndex) => {
    set((state) => {
      const tree = structuredClone(state.tree)
      const node = removeNode(tree.children, nodeId)
      if (!node) return state
      const targetChildren = getChildrenOf(tree, newParentId)
      if (!targetChildren) return state
      targetChildren.splice(newIndex, 0, node)
      return { tree, isDirty: true }
    })
  },
}))

export function createMonitorNode(monitorId: number): MonitorNode {
  return {
    id: nanoid(8),
    type: 'monitor',
    monitorId,
    showUptimeBar: true,
    showResponseTime: true,
  }
}

export function createGroupNode(groupId: number, label: string): GroupNode {
  return {
    id: nanoid(8),
    type: 'group',
    groupId,
    label,
    collapsible: true,
    children: [],
  }
}
