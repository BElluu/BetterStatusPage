/**
 * Lets the guides in docs/ stay plain GitHub-readable Markdown:
 * - drops the leading `# Title` (the layout renders the title itself),
 * - turns links to sibling guides (`deployment.md#nginx`) into site routes (`/deployment/#nginx`),
 * - points links that leave docs/ (`../README.md`) at the file on GitHub.
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

function visit(node) {
  if (node.type === 'blockquote') convertWarning(node)
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
