import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IncidentImpact, IncidentTemplate, IncidentTemplateTranslation } from '@bsp/shared'
import { api } from '../../api/client'
import { Modal, ModalFooter } from '@better-forge/ui'
import { Alert, Field, LoadingState, useToast } from '@better-forge/ui'

type Draft = Pick<IncidentTemplate, 'name' | 'title' | 'body' | 'resolvedBody' | 'impact' | 'translations'>
type Locale = { code: string; name: string; isDefault: number }

const EMPTY: Draft = {
  name: '',
  title: '{{monitor}} is unavailable',
  body: 'We detected that {{monitor}} has been unavailable for {{duration}}. We are investigating.',
  resolvedBody: '{{monitor}} is available again. The outage lasted {{duration}}.',
  impact: 'major',
  translations: {},
}

export const TEMPLATES_KEY = ['incident-templates']

/** Lists the templates and edits one at a time. The default one can be edited but not deleted. */
export function IncidentTemplatesModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  // null = list, 'new' = creating, otherwise the template being edited
  const [editing, setEditing] = useState<IncidentTemplate | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [error, setError] = useState('')

  const { data: templates = [], isPending } = useQuery<IncidentTemplate[]>({
    queryKey: TEMPLATES_KEY,
    queryFn: () => api.get('/admin/incident-templates'),
  })

  // The template's own text is the default language; every other installed language can word it again.
  const { data: locales = [] } = useQuery<Locale[]>({
    queryKey: ['locales'],
    queryFn: () => api.get('/admin/locales'),
  })
  const otherLocales = locales.filter((l) => !l.isDefault)
  const defaultLocale = locales.find((l) => l.isDefault)

  const save = useMutation({
    mutationFn: () => editing === 'new' || editing === null
      ? api.post('/admin/incident-templates', draft)
      : api.patch(`/admin/incident-templates/${editing.id}`, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEMPLATES_KEY })
      setEditing(null)
      toast.success('Template saved')
    },
    onError: (err) => setError(err instanceof Error && err.message ? err.message : 'Failed to save the template.'),
  })

  const remove = useMutation({
    mutationFn: (template: IncidentTemplate) => api.delete(`/admin/incident-templates/${template.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TEMPLATES_KEY })
      qc.invalidateQueries({ queryKey: ['monitors'] })
      toast.success('Template deleted')
    },
    onError: (err) => toast.error(`Couldn't delete template: ${(err as Error).message}`),
  })

  function startEdit(template: IncidentTemplate | 'new') {
    setError('')
    setDraft(template === 'new' ? EMPTY : {
      name: template.name, title: template.title, body: template.body, resolvedBody: template.resolvedBody, impact: template.impact,
      translations: template.translations,
    })
    setEditing(template)
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const setTranslation = (code: string, field: keyof IncidentTemplateTranslation, value: string) =>
    setDraft((d) => ({ ...d, translations: { ...d.translations, [code]: { ...d.translations[code], [field]: value } } }))

  if (editing !== null) {
    return (
      <Modal title={editing === 'new' ? 'New template' : `Edit ${editing.name}`} icon="article" onClose={() => setEditing(null)} flush>
        <form onSubmit={(e) => { e.preventDefault(); setError(''); save.mutate() }}>
          <div className="p-6 space-y-4">
            <Field label="Name" required>
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} required className="input-sig" />
            </Field>
            <Field label="Incident title" required>
              <input value={draft.title} onChange={(e) => set('title', e.target.value)} required className="input-sig" />
            </Field>
            <Field label="Opening message" required>
              <textarea value={draft.body} onChange={(e) => set('body', e.target.value)} required rows={3} className="input-sig" />
            </Field>
            <Field label="Resolved message" required>
              <textarea value={draft.resolvedBody} onChange={(e) => set('resolvedBody', e.target.value)} required rows={2} className="input-sig" />
            </Field>
            <Field label="Impact">
              <select value={draft.impact} onChange={(e) => set('impact', e.target.value as IncidentImpact)} className="input-sig">
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
            {otherLocales.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
                  The text above is in {defaultLocale?.name ?? 'the default language'}. Add the wording for the other languages of the status page;
                  a visitor who switches language sees it, and a field left empty shows the text above.
                </p>
                {otherLocales.map((l) => (
                  <details key={l.code} className="rounded-xl p-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
                    <summary className="cursor-pointer text-sm font-medium" style={{ color: 'var(--m3-on-surface)' }}>{l.name}</summary>
                    <div className="space-y-3 mt-3">
                      <Field label="Incident title">
                        <input value={draft.translations[l.code]?.title ?? ''} onChange={(e) => setTranslation(l.code, 'title', e.target.value)} className="input-sig" />
                      </Field>
                      <Field label="Opening message">
                        <textarea value={draft.translations[l.code]?.body ?? ''} onChange={(e) => setTranslation(l.code, 'body', e.target.value)} rows={3} className="input-sig" />
                      </Field>
                      <Field label="Resolved message">
                        <textarea value={draft.translations[l.code]?.resolvedBody ?? ''} onChange={(e) => setTranslation(l.code, 'resolvedBody', e.target.value)} rows={2} className="input-sig" />
                      </Field>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
              Placeholders: <code>{'{{monitor}}'}</code> monitor name, <code>{'{{duration}}'}</code> how long it was down,{' '}
              <code>{'{{error}}'}</code> last error (opening message only).
            </p>
            {error && <Alert tone="error">{error}</Alert>}
          </div>
          <ModalFooter>
            <button type="button" onClick={() => setEditing(null)} className="btn btn-secondary">Back</button>
            <button type="submit" disabled={save.isPending} className="btn btn-primary">{save.isPending ? 'Saving…' : 'Save'}</button>
          </ModalFooter>
        </form>
      </Modal>
    )
  }

  return (
    <Modal title="Incident templates" icon="article" onClose={onClose} flush>
      <div className="p-6 space-y-3">
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          Templates fill in automatic incidents. Choose one per monitor; monitors without a choice use the default template.
        </p>
        {isPending ? <LoadingState label="Loading templates…" /> : (
          <ul className="space-y-2">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-xl p-3" style={{ background: 'var(--m3-surface-container)', border: '1px solid var(--m3-outline-variant)' }}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium" style={{ color: 'var(--m3-on-surface)' }}>
                    {t.name}{t.isDefault && <span className="ml-2 text-xs" style={{ color: 'var(--m3-secondary)' }}>default</span>}
                  </span>
                  <span className="block font-mono text-xs truncate" style={{ color: 'var(--m3-secondary)' }}>{t.title}</span>
                </span>
                <button type="button" onClick={() => startEdit(t)} className="btn-icon" title="Edit" aria-label={`Edit ${t.name}`}>
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>edit</span>
                </button>
                {!t.isDefault && (
                  <button type="button" onClick={() => remove.mutate(t)} className="btn-icon" title="Delete" aria-label={`Delete ${t.name}`} style={{ color: 'var(--m3-down)' }}>
                    <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>delete</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ModalFooter>
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        <button type="button" onClick={() => startEdit('new')} className="btn btn-primary">
          <span className="material-symbols-outlined" aria-hidden="true">add_circle</span>
          New template
        </button>
      </ModalFooter>
    </Modal>
  )
}
