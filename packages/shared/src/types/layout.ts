export type NodeType = 'page' | 'group' | 'monitor' | 'text' | 'divider'

interface BaseNode {
  id: string
  type: NodeType
  label?: string
}

export interface PageNode extends BaseNode {
  type: 'page'
  children: LayoutNode[]
}

export interface GroupNode extends BaseNode {
  type: 'group'
  groupId: number
  collapsible: boolean
  children: LayoutNode[]
}

export interface MonitorNode extends BaseNode {
  type: 'monitor'
  monitorId: number
  showUptimeBar: boolean
  showResponseTime: boolean
}

export interface TextNode extends BaseNode {
  type: 'text'
  markdown: string
}

export interface DividerNode extends BaseNode {
  type: 'divider'
}

export type LayoutNode = GroupNode | MonitorNode | TextNode | DividerNode
export type LayoutTree = PageNode
