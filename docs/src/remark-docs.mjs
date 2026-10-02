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

function visit(node) {
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
