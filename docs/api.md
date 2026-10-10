# API

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

The admin panel is a client of the same REST API you can call from scripts, CI/CD pipelines and infrastructure tooling. Everything under `/api/v1/admin` accepts an **API token** in place of a signed-in session.

---

## API tokens

Create tokens in **Administration → API tokens** (administrators only). Click **New token**, enter a **Name**, pick the **Role** and when it **Expires**, click **Create**, and copy the token.

| Field | Meaning |
|---|---|
| **Name** | A label to recognise the token by, for example `GitHub Actions` (up to 80 characters). |
| **Role** | What the token may do. **Operator** covers monitors, incidents, maintenance, notification channels, subscribers, reports, and also the layout, branding and languages. **Branding** covers only the layout, branding and languages. **Admin** adds the audit log, system health and the [configuration export and import](configuration-as-code.md). |
| **Expires** | **Never expires**, or after 30 days, 90 days or 1 year. |

The full token is shown **once**, when you create it. Only a hash is stored, so a lost token cannot be recovered: revoke it and create a new one. The list shows the first characters of each token, who created it, when it expires and when it was last used.

To revoke a token click the bin icon and confirm with **Revoke**. It stops working immediately, and so does any live event stream opened with it.

### What a token cannot do

A token is meant for automation, so it never reaches account or credential management, even with the Admin role:

- users, passwords and two-factor authentication,
- single sign-on settings,
- who may view a private status page (status page access),
- vault settings and secret values (a token can still list vault and secret names, which is what the monitor form needs to pick one),
- backups,
- creating, listing or revoking API tokens,
- the sign-in endpoints under `/api/v1/auth`,
- viewing a [private status page](private-status-page.md).

These endpoints answer `403` to a token and need a signed-in administrator.

A token also stops working, with `401`, when the administrator who created it is deleted or is no longer an Admin, and changing that user's role away from Admin deletes their tokens for good: promoting them again does not bring them back. Each token is limited to 300 requests per minute; beyond that the API answers `429` with a `Retry-After` header.

A [backup](backup-restore.md) contains the tokens as they were when it was taken. After restoring one, review **Administration → API tokens** and revoke any token that should no longer exist.

Every change a token makes is recorded in the audit log (**Administration → Audit Log**) as `<creator email> (token: <token name>)`. Reading is not recorded.

### Handling tokens

