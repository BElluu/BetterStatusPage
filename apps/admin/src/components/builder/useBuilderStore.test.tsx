import { beforeEach, describe, expect, it } from 'vitest'
import { createGroupNode, createMonitorNode, defaultGrid, findNode, useBuilderStore } from './useBuilderStore'

describe('builder store', () => {
  beforeEach(() => {
    useBuilderStore.getState().setTree({ id: 'root', type: 'page', children: [] })
  })

  it('adds, updates, selects, and deletes nodes', () => {
    const store = useBuilderStore.getState()
    store.addNode('root', { ...createGroupNode('Services'), grid: defaultGrid('group') })
    const group = useBuilderStore.getState().tree.children[0]!
    if (group.type !== 'group') throw new Error('Group missing')
    useBuilderStore.getState().addNode(group.id, createMonitorNode(7))
    const updatedGroup = useBuilderStore.getState().tree.children[0]!
    if (updatedGroup.type !== 'group') throw new Error('Group missing')
    const monitor = findNode(useBuilderStore.getState().tree.children, updatedGroup.children[0]!.id)
    expect(monitor?.type).toBe('monitor')

    useBuilderStore.getState().updateNode(group.id, { label: 'Core services' })
    expect(findNode(useBuilderStore.getState().tree.children, group.id)?.label).toBe('Core services')
    useBuilderStore.getState().selectNode(group.id)
    useBuilderStore.getState().deleteNode(group.id)
    expect(useBuilderStore.getState().selectedId).toBeNull()
    expect(useBuilderStore.getState().tree.children).toEqual([])
  })

  it('moves monitors into groups and reorders children', () => {
    const store = useBuilderStore.getState()
    store.addNode('root', { ...createGroupNode('Group'), grid: defaultGrid('group') })
    store.addNode('root', { ...createMonitorNode(1), grid: { x: 0, y: 1, w: 1, h: 1 } })
    store.addNode('root', { ...createMonitorNode(2), grid: { x: 1, y: 1, w: 1, h: 1 } })
    const [group, first, second] = useBuilderStore.getState().tree.children
    useBuilderStore.getState().moveToGroup(first!.id, group!.id)
    useBuilderStore.getState().moveToGroup(second!.id, group!.id)
    const grouped = findNode(useBuilderStore.getState().tree.children, group!.id)
    if (!grouped || grouped.type !== 'group') throw new Error('Group missing')
    expect(grouped.children.map((node) => node.type === 'monitor' && node.monitorId)).toEqual([1, 2])
    useBuilderStore.getState().reorderGroupChildren(group!.id, grouped.children[0]!.id, grouped.children[1]!.id)
    const reordered = findNode(useBuilderStore.getState().tree.children, group!.id)
    if (!reordered || reordered.type !== 'group') throw new Error('Group missing')
    expect(reordered.children.map((node) => node.type === 'monitor' && node.monitorId)).toEqual([2, 1])
  })

  it('applies grid layouts and shifts rows when inserting', () => {
    useBuilderStore.getState().addNode('root', { ...createMonitorNode(1), grid: { x: 0, y: 1, w: 1, h: 1 } })
    const node = useBuilderStore.getState().tree.children[0]!
    useBuilderStore.getState().applyGridLayout([{ i: node.id, x: 2, y: 3, w: 1, h: 2 }])
    expect(useBuilderStore.getState().tree.children[0]!.grid).toEqual({ x: 2, y: 3, w: 1, h: 2 })
    useBuilderStore.getState().insertRootNode({ ...createMonitorNode(2), grid: { x: 0, y: 3, w: 1, h: 1 } }, 3)
    expect(useBuilderStore.getState().tree.children[0]!.grid?.y).toBe(4)
    expect(useBuilderStore.getState().isDirty).toBe(true)
  })
})
