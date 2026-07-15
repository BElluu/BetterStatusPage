import type { Branding } from '@bsp/shared'

export function resolveBrandingLogoUrl(branding: Branding | null | undefined, isDark: boolean, brandingEnabled: boolean): string | null {
  if (!branding) return null
  return brandingEnabled ? branding.logoUrl : (isDark ? branding.logoDarkUrl : branding.logoLightUrl)
}

export function resolveBrandingCustomCss(branding: Branding | null | undefined): string | null {
  return branding?.enabled ? branding.customCss : null
}

export function resolveBrandingCssVariables(branding: Branding): Record<`--${string}`, string> {
  return {
    '--bsp-bg': branding.backgroundColor,
    '--bsp-card-bg': branding.cardBackground,
    '--bsp-elevated-bg': branding.elevatedBackground,
    '--bsp-card-border': branding.cardBorderColor,
    '--bsp-text': branding.textColor,
    '--bsp-text-muted': branding.textMutedColor,
    '--bsp-primary': branding.primaryColor,
    '--bsp-accent': branding.accentColor,
    '--bsp-up': branding.statusUpColor,
    '--bsp-down': branding.statusDownColor,
    '--bsp-degraded': branding.statusDegradedColor,
    '--bsp-chart-bg': branding.chartBackground,
    '--bsp-chart-grid': branding.chartGridColor,
    '--color-primary': branding.primaryColor,
    '--color-accent': branding.accentColor,
    '--m3-surface': branding.backgroundColor,
    '--m3-surface-container-lowest': branding.cardBackground,
    '--m3-surface-container-low': branding.cardBackground,
    '--m3-surface-container': branding.elevatedBackground,
    '--m3-surface-container-high': branding.elevatedBackground,
    '--m3-surface-container-highest': branding.elevatedBackground,
    '--m3-on-surface': branding.textColor,
    '--m3-secondary': branding.textMutedColor,
    '--m3-outline-variant': branding.cardBorderColor,
    '--m3-primary': branding.primaryColor,
    '--m3-on-primary-container': branding.accentColor,
  }
}
