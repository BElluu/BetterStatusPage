import { DEFAULT_EXPIRY_WARN_DAYS, MAIL_DEFAULT_PORTS, MAX_EXPIRY_WARN_DAYS } from '@bsp/shared'
import type { MailProtocol, MailSecurity } from '@bsp/shared'
import { Field, Note } from '@better-kit/ui'

interface ConfigProps {
  config: Record<string, unknown>
  updateConfig: (key: string, value: unknown) => void
}

const numberOr = (value: string, fallback: number) => (value === '' ? fallback : Number(value))

/** Certificate checking for an encrypted connection: on unless switched off, with an optional private authority. */
function TlsVerifyFields({ config, updateConfig }: ConfigProps) {
  const verify = config['verifyTls'] !== false
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
        <input type="checkbox" checked={verify} onChange={(e) => updateConfig('verifyTls', e.target.checked ? undefined : false)} />
        Verify the server certificate and host name
      </label>
      {verify ? (
        <Field label="CA certificate (PEM, optional)">
          <textarea value={(config['tlsCa'] as string) ?? ''} onChange={(e) => updateConfig('tlsCa', e.target.value || undefined)} rows={3} className="input-sig text-xs font-mono" placeholder="Only for a certificate signed by your own authority" />
        </Field>
      ) : (
        <p className="text-xs" style={{ color: 'var(--m3-secondary)' }}>
          Any certificate is accepted, so a self-signed, expired or mismatched one passes. Use it only for servers you trust.
        </p>
      )}
    </div>
  )
}

function HostPortFields({ config, updateConfig, hostPlaceholder }: ConfigProps & { hostPlaceholder: string }) {
  return (
    <div className="grid grid-cols-[1fr_7rem] gap-3">
      <Field label="Host">
        <input value={(config['host'] as string) ?? ''} onChange={(e) => updateConfig('host', e.target.value)} required className="input-sig" placeholder={hostPlaceholder} />
      </Field>
      <Field label="Port">
        <input type="number" min={1} max={65535} value={(config['port'] as number) ?? ''} onChange={(e) => updateConfig('port', numberOr(e.target.value, 0))} required className="input-sig" />
      </Field>
    </div>
  )
}

export function RedisFields({ config, updateConfig }: ConfigProps) {
  const tls = config['tls'] === true
  return (
    <>
      <HostPortFields config={config} updateConfig={updateConfig} hostPlaceholder="cache.example.com" />
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: 'var(--m3-on-surface-variant)' }}>
        <input type="checkbox" checked={tls} onChange={(e) => updateConfig('tls', e.target.checked)} />
        Connect over TLS
      </label>
      {tls && <TlsVerifyFields config={config} updateConfig={updateConfig} />}
      <Note tone="info">Sends PING and expects PONG. Add a password, or a user name and password for ACLs, in the Credentials tab.</Note>
    </>
  )
}

const MAIL_PROTOCOL_OPTIONS: { value: MailProtocol; label: string }[] = [
  { value: 'smtp', label: 'SMTP' },
  { value: 'imap', label: 'IMAP' },
  { value: 'pop3', label: 'POP3' },
]

const MAIL_SECURITY_OPTIONS: { value: MailSecurity; label: string }[] = [
  { value: 'tls', label: 'TLS from the start (SMTPS, IMAPS, POP3S)' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: 'None (unencrypted)' },
]

