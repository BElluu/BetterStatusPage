/**
 * Lets the guides in docs/ stay plain GitHub-readable Markdown:
 * - drops the leading `# Title` (the layout renders the title itself),
 * - turns links to sibling guides (`deployment.md#nginx`) into site routes (`/deployment/#nginx`),
 * - points links that leave docs/ (`../README.md`) at the file on GitHub,
 * - colours the `✓` `•` `✕` marks of a comparison table (see convertMarks).
 */
const REPO_BLOB = 'https://github.com/BElluu/BetterStatusPage/blob/main/'

const SIBLING = /^(?:\.\/)?([\w-]+)\.md(#.*)?$/
const OUTSIDE = /^\.\.\/(.+)$/

function rewrite(url) {
  const sibling = SIBLING.exec(url)
  if (sibling) return `/${sibling[1].toLowerCase()}/${sibling[2] ?? ''}`
  const outside = OUTSIDE.exec(url)
  if (outside) return REPO_BLOB + outside[1]
  return url
}

/**
 * GitHub-style alert (`> [!WARNING]`) becomes a yellow callout on the site; on GitHub the same
 * Markdown renders as GitHub's own warning block. Used to mark features that are not released yet.
 */
const WARNING = /^\[!WARNING\][ \t]*\r?\n?/

function convertWarning(node) {
  const paragraph = node.children?.[0]
  const text = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : null
  if (text?.type !== 'text' || !WARNING.test(text.value)) return
  text.value = text.value.replace(WARNING, '')
  if (!text.value) paragraph.children.shift()
  node.data = { hName: 'aside', hProperties: { className: ['callout', 'callout-warning'] } }
}

/**
 * A table cell that starts with `✓` (yes), `•` (partly) or `✕` (no), and the legend line under such a
 * table, get the mark wrapped in a span so the site can colour it. In the Markdown the marks stay plain
 * characters, readable on GitHub as they are.
 */
const MARKS = { '✓': 'yes', '•': 'mid', '✕': 'no' }
const MARK_LABELS = { yes: 'Yes', mid: 'Partly', no: 'No' }
const MARK_CHARS = /([✓•✕])/

function markNode(char) {
  const kind = MARKS[char]
  return {
    type: 'text',
    value: char,
    data: {
      hName: 'span',
      hProperties: { className: ['mark', `mark-${kind}`], role: 'img', ariaLabel: MARK_LABELS[kind] },
      hChildren: [{ type: 'text', value: char }],
    },
  }
}

function splitMarks(textNode, all) {
  const out = []
  let marked = false
  for (const part of textNode.value.split(MARK_CHARS).filter((p) => p !== '')) {
    if (MARKS[part] && (all || !marked)) {
      out.push(markNode(part))
      marked = true
    } else out.push({ type: 'text', value: part })
  }
  return out
}

function convertMarks(node) {
  const first = node.children?.[0]
  if (first?.type !== 'text') return
  if (node.type === 'tableCell' && MARKS[first.value.trim()[0]]) {
    node.children.splice(0, 1, ...splitMarks(first, false))
  } else if (node.type === 'paragraph' && first.value.startsWith('✓ yes')) {
    node.children.splice(0, 1, ...splitMarks(first, true))
  }
}

function visit(node) {
  if (node.type === 'blockquote') convertWarning(node)
  if (node.type === 'tableCell' || node.type === 'paragraph') convertMarks(node)
  if ((node.type === 'link' || node.type === 'definition') && typeof node.url === 'string') {
    node.url = rewrite(node.url)
  }
  node.children?.forEach(visit)
}

export default function remarkDocs() {
  return (tree) => {
    const first = tree.children.findIndex((node) => node.type !== 'yaml' && node.type !== 'html')
    if (first !== -1 && tree.children[first].type === 'heading' && tree.children[first].depth === 1) {
      tree.children.splice(first, 1)
    }
    visit(tree)
  }
}
