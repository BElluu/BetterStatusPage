export const DEFAULT_BRANDING_COLORS = {
  primaryColor: '#000000',
  accentColor: '#497cff',
  backgroundColor: '#faf8ff',
  cardBackground: '#f2f3ff',
  elevatedBackground: '#e2e7ff',
  chartBackground: '#f2f3ff',
  cardBorderColor: '#c6c6cd',
  chartGridColor: '#c6c6cd',
  textColor: '#131b2e',
  textMutedColor: '#505f76',
  statusUpColor: '#22c55e',
  statusDownColor: '#ba1a1a',
  statusDegradedColor: '#eab308',
} as const

export interface Branding {
  id: number
  siteName: string
  logoUrl: string | null
  logoLightUrl: string | null
  logoDarkUrl: string | null
  faviconUrl: string | null
  primaryColor: string
  accentColor: string
  backgroundColor: string
  cardBackground: string
  cardBorderColor: string
  textColor: string
  textMutedColor: string
  statusUpColor: string
  statusDownColor: string
  statusDegradedColor: string
  elevatedBackground: string
  chartBackground: string
  chartGridColor: string
  customCss: string | null
  enabled: number
  logoType: string
  logoText: string | null
  updatedAt: number
}
