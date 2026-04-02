import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Branding } from '@bsp/shared'

export default function BrandingPage() {
  const qc = useQueryClient()
  const { data: branding } = useQuery<Branding>({
    queryKey: ['branding'],
    queryFn: () => api.get('/admin/branding'),
  })

  const [siteName, setSiteName] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#6366f1')
  const [accentColor, setAccentColor] = useState('#f59e0b')
  const [customCss, setCustomCss] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (branding) {
      setSiteName(branding.siteName)
      setPrimaryColor(branding.primaryColor)
      setAccentColor(branding.accentColor)
      setCustomCss(branding.customCss ?? '')
    }
  }, [branding])

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.patch('/admin/branding', { siteName, primaryColor, accentColor, customCss: customCss || null })
      if (logoFile) {
        const fd = new FormData()
        fd.append('file', logoFile)
        await api.upload('/admin/branding/logo', fd)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branding'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500'

  return (
    <div className="p-8 space-y-6 max-w-2xl">
      <div>
        <h2 className="text-xl font-semibold text-white">Branding</h2>
        <p className="text-slate-400 text-sm mt-1">Customize the public status page appearance</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Site Name</label>
          <input value={siteName} onChange={(e) => setSiteName(e.target.value)} className={inputCls} placeholder="My Status Page" />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Logo</label>
          {branding?.logoUrl && (
            <div className="mb-2">
              <img src={branding.logoUrl} alt="Current logo" className="h-10 object-contain bg-slate-800 rounded px-2 py-1" />
            </div>
          )}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
            className="block text-sm text-slate-400 file:mr-3 file:bg-slate-700 file:text-slate-200 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Primary Color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-10 h-10 rounded border border-slate-700 bg-slate-800 cursor-pointer" />
              <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className={`${inputCls} flex-1`} />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Accent Color</label>
            <div className="flex items-center gap-2">
              <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="w-10 h-10 rounded border border-slate-700 bg-slate-800 cursor-pointer" />
              <input value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className={`${inputCls} flex-1`} />
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <label className="block text-sm text-slate-400 mb-2">Preview</label>
          <div className="rounded-lg p-4 border border-slate-700" style={{ background: '#0f172a' }}>
            <div className="flex items-center gap-3 mb-3">
              {branding?.logoUrl && <img src={branding.logoUrl} alt="" className="h-6 object-contain" />}
              <span className="font-semibold text-white" style={{ color: primaryColor }}>{siteName || 'Status Page'}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ background: primaryColor }}>Operational</span>
              <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ background: accentColor }}>Investigating</span>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1.5">Custom CSS (optional)</label>
          <textarea
            value={customCss}
            onChange={(e) => setCustomCss(e.target.value)}
            rows={6}
            className={`${inputCls} font-mono text-xs resize-none`}
            placeholder="/* Additional CSS injected into the public page */"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Branding'}
          </button>
          {saved && <span className="text-sm text-emerald-400">Saved!</span>}
        </div>
      </div>
    </div>
  )
}
