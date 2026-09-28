import { useEffect, useRef, useState } from 'react'

interface CopyButtonProps {
  value: string
  label?: string | undefined
  copiedLabel?: string | undefined
  failedLabel?: string | undefined
  /** Show only the icon; the label still names the button for assistive technology. */
  iconOnly?: boolean | undefined
}

type CopyState = 'idle' | 'copied' | 'failed'

/** Clipboard API first; outside a secure context (plain-HTTP deployments) fall back to a hidden textarea. */
async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Copy command was rejected')
  } finally {
    textarea.remove()
  }
}

export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied!', failedLabel = 'Copy failed', iconOnly = false }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    let next: CopyState
    try {
      await writeClipboard(value)
      next = 'copied'
    } catch {
      next = 'failed'
    }
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const text = state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={text}
      title={iconOnly ? text : undefined}
      className="copy-feedback-button flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-semibold"
      data-copied={state === 'copied' || undefined}
      data-failed={state === 'failed' || undefined}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '14px' }}>
        {state === 'copied' ? 'check' : state === 'failed' ? 'error' : 'content_copy'}
      </span>
      {!iconOnly && <span aria-live="polite">{text}</span>}
    </button>
  )
}
