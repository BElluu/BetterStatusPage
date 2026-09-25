import { db } from '../db/client.js'
import { branding } from '../db/schema.js'
import { DEFAULT_BRANDING_COLORS } from '@bsp/shared'

/**
 * Branded subscriber emails. Every message is plain data (`EmailContent`) poured into one layout,
 * so an editable template can later replace `renderEmail` without touching the senders.
 */

export interface EmailBrand {
  siteName: string
  pageUrl: string
  logo: { kind: 'image'; url: string } | { kind: 'text'; text: string }
  colors: {
    background: string
    card: string
    border: string
    text: string
    muted: string
    primary: string
    up: string
    down: string
    degraded: string
    maintenance: string
    /** Same values as the primary buttons of the status page and the admin console. */
    actionBg: string
    actionFg: string
  }
}

export interface EmailContent {
  /** Inbox preview line, hidden in the message itself. */
  preheader: string
  badge?: { label: string; color: string }
  title: string
  paragraphs?: string[]
  details?: Array<{ label: string; value: string }>
  /** Quoted block — an incident update, a maintenance description. */
  quote?: string
  /** Monospace block — an error message. */
  code?: string
  cta?: { label: string; url: string }
  footer: string
  footerLink?: { label: string; url: string }
}

export type StatusTone = 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'maintenance' | 'warning' | 'paused'

/** Mirrors the status page: the colour an incident status is shown in on its card. */
export function toneColor(brand: EmailBrand, tone: StatusTone): string {
  const c = brand.colors
  return ({
    investigating: c.down, identified: c.degraded, monitoring: c.primary, resolved: c.up,
    maintenance: c.maintenance, warning: c.degraded, paused: c.down,
  } as const)[tone]
}

function absolute(publicUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  return `${publicUrl}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * Emails are read on a light background, so the light variant of an uploaded logo is used. Without
 * an uploaded logo the site name is set as text — the bundled product logo is a 2 MB image that
 * many mail clients would not load, and it is not the page owner's brand anyway.
 */
export async function loadEmailBrand(publicUrl: string): Promise<EmailBrand> {
  const row = (await db.select().from(branding))[0]
  const custom = row?.enabled === 1
  const palette = custom && row ? row : DEFAULT_BRANDING_COLORS
  const siteName = row?.siteName || 'Status Page'
  const logoPath = row ? (custom ? row.logoUrl : row.logoLightUrl) : null
  const logo: EmailBrand['logo'] = row?.logoType === 'text' && row.logoText
    ? { kind: 'text', text: row.logoText }
    : logoPath
      ? { kind: 'image', url: absolute(publicUrl, logoPath) }
      : { kind: 'text', text: siteName }
  return {
    siteName,
    pageUrl: `${publicUrl}/`,
    logo,
    colors: {
      background: palette.backgroundColor,
      card: '#ffffff',
      border: palette.cardBorderColor,
      text: palette.textColor,
      muted: palette.textMutedColor,
      primary: palette.primaryColor,
      up: palette.statusUpColor,
      down: palette.statusDownColor,
      degraded: palette.statusDegradedColor,
      maintenance: '#1d4ed8',
      actionBg: '#dbe7ff',
      actionFg: '#172033',
    },
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const multiline = (value: string) => esc(value).replace(/\r?\n/g, '<br>')

/** Darkens a colour so it stays legible as text on its own light tint (bright yellows otherwise wash out). */
function shade(hex: string, keep = 0.62): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return hex
  const n = parseInt(match[1]!, 16)
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * keep).toString(16).padStart(2, '0')).join('')}`
}

/** A light tint of a colour for badge backgrounds — email clients do not support color-mix(). */
function tint(hex: string, keep = 0.12): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return '#f2f3ff'
  const n = parseInt(match[1]!, 16)
  const mix = (channel: number) => Math.round(channel * keep + 255 * (1 - keep))
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix).map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

export function renderEmail(brand: EmailBrand, content: EmailContent): { html: string; text: string } {
  const c = brand.colors
  const logo = brand.logo.kind === 'image'
    ? `<img src="${esc(brand.logo.url)}" alt="${esc(brand.siteName)}" height="40" style="display:block;height:40px;max-width:200px;border:0;outline:none;text-decoration:none">`
    : `<span style="font-size:20px;font-weight:800;color:${c.text};letter-spacing:-0.01em">${esc(brand.logo.text)}</span>`

  const badge = content.badge
    ? `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${tint(content.badge.color)};color:${shade(content.badge.color)};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">${esc(content.badge.label)}</span>`
    : ''

  const paragraphs = (content.paragraphs ?? [])
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${c.text}">${multiline(p)}</p>`)
    .join('')

  const details = content.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 18px;border-collapse:collapse">${content.details.map((d) => `
        <tr>
          <td width="96" style="width:96px;padding:6px 16px 6px 0;font-size:13px;color:${c.muted};white-space:nowrap;vertical-align:top">${esc(d.label)}</td>
          <td style="padding:6px 0;font-size:14px;color:${c.text};vertical-align:top">${multiline(d.value)}</td>
        </tr>`).join('')}
      </table>`
    : ''

  const quote = content.quote
    ? `<div style="margin:0 0 20px;padding:14px 16px;border-left:3px solid ${content.badge?.color ?? c.border};background:${c.background};border-radius:0 8px 8px 0;font-size:15px;line-height:1.6;color:${c.text}">${multiline(content.quote)}</div>`
    : ''

  const code = content.code
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:${c.background};border:1px solid ${c.border};border-radius:8px;font-family:${MONO};font-size:13px;line-height:1.5;color:${c.text};word-break:break-word">${multiline(content.code)}</div>`
    : ''

  const cta = content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr>
        <td style="border-radius:12px;background:${c.actionBg}">
          <a href="${esc(content.cta.url)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:${c.actionFg};text-decoration:none;border-radius:12px">${esc(content.cta.label)}</a>
        </td>
      </tr></table>`
    : ''

  const footerLink = content.footerLink
    ? `<br><a href="${esc(content.footerLink.url)}" style="color:${c.muted};text-decoration:underline">${esc(content.footerLink.label)}</a>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(content.title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.background};font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.background}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="padding:0 4px 20px"><a href="${esc(brand.pageUrl)}" style="text-decoration:none">${logo}</a></td></tr>
      <tr><td style="background:${c.card};border:1px solid ${c.border};border-radius:16px;padding:28px 28px 24px">
        ${badge ? `<div style="margin:0 0 14px">${badge}</div>` : ''}
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:800;color:${c.text}">${esc(content.title)}</h1>
        ${paragraphs}${details}${quote}${code}${cta}
      </td></tr>
      <tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.6;color:${c.muted}">
        ${esc(content.footer)}${footerLink}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`

  const text = [
    content.title,
    '',
    ...(content.paragraphs ?? []).flatMap((p) => [p, '']),
    ...(content.details?.length ? [...content.details.map((d) => `${d.label}: ${d.value}`), ''] : []),
    ...(content.quote ? [content.quote, ''] : []),
    ...(content.code ? [content.code, ''] : []),
    ...(content.cta ? [`${content.cta.label}: ${content.cta.url}`, ''] : []),
    '—',
    content.footer,
    ...(content.footerLink ? [`${content.footerLink.label}: ${content.footerLink.url}`] : []),
  ].join('\n')

  return { html, text }
}
