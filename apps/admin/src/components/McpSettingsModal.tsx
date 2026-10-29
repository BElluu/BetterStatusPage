import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, ConfirmIdentityModal, CopyButton, ErrorState, LoadingState, ModalFooter, ModalHeader, ModalShell, Note, Switch, useToast } from '@better-kit/ui'
import { api } from '../api/client'

interface McpSettings {
  enabled: boolean
  allowChanges: boolean
  /** PUBLIC_URL, when the server has one. */
  publicUrl: string | null
}

type Change = Partial<Pick<McpSettings, 'enabled' | 'allowChanges'>>

const QUERY_KEY = ['mcp-settings']
const PANEL = { background: 'var(--m3-surface-container-low)', border: '1px solid var(--m3-outline-variant)', color: 'var(--m3-on-surface)' }
const CODE = { background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }

/**
 * A dialog on the API tokens page. Administrators decide here whether AI agents may use the MCP endpoint, and whether they may change data. Turning
 * something on is confirmed like creating a token; turning something off is immediate.
 */
export function McpSettingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState<{ change: Change; title: string; message: string } | null>(null)

  const { data, isError, refetch } = useQuery<McpSettings>({ queryKey: QUERY_KEY, queryFn: () => api.get('/admin/mcp') })

  const save = useMutation({
    mutationFn: (body: Change & { currentPassword?: string | undefined }) => api.put<McpSettings>('/admin/mcp', body),
    onSuccess: (next) => qc.setQueryData(QUERY_KEY, next),
  })

  async function turnOff(change: Change) {
    try {
      await save.mutateAsync(change)
      toast.success(change.enabled === false ? 'MCP is off. Agents can no longer connect.' : 'Agents can no longer make changes.')
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Could not save the setting.')
    }
  }

  const endpoint = `${data?.publicUrl ?? window.location.origin}/mcp`
  const command = `claude mcp add --transport http bsp "${endpoint}" --header "Authorization: Bearer <token>"`

  return (
    <>
    <ModalShell align="top" onClose={confirming ? undefined : onClose} label="MCP for AI agents">
    <div className="rounded-2xl w-full max-w-2xl my-8" style={PANEL}>
      <ModalHeader icon="smart_toy" title="MCP for AI agents" onClose={onClose} />
      {!data ? (
        <div className="p-6">
          {isError ? <ErrorState message="Could not load the MCP settings." onRetry={() => void refetch()} /> : <LoadingState label="Loading MCP settings…" />}
        </div>
      ) : (
      <div className="p-6 space-y-4">
      <div>
        <p className="text-sm" style={{ color: 'var(--m3-on-surface-variant)' }}>
          Lets an agent such as Claude Code look into this instance and, if you allow it, act on it. It signs in with an API token from this page,
          so it can do only what that token may. See the{' '}
          <a href="https://docs.betterstatuspage.dev/mcp/" target="_blank" rel="noreferrer" className="underline">MCP guide</a>.
        </p>
      </div>

      <Switch
        checked={data.enabled}
        onChange={(on) => on
          ? setConfirming({ change: { enabled: true }, title: 'Turn on MCP', message: 'Agents with an API token will be able to connect to this instance. Confirm it is you to turn it on.' })
          : void turnOff({ enabled: false })}
        label="Allow AI agents to connect"
        description="Off by default. While it is off, the MCP address does not exist."
      />

      {data.enabled && (
        <>
          <Switch
            checked={data.allowChanges}
            onChange={(on) => on
              ? setConfirming({ change: { allowChanges: true }, title: 'Allow agents to make changes', message: 'Agents will be able to open and publish incidents, schedule maintenance and create or change monitors, as far as their token allows. Confirm it is you.' })
              : void turnOff({ allowChanges: false })}
            label="Allow agents to make changes"
            description="Off: agents can only read, whatever their token may do. Everything they change is recorded in the audit log under the token's name."
          />

          {!data.allowChanges && <Note tone="info">Agents are read-only. Turn on changes to let them act, and give their token a write permission.</Note>}
          {data.allowChanges && <Alert tone="warning">Agents can change data. Give a token write permission only to an agent you trust, and keep its approval prompts on.</Alert>}

          <div className="space-y-2">
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>Address</p>
            <div className="flex items-center gap-3 rounded-lg px-3 py-2" style={CODE}>
              <code className="font-mono text-xs break-all flex-1">{endpoint}</code>
              <CopyButton value={endpoint} label="Copy address" />
            </div>
            <p className="text-xs pt-1" style={{ color: 'var(--m3-secondary)' }}>Connect Claude Code (create a token first, with New token)</p>
            <div className="flex items-center gap-3 rounded-lg px-3 py-2" style={CODE}>
              <code className="font-mono text-xs break-all flex-1">{command}</code>
              <CopyButton value={command} label="Copy command" />
            </div>
          </div>
        </>
      )}

      </div>
      )}
      <ModalFooter>
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
      </ModalFooter>
    </div>
    </ModalShell>

    {confirming && (
      <ConfirmIdentityModal
        title={confirming.title}
        message={confirming.message}
        confirmLabel="Turn on"
        pendingLabel="Saving…"
        action={async (currentPassword) => {
          await save.mutateAsync({ ...confirming.change, currentPassword })
          toast.success(confirming.change.enabled ? 'MCP is on.' : 'Agents may now make changes.')
        }}
        onClose={() => setConfirming(null)}
      />
    )}
    </>
  )
}
