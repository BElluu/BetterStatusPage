import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderEmail, toneColor, type EmailBrand } from '../src/services/emailTemplate.js'
import { renderSubscriberEmail, type SubscriberEvent } from '../src/workers/subscriberNotifier.js'

const brand: EmailBrand = {
  siteName: 'Acme Status',
  pageUrl: 'https://status.example.test/',
  logo: { kind: 'image', url: 'https://status.example.test/uploads/logo.png' },
  colors: {
    background: '#faf8ff', card: '#ffffff', border: '#c6c6cd', text: '#131b2e', muted: '#505f76',
    primary: '#000000', up: '#22c55e', down: '#ba1a1a', degraded: '#eab308', maintenance: '#1d4ed8',
    actionBg: '#dbe7ff', actionFg: '#172033',
  },
}

const event: SubscriberEvent = {
  type: 'incident.updated',
  occurredAt: Date.UTC(2026, 8, 25, 10, 15),
  incident: {
    id: 7, title: 'Checkout <script>alert(1)</script>', status: 'identified', impact: 'major',
    startedAt: Date.UTC(2026, 8, 25, 9, 58), resolvedAt: null,
    updates: [{ body: 'Rolling back\nthe deploy', status: 'identified', postedAt: Date.UTC(2026, 8, 25, 10, 15) }],
  },
  update: { body: 'Rolling back\nthe deploy', status: 'identified', postedAt: Date.UTC(2026, 8, 25, 10, 15) },
  components: [{ id: 3, name: 'Checkout API' }],
}

describe('branded subscriber emails', () => {
  it('renders an incident update with logo, status colour, details and one management link', () => {
    const mail = renderSubscriberEmail(event, brand, 'https://status.example.test', 'tok_123')
    assert.match(mail.html, /<img src="https:\/\/status\.example\.test\/uploads\/logo\.png" alt="Acme Status"/)
    // The status colour marks the update; badge text is darkened from it so yellow stays legible.
    assert.match(mail.html, new RegExp(`border-left:3px solid ${toneColor(brand, 'identified')}`))
    assert.match(mail.html, />Identified<\/span>/)
    assert.match(mail.html, /Checkout API/)
    assert.match(mail.html, /Rolling back<br>the deploy/)
    assert.match(mail.html, /href="https:\/\/status\.example\.test\/#subscription=manage&amp;token=tok_123"[^>]*>Manage or unsubscribe</)
    assert.doesNotMatch(mail.html, /subscription=unsubscribe/)
    assert.equal(mail.headers['List-Unsubscribe'], '<https://status.example.test/api/v1/public/subscriptions/unsubscribe?token=tok_123>')
  })

  it('escapes everything operators or visitors typed', () => {
    const mail = renderSubscriberEmail(event, brand, 'https://status.example.test', 'tok_123')
    assert.doesNotMatch(mail.html, /<script>/)
    assert.match(mail.html, /Checkout &lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })

  it('keeps a readable plain-text alternative with the same information', () => {
    const mail = renderSubscriberEmail(event, brand, 'https://status.example.test', 'tok_123')
    assert.match(mail.text, /^Checkout <script>alert\(1\)<\/script>/)
    assert.match(mail.text, /Status: Identified/)
    assert.match(mail.text, /Affected: Checkout API/)
    assert.match(mail.text, /Manage or unsubscribe: https:\/\/status\.example\.test\/#subscription=manage&token=tok_123/)
    assert.doesNotMatch(mail.text, /Unsubscribe: /)
  })

  it('shows a text logo when the page uses one', () => {
    const { html } = renderEmail({ ...brand, logo: { kind: 'text', text: 'ACME' } }, {
      preheader: 'p', title: 'Hello', footer: 'f',
    })
    assert.doesNotMatch(html, /<img/)
    assert.match(html, />ACME</)
  })
})
