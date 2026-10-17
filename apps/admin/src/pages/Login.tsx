import { LoginPage } from '@better-kit/ui'

const FEATURES = [
  { icon: 'bolt', label: 'Live status updates' },
  { icon: 'campaign', label: 'Incidents and maintenance notices' },
  { icon: 'notifications', label: 'Alerts through your notification channels' },
]

/** The sign-in page with what this product says about itself. */
export default function Login() {
  return (
    <LoginPage
      headline={<>Monitor everything.<br /><span style={{ color: 'var(--m3-primary)' }}>Stay ahead</span> of issues.</>}
      tagline="Real-time status pages, incident management, and uptime monitoring — all in one place."
      features={FEATURES}
    />
  )
}