export function MailFields({ config, updateConfig }: ConfigProps) {
  const protocol = (config['protocol'] as MailProtocol | undefined) ?? 'smtp'
  const security = (config['security'] as MailSecurity | undefined) ?? 'starttls'

  /** The port follows protocol and encryption while it still holds the default of the previous choice. */
  function change(next: { protocol?: MailProtocol; security?: MailSecurity }) {
    const nextProtocol = next.protocol ?? protocol
    const nextSecurity = next.security ?? security
    if (config['port'] === MAIL_DEFAULT_PORTS[protocol][security]) updateConfig('port', MAIL_DEFAULT_PORTS[nextProtocol][nextSecurity])
    if (next.protocol) updateConfig('protocol', next.protocol)
    if (next.security) updateConfig('security', next.security)
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Protocol">
          <select value={protocol} onChange={(e) => change({ protocol: e.target.value as MailProtocol })} className="input-sig">
            {MAIL_PROTOCOL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Encryption">
          <select value={security} onChange={(e) => change({ security: e.target.value as MailSecurity })} className="input-sig">
            {MAIL_SECURITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <HostPortFields config={config} updateConfig={updateConfig} hostPlaceholder="mail.example.com" />
      {security !== 'none' && <TlsVerifyFields config={config} updateConfig={updateConfig} />}
      {security === 'none' && (!!config['password'] || !!config['vault']) && (
        <Note tone="warning">The account is sent unencrypted. Choose TLS or STARTTLS unless the server is on a network you fully trust.</Note>
      )}
      <Note tone="info">Reads the server greeting. Add an account in the Credentials tab to also prove that signing in works; no mail is sent or read.</Note>
    </>
  )
}

export function SshFields({ config, updateConfig }: ConfigProps) {
  return (
    <>
      <HostPortFields config={config} updateConfig={updateConfig} hostPlaceholder="server.example.com" />
      <Field label="Expected identification text (optional)">
        <input value={(config['expectedBanner'] as string) ?? ''} onChange={(e) => updateConfig('expectedBanner', e.target.value || undefined)} className="input-sig" placeholder="OpenSSH" />
      </Field>
      <Note tone="info">Reads the identification string the server sends (for example SSH-2.0-OpenSSH_9.6). No login is attempted, so no keys or passwords are needed.</Note>
    </>
  )
}

/** An empty box is allowed while typing; leaving it empty puts the default back. */
function WarnDaysField({ config, updateConfig, label }: ConfigProps & { label: string }) {
  const warnDays = config['warnDays'] as number | undefined
  return (
    <Field label={label}>
      <input type="number" min={1} max={MAX_EXPIRY_WARN_DAYS} value={warnDays ?? ''} className="input-sig"
        onChange={(e) => updateConfig('warnDays', e.target.value === '' ? undefined : Math.min(MAX_EXPIRY_WARN_DAYS, Number(e.target.value)))}
        onBlur={() => { if (warnDays === undefined) updateConfig('warnDays', DEFAULT_EXPIRY_WARN_DAYS) }} />
    </Field>
  )
}

export function TlsCertFields({ config, updateConfig }: ConfigProps) {
  return (
    <>
      <HostPortFields config={config} updateConfig={updateConfig} hostPlaceholder="example.com" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Host name for SNI (optional)">
          <input value={(config['servername'] as string) ?? ''} onChange={(e) => updateConfig('servername', e.target.value || undefined)} className="input-sig" placeholder="same as host" />
        </Field>
        <WarnDaysField config={config} updateConfig={updateConfig} label="Degraded within (days)" />
      </div>
      <TlsVerifyFields config={config} updateConfig={updateConfig} />
      <Note tone="info">Works for any service that speaks TLS from the first byte (HTTPS, IMAPS, LDAPS and others). Degraded inside the warning window, Down once the certificate has expired or is not trusted.</Note>
    </>
  )
}

export function DomainFields({ config, updateConfig }: ConfigProps) {
  return (
    <>
      <div className="grid grid-cols-[1fr_11rem] gap-3">
        <Field label="Domain">
          <input value={(config['domain'] as string) ?? ''} onChange={(e) => updateConfig('domain', e.target.value)} required className="input-sig" placeholder="example.com" />
        </Field>
        <WarnDaysField config={config} updateConfig={updateConfig} label="Degraded within (days)" />
      </div>
      <Note tone="info">Use the registered domain, not a subdomain. The end date comes from RDAP, or WHOIS where the registry has no RDAP, and is looked up at most every six hours.</Note>
    </>
  )
}
