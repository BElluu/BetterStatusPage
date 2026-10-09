import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { Alert, ErrorState, LoadingState, PageContainer, PageHeader } from '../components/ui'
import { formatDateTime } from '../lib/dateFormat'

interface TestResult {
  issuer: string
  testedAt: number
  claims: Record<string, unknown> | null
  outcome: 'sign_in' | 'link' | 'provision' | 'deny'
  user: string | null
  denial: { code: string; reason: string; email?: string } | null
}

// Claims that decide the outcome, shown first.
const KEY_CLAIMS = ['sub', 'email', 'email_verified', 'xms_edov', 'preferred_username', 'name']

function formatClaim(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function Outcome({ result }: { result: TestResult }) {
  if (result.outcome === 'sign_in') {
    return <Alert tone="success" title="Sign-in would succeed">Signs in as <strong>{result.user}</strong>, matched by their linked identity-provider account.</Alert>
  }
  if (result.outcome === 'link') {
    return <Alert tone="success" title="Sign-in would succeed">Signs in as <strong>{result.user}</strong>, matched by email. The first real sign-in links this identity-provider account to the user.</Alert>
  }
  if (result.outcome === 'provision') {
    return <Alert tone="success" title="Sign-in would succeed">Creates the Viewer account <strong>{result.user}</strong> for the private status page and links this identity-provider account to it.</Alert>
  }
  return (
    <Alert tone="error" title={`Sign-in would be refused (${result.denial?.code})`}>
      {result.denial?.reason}
    </Alert>
  )
}

export default function SsoTestResultPage() {
  const [params] = useSearchParams()
  const id = params.get('result') ?? ''
  const { data, isLoading, error } = useQuery<TestResult>({
    queryKey: ['sso-test', id],
    queryFn: () => api.get(`/admin/oidc/test-sign-in/${encodeURIComponent(id)}`),
    enabled: !!id,
    retry: false,
  })

  const claims = data?.claims ? Object.entries(data.claims) : []
  const ordered = [
    ...KEY_CLAIMS.flatMap((key) => claims.filter(([name]) => name === key)),
    ...claims.filter(([name]) => !KEY_CLAIMS.includes(name)).sort(([a], [b]) => a.localeCompare(b)),
  ]

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Single sign-on test"
        subtitle="Nobody was signed in and nothing was saved. Close this tab when you are done."
      />
      {!id ? <ErrorState message="No test result to show. Start a test sign-in from Users → Single sign-on." />
        : isLoading ? <LoadingState label="Loading the test result…" />
          : error || !data ? <ErrorState message={error instanceof Error ? error.message : 'Could not load the test result.'} />
            : (
              <>
                <Outcome result={data} />
                <p className="text-sm" style={{ color: 'var(--m3-secondary)' }}>
                  Issuer <code>{data.issuer}</code> · tested {formatDateTime(data.testedAt)}
                </p>
                {ordered.length > 0 && (
                  <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)' }}>
                    <table className="w-full text-sm">
                      <caption className="sr-only">ID token claims</caption>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--m3-outline-variant)' }}>
                          {['Claim', 'Value'].map((h) => (
                            <th key={h} className="px-4 py-3 font-mono text-xs uppercase tracking-wider text-left" style={{ color: 'var(--m3-secondary)', background: 'var(--m3-surface-container)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ordered.map(([name, value], i) => (
                          <tr key={name} style={{ borderTop: i > 0 ? '1px solid var(--m3-outline-variant)' : 'none' }}>
                            <td className="px-4 py-2 font-mono text-xs whitespace-nowrap align-top" style={{ color: 'var(--m3-secondary)' }}>{name}</td>
                            <td className="px-4 py-2 font-mono text-xs break-all" style={{ color: 'var(--m3-on-surface)' }}>{formatClaim(value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
    </PageContainer>
  )
}
