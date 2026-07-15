import { describe, expect, it } from 'vitest'
import type { Branding } from '@bsp/shared'
import { resolveBrandingCustomCss, resolveBrandingLogoUrl, resolveBrandingPalette } from './App'

const branding = {
  logoUrl: '/brand.png',
  logoLightUrl: '/light.png',
  logoDarkUrl: '/dark.png',
  primaryColor: '#111111', accentColor: '#222222', backgroundColor: '#333333',
  cardBackground: '#444444', elevatedBackground: '#555555', cardBorderColor: '#666666',
  textColor: '#777777', textMutedColor: '#888888', statusUpColor: '#009900',
  statusDownColor: '#990000', statusDegradedColor: '#999900', chartBackground: '#121212',
  chartGridColor: '#343434',
} as Branding

describe('custom branding resolution', () => {
  it('uses one logo and one complete palette', () => {
    expect(resolveBrandingLogoUrl(branding, false, true)).toBe('/brand.png')
    expect(resolveBrandingLogoUrl(branding, false, false)).toBe('/light.png')
    expect(resolveBrandingLogoUrl(branding, true, false)).toBe('/dark.png')
    expect(resolveBrandingLogoUrl({ ...branding, logoLightUrl: null, logoDarkUrl: null }, true, false)).toBe('/brand.png')
    expect(resolveBrandingPalette(branding)).toEqual({
      primaryColor: '#111111', accentColor: '#222222', backgroundColor: '#333333',
      cardBackground: '#444444', elevatedBackground: '#555555', cardBorderColor: '#666666',
      textColor: '#777777', textMutedColor: '#888888', statusUpColor: '#009900',
      statusDownColor: '#990000', statusDegradedColor: '#999900', chartBackground: '#121212',
      chartGridColor: '#343434',
    })
  })

  it('applies custom CSS only while custom branding is enabled', () => {
    expect(resolveBrandingCustomCss({ ...branding, enabled: 0, customCss: '.bsp-page {}' })).toBeNull()
    expect(resolveBrandingCustomCss({ ...branding, enabled: 1, customCss: '.bsp-page {}' })).toBe('.bsp-page {}')
  })
})
