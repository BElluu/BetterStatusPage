import { useRef, type CSSProperties, type ReactNode } from 'react'

const COLOR = {
  key: 'var(--m3-primary)',
  string: 'var(--m3-up)',
  literal: 'var(--m3-degraded)',
  muted: 'var(--m3-secondary)',
} as const

const KEY = /^(\s*(?:-\s+)*)([^\s#:'"-][^#:]*?|"[^"]*"|'[^']*')(:)(?=\s|$)/
const DASH = /^(\s*)(-)(?=\s|$)/
const LITERAL = /^(?:true|false|null|~|[-+]?\d[\d_.]*(?:[eE][-+]?\d+)?)$/i

const span = (color: string, text: string, index: number, italic = false): ReactNode => (
  <span key={index} style={{ color, fontStyle: italic ? 'italic' : undefined }}>{text}</span>
)

/** A scalar after a key or a dash: a quoted string, a literal (number, boolean, null), or plain text, with its trailing comment. */
function scalar(text: string, index: number): ReactNode[] {
  const quoted = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/.exec(text)
  const [body, comment = ''] = quoted ? [quoted[3] ?? '', ''] : splitComment(text)
  const parts: ReactNode[] = []
  if (quoted) {
    parts.push(quoted[1], span(COLOR.string, quoted[2] ?? '', index))
    parts.push(...trailing(body, index + 1))
    return parts
  }
  const value = body.trim()
  const start = body.indexOf(value)
  parts.push(body.slice(0, start), LITERAL.test(value) ? span(COLOR.literal, value, index) : value, body.slice(start + value.length))
  if (comment) parts.push(span(COLOR.muted, comment, index + 1, true))
  return parts
}

function trailing(text: string, index: number): ReactNode[] {
  const [rest, comment = ''] = splitComment(text)
  return comment ? [rest, span(COLOR.muted, comment, index, true)] : [rest]
}

/** Splits a trailing ` # comment` off unquoted text. */
function splitComment(text: string): [string, string?] {
  const at = text.search(/(^|\s)#/)
  if (at < 0) return [text]
  const hash = text.indexOf('#', at)
  return [text.slice(0, hash), text.slice(hash)]
}

function line(text: string, index: number): ReactNode {
  if (/^\s*#/.test(text)) return span(COLOR.muted, text, index, true)
  if (/^(---|\.\.\.)\s*$/.test(text)) return span(COLOR.muted, text, index)
  const key = KEY.exec(text)
  if (key) {
    const [whole, indent = '', name = '', colon = ''] = key
    return <span key={index}>{indent}{span(COLOR.key, name, 0)}{colon}{scalar(text.slice(whole.length), 1)}</span>
  }
  const dash = DASH.exec(text)
  if (dash) return <span key={index}>{dash[1]}{span(COLOR.muted, '-', 0)}{scalar(text.slice(dash[0].length), 1)}</span>
  return text
}

/** The YAML coloured by line. It only colours; the text is exactly the text given, so it can sit under a textarea. */
export function highlightYaml(text: string): ReactNode {
  return text.split('\n').flatMap((each, index, all) => [line(each, index), index < all.length - 1 ? '\n' : null])
}

const SHARED: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: '18px',
  padding: '9px 13px',
  margin: 0,
  whiteSpace: 'pre',
  tabSize: 2,
}

interface YamlEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  rows: number
}

/**
 * A text box that colours YAML as it is typed: the coloured text is drawn under a transparent textarea that holds
 * the real text, caret and selection. The corner of the box resizes it.
 */
export function YamlEditor({ value, onChange, placeholder, label, rows }: YamlEditorProps) {
  const colored = useRef<HTMLPreElement>(null)

  return (
    <div className="input-m3 relative overflow-hidden focus-within:border-[color:var(--m3-primary)]" style={{ padding: 0 }}>
      <pre ref={colored} aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none" style={{ ...SHARED, color: 'var(--m3-on-surface)' }}>
        {highlightYaml(value)}{'\n'}
      </pre>
      <textarea
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (!colored.current) return
          colored.current.scrollTop = e.currentTarget.scrollTop
          colored.current.scrollLeft = e.currentTarget.scrollLeft
        }}
        placeholder={placeholder}
        spellCheck={false}
        wrap="off"
        rows={rows}
        className="relative block w-full overflow-auto"
        style={{ ...SHARED, background: 'transparent', border: 0, outline: 'none', color: 'transparent', caretColor: 'var(--m3-on-surface)', resize: 'vertical' }}
      />
    </div>
  )
}
