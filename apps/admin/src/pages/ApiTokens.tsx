import { useState } from 'react'
import { ApiTokensPage } from '@better-kit/ui'
import { TOKEN_PRESETS, TOKEN_RESOURCES } from '@bsp/shared'
import { McpSettingsModal } from '../components/McpSettingsModal'

/** The tokens page with the permissions of this product's API, and a button for the switches of the agents that sign in with them. */
export default function ApiTokens() {
  const [showMcp, setShowMcp] = useState(false)
  return (
    <>
      <ApiTokensPage
        resources={TOKEN_RESOURCES}
        presets={TOKEN_PRESETS}
        actions={
          <button type="button" onClick={() => setShowMcp(true)} className="btn btn-secondary">
            <span className="material-symbols-outlined" aria-hidden="true">smart_toy</span>
            MCP
          </button>
        }
      />
      {showMcp && <McpSettingsModal onClose={() => setShowMcp(false)} />}
    </>
  )
}
