import { getCollection, type CollectionEntry } from 'astro:content'

export type Guide = CollectionEntry<'guides'>

export const REPO_URL = 'https://github.com/BElluu/BetterStatusPage'
export const SITE_URL = 'https://betterstatuspage.dev'

/**
 * Sidebar order. Each slug is a file name in docs/ without `.md`; `label` overrides the page title
 * in the sidebar only. A guide missing from this list still gets a page and shows up under "More".
 */
const SECTIONS: { label: string; items: { slug: string; label?: string }[] }[] = [
  {
    label: 'Get started',
    items: [{ slug: 'deployment', label: 'Deployment' }],
  },
  {
    label: 'Monitoring',
    items: [
      { slug: 'monitors', label: 'Monitors' },
      { slug: 'notification-channels', label: 'Notification channels' },
      { slug: 'alert-hygiene' },
      { slug: 'reports', label: 'Uptime reports' },
    ],
  },
  {
    label: 'Status page',
    items: [
      { slug: 'incidents-and-maintenance', label: 'Incidents and maintenance' },
      { slug: 'customizing-the-status-page', label: 'Customizing the page' },
      { slug: 'subscriptions', label: 'Subscriptions' },
      { slug: 'private-status-page' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { slug: 'slack-integration', label: 'Slack' },
      { slug: 'discord-integration', label: 'Discord' },
      { slug: 'teams-integration', label: 'Microsoft Teams' },
    ],
  },
  {
    label: 'Security',
    items: [
      { slug: 'users-and-roles', label: 'Users and roles' },
      { slug: 'single-sign-on' },
      { slug: 'vault', label: 'Secrets vault' },
    ],
  },
  {
    label: 'Operate',
    items: [{ slug: 'backup-restore', label: 'Backup and restore' }],
  },
  {
    label: 'Releases',
    items: [{ slug: 'changelog' }],
  },
]

export interface NavLink {
  slug: string
  href: string
  label: string
}

export interface NavSection {
  label: string
  links: NavLink[]
}

export function titleOf(guide: Guide): string {
  return guide.data.title ?? /^#\s+(.+)$/m.exec(guide.body ?? '')?.[1].trim() ?? guide.id
}

/** First paragraph of the guide as plain text, for the meta description and the index cards. */
export function descriptionOf(guide: Guide): string {
  if (guide.data.description) return guide.data.description
  const paragraph = (guide.body ?? '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|---|```|>|\||-|\*|\d+\.|<)/.test(block))
  if (!paragraph) return ''
  return paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
}

export const hrefOf = (slug: string) => `/${slug}/`

export async function getGuides(): Promise<Guide[]> {
  return getCollection('guides')
}

export async function getNav(): Promise<NavSection[]> {
  const guides = new Map((await getGuides()).map((guide) => [guide.id, guide]))
  const listed = new Set<string>()
  const sections: NavSection[] = SECTIONS.map((section) => ({
    label: section.label,
    links: section.items.flatMap(({ slug, label }) => {
      const guide = guides.get(slug)
      if (!guide) return []
      listed.add(slug)
      return [{ slug, href: hrefOf(slug), label: label ?? titleOf(guide) }]
    }),
  })).filter((section) => section.links.length > 0)

  const rest = [...guides.values()]
    .filter((guide) => !listed.has(guide.id))
    .map((guide) => ({ slug: guide.id, href: hrefOf(guide.id), label: titleOf(guide) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (rest.length > 0) sections.push({ label: 'More', links: rest })

  return sections
}