- Keep a token in the secret store of your pipeline, never in the repository or in a log.
- Give it the lowest **Role** that does the job and an expiry. A pipeline that only opens incidents needs **Operator**, not **Admin**.
- Send it over HTTPS only. A token sent to an `http://` address crosses the network in clear.
- A token is not tied to an address or to a pipeline: whoever has the text can use it.
- If a token may have leaked, revoke it at once in **Administration → API tokens**, then filter the **Audit Log** for `(token: <name>)` to see what it did.
- An Operator or Admin token, like an operator in the panel, can point a monitor, a test or the SMTP settings at any [vault](vault.md#who-can-use-the-vault) secret and at any address, and whoever can apply a [configuration file](configuration-as-code.md) can do it by name. A token never reads a vault value, but a vault secret can be sent where the token's holder chooses. Treat these tokens like the people they stand for.

---

## Calling the API

Send the token in the `Authorization` header. No CSRF token or cookie is needed.

```bash
export BSP_URL=https://status.example.com
export BSP_TOKEN=bsp_...

curl -fsS -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/monitors"
```

`-fsS` makes `curl` fail on an error status instead of printing the error as if it were the answer.

### Errors

Errors come back as JSON, `{ "error": "..." }`:

| Status | Meaning |
|---|---|
| `400` | The request is not valid; `error` says what. For a [configuration file](configuration-as-code.md#a-file-that-is-not-valid) the answer also lists every `problems` entry with its place in the file. |
| `401` | The token is missing, unknown, expired or revoked, or its creator is no longer an administrator. |
| `403` | The token's role is too low, or the endpoint does not accept API tokens (`API tokens cannot call this endpoint`). |
| `404` | There is no such object. |
| `409` | The key is already used by another object, or an export cannot name a vault because another vault has the same name. |
| `413` | The body is too large; a configuration file may be up to 2 MB. Behind nginx, see `client_max_body_size` in [Deployment](deployment.md). |
| `415` | The `Content-Type` is not supported: send `application/json`, or `application/yaml` for a configuration file. |
| `422` | A notification channel could not deliver its test message. |
| `429` | The token sent more than 300 requests in a minute; wait for `Retry-After` seconds. |
| `500` | The server failed. Nothing is half-applied: a configuration file is applied completely or not at all. |

### Reference

The operations meant for automation are described in an OpenAPI 3.1 file: [openapi.yaml](https://docs.betterstatuspage.dev/openapi.yaml). It covers monitors, incidents, maintenance windows, notification channels, the status page layout and the [configuration export and import](configuration-as-code.md), with the request bodies, limits and the role each operation needs. Load it into any OpenAPI tool to browse the API or to generate a client.

### Secrets are masked

A password, client secret, credential header, Slack, Discord or Teams webhook URL or Telegram bot token in a monitor's or channel's `config` is never returned: it reads back as `••••••••`. Send that value back unchanged to keep the stored secret, or send a new one to replace it. A masked value that does not match the stored secret, or one that looks like a half-edited mask, is refused with `400`, so a placeholder can never be saved as a password. Secrets must be text.

A kept secret has to stay where it is sent. If a request keeps a stored secret and also changes the monitor's `url`, the OAuth2 `tokenUrl`, the CAS server, a database `host` or `port`, or a webhook channel's `url`, it is refused until you enter the secret again. This also applies to a monitor test that names a saved monitor. Changing the `type` of a monitor or channel needs a new `config` in the same request.

Secrets read from a [vault](vault.md) are references and are returned as they are. Credentials written into a URL (`https://user:password@host`), a query string or a request body are not recognised as secrets and are returned as stored; use the authentication fields, headers or a vault instead.

### Validation

A monitor needs a `name` (up to 200 characters) and a known `type`. `config`, when sent, must be an object, and `tags` a list of up to 20 `{ "label", "color" }` objects. `intervalSecs` is 10 to 86400, `timeoutMs` 1000 to 300000 and `retries` 1 to 10; values outside these ranges are refused with `400`, while `failureThreshold` and `recoveryThreshold` are clamped to 1 to 20.

A maintenance window needs a `name` (up to 200 characters), a `startsAt` and an `endsAt` (milliseconds since the epoch, the end after the start), and every id in `monitorIds` must be an existing monitor. The status page layout (`PUT /layout`) needs a `tree` object.

### Monitors and notification channels have keys

Every monitor and notification channel has a unique **Key** next to its numeric `id`: 1 to 64 lowercase letters, digits, `-` and `_`, starting with a letter or digit. It is generated from the name when you do not send one (`Public site` becomes `public-site`, a second one `public-site-2`), and you can change it later. The `id` is specific to one installation, the key is what you refer to from your own tooling.

```bash
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/monitors" \
  -d '{"name": "Public site", "key": "public-site", "type": "https", "config": {"url": "https://example.com"}}'
```

A key that is already taken answers `409`, and one that is not valid `400`.

### Open an incident from CI/CD

An incident has a `status` of `investigating`, `identified`, `monitoring` or `resolved`, and an `impact` of `minor`, `major` or `critical`. Subscribers are notified unless you send `"notifySubscribers": false`.

```bash
# Open an incident
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/incidents" \
  -d '{"title": "Deploy in progress", "status": "investigating", "impact": "minor", "monitorIds": [1]}'

# Post an update, here resolving it (use the id from the previous response)
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/json" \
  "$BSP_URL/api/v1/admin/incidents/5/updates" \
  -d '{"body": "Deploy finished.", "status": "resolved"}'
```
