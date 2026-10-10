# API

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

The admin panel is a client of the same REST API you can call from scripts, CI/CD pipelines and infrastructure tooling. Everything under `/api/v1/admin` accepts an **API token** in place of a signed-in session.

---

## API tokens

Create tokens in **Administration → API tokens** (administrators only).

| Field | Meaning |
|---|---|
| **Name** | A label to recognise the token by, for example `GitHub Actions`. |
| **Role** | What the token may do. **Operator** covers monitors, incidents, maintenance, notification channels, subscribers and reports. **Branding** covers the layout, branding and languages. **Admin** adds the audit log and system health. |
| **Expires** | Never, or after 30 days, 90 days or 1 year. |

The full token is shown **once**, when you create it. Only a hash is stored, so a lost token cannot be recovered: revoke it and create a new one. The list shows the first characters of each token, who created it, when it expires and when it was last used.

Revoking a token (the bin icon) takes effect immediately.

### What a token cannot do

A token is meant for automation, so it never reaches account or credential management, even with the Admin role:

- users, passwords and two-factor authentication,
- single sign-on settings,
- who may view a private status page (status page access),
- vault settings and secret values (a token can still list vault and secret names, which is what the monitor form needs to pick one),
- backups,
- creating, listing or revoking API tokens,
- the sign-in endpoints under `/api/v1/auth`.

These endpoints answer `403` to a token and need a signed-in administrator.

A token also stops working, with `401`, when the administrator who created it is deleted or is no longer an Admin, and changing that user's role away from Admin deletes their tokens for good: promoting them again does not bring them back. Each token is limited to 300 requests per minute; beyond that the API answers `429` with a `Retry-After` header.

A [backup](backup-restore.md) contains the tokens as they were when it was taken. After restoring one, review **Administration → API tokens** and revoke any token that should no longer exist.

Everything a token does is recorded in the audit log (**Administration → Audit Log**) as `<creator email> (token: <token name>)`.

---

## Calling the API

Send the token in the `Authorization` header. No CSRF token or cookie is needed.

```bash
export BSP_URL=https://status.example.com
export BSP_TOKEN=bsp_...

curl -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/monitors"
```

Errors come back as JSON: `{ "error": "..." }` with a `400`, `401`, `403`, `404`, `409` or `429` status.

### Monitors and notification channels have keys

Every monitor and notification channel has a unique **key** (lowercase letters, digits, `-` and `_`) next to its numeric `id`. The key is generated from the name when you do not send one, and you can change it later. The `id` is specific to one installation, the key is what you refer to from your own tooling.

```bash
curl -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/monitors" \
  -d '{"name": "Public site", "key": "public-site", "type": "https", "config": {"url": "https://example.com"}}'
```

A key that is already taken answers `409`.

### Open an incident from CI/CD

An incident has a `status` of `investigating`, `identified`, `monitoring` or `resolved`, and an `impact` of `minor`, `major` or `critical`. Subscribers are notified unless you send `"notifySubscribers": false`.

```bash
# Open an incident
curl -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/incidents" \
  -d '{"title": "Deploy in progress", "status": "investigating", "impact": "minor", "monitorIds": [1]}'

# Post an update, here resolving it (use the id from the previous response)
curl -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/incidents/5/updates" \
  -d '{"body": "Deploy finished.", "status": "resolved"}'
```
