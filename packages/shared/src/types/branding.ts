export interface Branding {
  id: number
  siteName: string
  logoUrl: string | null
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
  customCss: string | null
  enabled: number
  logoType: string
  logoText: string | null
  updatedAt: number
}
