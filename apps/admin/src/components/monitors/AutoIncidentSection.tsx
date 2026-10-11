import { useEffect, useState } from 'react'
import type { AutoIncidentMode, IncidentTemplate } from '@bsp/shared'
import { api } from '../../api/client'
import { Field, Note } from './monitorFormParts'

export interface AutoIncidentValues {
  autoIncidentMinutes: number | null
  autoIncidentMode: AutoIncidentMode
  autoIncidentTemplateId: number | null
}

interface Props {
  values: AutoIncidentValues
  onChange: (patch: Partial<AutoIncidentValues>) => void
}

const DEFAULT_MINUTES = 5

/** Side panel: opens an incident by itself when the monitor stays down; closed by itself after recovery. */
export function AutoIncidentSection({ values, onChange }: Props) {
  const [templates, setTemplates] = useState<IncidentTemplate[]>([])
  const { autoIncidentMinutes, autoIncidentMode, autoIncidentTemplateId } = values
  const enabled = autoIncidentMinutes !== null

  useEffect(() => {
    api.get<IncidentTemplate[]>('/admin/incident-templates').then(setTemplates).catch(() => {})
  }, [])

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--m3-on-surface)' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ autoIncidentMinutes: e.target.checked ? DEFAULT_MINUTES : null })}
        />
        Open an incident when this monitor stays down
      </label>
      {enabled && (
        <div className="space-y-3">
          <Field label="Down for (minutes)">
            <input
              type="number" min={1} max={10080} className="input-sig"
              value={autoIncidentMinutes}
              onChange={(e) => onChange({ autoIncidentMinutes: Math.min(10080, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </Field>
          <Field label="Create as">
            <select className="input-sig" value={autoIncidentMode} onChange={(e) => onChange({ autoIncidentMode: e.target.value as AutoIncidentMode })}>
              <option value="draft">Draft</option>
              <option value="published">Published right away</option>
            </select>
          </Field>
          <Field label="Template">
            <select
              className="input-sig"
              value={autoIncidentTemplateId ?? ''}
              onChange={(e) => onChange({ autoIncidentTemplateId: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">Default template</option>
              {templates.filter((t) => !t.isDefault).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <Note tone="info">
        The incident opens once the confirmed outage has lasted this long and is resolved automatically after recovery.
        A draft is visible only in the admin console until you publish it. A monitor that is not on the status page is always a draft.
      </Note>
    </div>
  )
}
