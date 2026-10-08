/** Quotes one CSV cell. Spreadsheets run text that starts with one of `= + - @` (or a tab/CR) as a formula, so it is prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`
}

/** A CSV document with CRLF line endings; `header` is written as is. */
export function csvDocument(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n') + '\r\n'
}
