import type { Branding } from '@bsp/shared'

export function resolveBrandingLogoUrl(branding: Branding | null | undefined, isDark: boolean, brandingEnabled: boolean): string | null {
  if (!branding) return null
  return brandingEnabled ? branding.logoUrl : (isDark ? branding.logoDarkUrl : branding.logoLightUrl)
}

export function resolveBrandingCustomCss(branding: Branding | null | undefined): string | null {
  return branding?.enabled ? branding.customCss : null
}

/** Brand status colours are tuned for dots and bars; text pulls them towards the text colour so it stays readable. */
function statusTextColor(statusColor: string, textColor: string): string {
  return `color-mix(in srgb, ${statusColor} 55%, ${textColor})`
}

export function resolveBrandingCssVariables(branding: Branding): Record<`--${string}`, string> {
  return {
    '--bsp-up-text': statusTextColor(branding.statusUpColor, branding.textColor),
    '--bsp-down-text': statusTextColor(branding.statusDownColor, branding.textColor),
    '--bsp-degraded-text': statusTextColor(branding.statusDegradedColor, branding.textColor),
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
    '--bsp-partial': branding.statusPartialColor,
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
