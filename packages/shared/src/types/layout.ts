export type NodeType = 'page' | 'group' | 'monitor' | 'text' | 'divider' | 'incidents'

export interface GridPos {
  x: number
  y: number
  w: number
  h: number
}

interface BaseNode {
  id: string
  type: NodeType
  label?: string
  /** Grid position on the main canvas (top-level nodes only) */
  grid?: GridPos
}

export interface PageNode extends BaseNode {
  type: 'page'
  children: LayoutNode[]
}

export interface GroupNode extends BaseNode {
  type: 'group'
  label: string
  collapsible: boolean
  children: LayoutNode[]
}

export interface MonitorNode extends BaseNode {
  type: 'monitor'
  monitorId: number
  showUptimeBar: boolean
  showResponseTime: boolean
  uptimeBarPosition?: 'right' | 'below'
  showMonitorType?: boolean
  showUptimePct?: boolean
  /** Card display variant: 'default' = full card with uptime bars, 'compact' = slim row */
  cardVariant?: 'default' | 'compact'
}

export interface TextNode extends BaseNode {
  type: 'text'
  markdown: string
}

export interface DividerNode extends BaseNode {
  type: 'divider'
}

export interface IncidentsNode extends BaseNode {
  type: 'incidents'
  /** Max number of incidents to show (default: 5) */
  limit?: number
  /** Show only active, only resolved, or both */
  filter?: 'active' | 'resolved' | 'all'
}

export type LayoutNode = GroupNode | MonitorNode | TextNode | DividerNode | IncidentsNode
export type LayoutTree = PageNode
