export type NodeType = 'page' | 'group' | 'monitor' | 'text' | 'divider' | 'incidents' | 'chart'

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
  name: string
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

export interface ChartNode extends BaseNode {
  type: 'chart'
  monitorId: number
  title?: string
  /** Hours of history to display: 1 | 3 | 6 | 12 | 24 | 48 | 168 */
  hours: number
  /** Number of data-point buckets: 20 | 30 | 50 */
  buckets: number
  /** Which aggregated value to plot as the primary line */
  aggregation: 'avg' | 'p95' | 'max'
  /** Fill area under the line */
  showArea?: boolean
  /** RGL row-height units (3 = small, 5 = medium, 7 = large) */
  chartH?: number
}

export type LayoutNode = GroupNode | MonitorNode | TextNode | DividerNode | IncidentsNode | ChartNode
export type LayoutTree = PageNode
