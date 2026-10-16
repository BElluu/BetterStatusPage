import { ApiTokensPage } from '@better-kit/ui'
import { TOKEN_PRESETS, TOKEN_RESOURCES } from '@bsp/shared'

/** The tokens page with the permissions of this product's API. */
export default function ApiTokens() {
  return <ApiTokensPage resources={TOKEN_RESOURCES} presets={TOKEN_PRESETS} />
}
