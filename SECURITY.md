# Security Policy

BetterStatusPage is a self-hosted application. Operators are responsible for their deployment environment, domain, TLS termination, backups, and secret storage.

## Reporting vulnerabilities

If you find a security issue, do not open a public issue with exploit details, secrets, logs, or private URLs.

Use [GitHub private vulnerability reporting](https://github.com/BElluu/BetterStatusPage/security/advisories/new) instead. Reports submitted there are visible only to the reporter and repository maintainers while the issue is investigated and fixed.

Repository maintainers must keep **Private vulnerability reporting** enabled in the repository security settings. If the private reporting form is unavailable, do not publish vulnerability details in an issue. Open an issue containing only a request for a private contact channel.

Include:

- affected version or commit,
- impacted component,
- reproduction steps without real secrets,
- expected impact,
- suggested fix if available.

Do not include:

- real `JWT_SECRET`,
- real `VAULT_ENCRYPTION_KEY`,
- backup archives,
- production database files,
- private monitor URLs,
- user/customer data.

## Supported versions

Until the first public stable release, security fixes target the current `main` branch and the latest tagged prerelease.

## Deployment security checklist

Before exposing an instance publicly:

- Set `NODE_ENV=production`.
- Set a random non-default `JWT_SECRET` with at least 32 characters.
- Set `VAULT_ENCRYPTION_KEY` to a random 64-character hex string.
- Store `VAULT_ENCRYPTION_KEY` outside the application and outside backup archives.
- Put the app behind HTTPS using Nginx or another trusted reverse proxy.
- Do not expose the application port directly to the internet.
- Set `TRUST_PROXY=1` only when the app is reachable exclusively through the trusted proxy.
- Keep Docker, Node.js, and host packages patched.
- Run `npm audit` or equivalent dependency scanning before release.
- Keep Dependabot alerts enabled and review production dependency updates promptly.
- Create and verify backups regularly.
- Test restore on a non-production copy before relying on backups.

## Secret handling

`VAULT_ENCRYPTION_KEY` is not stored in backups. This is intentional. If the key is lost or changed, encrypted vault entries cannot be decrypted.

Never commit `.env`, database files, uploads, or backup archives.

## Backup handling

Backup archives can contain sensitive data:

- SQLite database,
- setup state,
- uploaded branding assets,
- encrypted vault records,
- audit data,
- monitor configuration.

Treat backup archives as confidential. Store them in a restricted location and test restore procedures before production use.

## Reverse proxy trust

`TRUST_PROXY` changes how client IPs are derived from forwarding headers. Enable it only when the app port is private and all public traffic goes through your trusted proxy. If the app is directly reachable by clients, forwarding headers can be spoofed.
