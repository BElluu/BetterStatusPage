import { useState } from 'react'

interface CopyButtonProps {
  value: string
  label?: string
  copiedLabel?: string
}

export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied!' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="copy-feedback-button flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-semibold"
      data-copied={copied || undefined}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
        {copied ? 'check' : 'content_copy'}
      </span>
      {copied ? copiedLabel : label}
    </button>
  )
}
