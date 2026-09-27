export interface TestStep   { label: string; status: 'ok' | 'error' | 'info'; detail?: string; cookies?: Record<string, string>; durationMs?: number }
export interface TestResult { overall: 'ok' | 'error'; steps: TestStep[]; totalMs: number }

function buildTestReport(result: TestResult): string {
  const icon = (s: TestStep['status']) => s === 'ok' ? '✓' : s === 'error' ? '✗' : 'i'
  const sep = '─'.repeat(60)
  const lines: string[] = [
    'BSP Monitor Test Report',
    `Date:   ${new Date().toISOString()}`,
    `Result: ${result.overall === 'ok' ? 'PASSED' : 'FAILED'}  |  Total: ${result.totalMs}ms`,
    sep,
    '',
  ]
  for (const step of result.steps) {
    const dur = step.durationMs != null ? `  (${step.durationMs}ms)` : ''
    lines.push(`[${icon(step.status)}] ${step.label}${dur}`)
    if (step.detail) {
      lines.push(`    ${step.detail}`)
    }
    if (step.cookies && Object.keys(step.cookies).length > 0) {
      lines.push('    Cookie jar:')
      for (const [name, value] of Object.entries(step.cookies)) {
        lines.push(`      ${name} = ${value}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function TestResultPanel({ result }: { result: TestResult }) {
  const isOk = result.overall === 'ok'
  const tone = isOk ? 'var(--m3-up-bar)' : 'var(--m3-down)'

  const handleDownload = () => {
    const text = buildTestReport(result)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bsp-test-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid color-mix(in srgb, ${tone} ${isOk ? 30 : 25}%, transparent)` }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ background: `color-mix(in srgb, ${tone} ${isOk ? 8 : 7}%, transparent)` }}
      >
        <div className="flex items-center gap-2">
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '18px', color: tone }}
          >
            {isOk ? 'check_circle' : 'cancel'}
          </span>
          <span className="text-sm font-semibold" style={{ color: tone }}>
            {isOk ? 'All checks passed' : 'Test failed'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDownload}
            title="Download full test report"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono transition-colors"
            style={{
              color: 'var(--m3-secondary)',
              background: 'var(--m3-surface-container)',
              border: '1px solid var(--m3-outline-variant)',
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>download</span>
            report
          </button>
          <span className="text-xs font-mono" style={{ color: 'var(--m3-secondary)' }}>
            {result.totalMs}ms total
          </span>
        </div>
      </div>

      {/* Steps */}
      <div className="divide-y" style={{ borderColor: 'var(--m3-outline-variant)' }}>
        {result.steps.filter(s => s.status !== 'info').map((step, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-2.5" style={{ background: 'var(--m3-surface-container-lowest)' }}>
            <span
              className="material-symbols-outlined shrink-0"
              style={{
                fontSize: '16px',
                marginTop: '1px',
                color: step.status === 'ok' ? 'var(--m3-up-bar)' : step.status === 'error' ? 'var(--m3-down)' : 'var(--m3-secondary)',
              }}
            >
              {step.status === 'ok' ? 'check_circle' : step.status === 'error' ? 'cancel' : 'info'}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: 'var(--m3-on-surface)' }}>{step.label}</p>
              {step.detail && (
                <p className="text-xs mt-0.5 break-all" style={{ color: 'var(--m3-secondary)' }}>{step.detail}</p>
              )}
            </div>
            {step.durationMs != null && (
              <span className="text-xs font-mono shrink-0" style={{ color: 'var(--m3-secondary)' }}>
                {step.durationMs}ms
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
