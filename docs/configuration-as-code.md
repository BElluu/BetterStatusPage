# Configuration as code

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

The monitors, notification channels and status page layout of an installation can be exported as one YAML or JSON document, and applied to an installation again. It does not depend on the numeric ids of the installation, so it reads the same anywhere, diffs well in version control, and can be reviewed like any other configuration file. A pipeline that applies it on every merge keeps the installation in step with the repository.

Both export and import are for administrators: an administrator signed in to the panel, or an [API token](api.md) with the **Admin** role.

---

## In the admin panel

Administrators find both under **Administration → Configuration**.

- Under **Export**, pick YAML or JSON and click **Download**.
- Under **Import**, **Choose file** takes a YAML or JSON file (up to 2 MB). The file is checked as soon as you choose it, and nothing is written yet: the page lists what applying it would create, update and remove, and for an update which settings differ, never their values. A file with mistakes shows its problems with their place in the file instead, and cannot be applied.
- **Apply changes** carries out what the preview showed, completely or not at all. If it would remove monitors or channels, you are asked to confirm first (**Apply and remove**).
- **Remove what the file leaves out** is the `prune` option below, and **Allow a section that is empty** is `allowEmpty`. The preview is updated when you switch them.

---

## Exporting

```bash
curl -fsS -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export" > bsp.yaml
curl -fsS -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export?format=json" > bsp.json
```

`-fsS` makes `curl` fail on an error status instead of saving the error message as the file.

YAML is the default. The output is the same every time for the same data: monitors and channels are sorted by key, so two exports differ only where the configuration differs.

---

## What the file contains

The export writes every setting in full and in block style; this example is shortened.

```yaml
version: 1
channels:
  - key: ops-slack
    name: Ops Slack
    type: slack
    enabled: true
    notifyOnRecovery: true
    config:
      webhookUrl: ••••••••
      text: "Down: {{monitor_name}}"
    alertPolicy:
      quietHours:
        enabled: false
        start: "22:00"
        end: "07:00"
        timezone: UTC
        mode: defer
      throttle: { enabled: false, maxAlerts: 3, windowMinutes: 60 }
      grouping: { enabled: false, minMonitors: 3, windowSeconds: 60 }
monitors:
  - key: public-site
    name: Public site
    type: https
    intervalSecs: 30
    timeoutMs: 10000
    retries: 1
    failureThreshold: 1
    recoveryThreshold: 1
    config:
      url: https://example.com
      method: GET
      expectedStatus: 200
      auth:
        type: basic
        basic: { username: svc, password: •••••••• }
    tags:
      - { label: prod, color: "#00ff00" }
    notifications: [ops-slack]
    dependsOn: [billing-db]
layout:
  id: root
  type: page
  children:
    - id: m1
      type: monitor
      monitorKey: public-site
      showUptimeBar: true
```

| Section | Contents |
|---|---|
| `version` | The format version, currently `1`. Always required. |
| `channels` | Every notification channel: its settings, its alert policy (quiet hours, rate cap, grouping) and whether it is enabled. |
| `monitors` | Every monitor: its schedule and thresholds, its configuration and tags, the **keys** of the channels it alerts through (`notifications`) and of the monitors it depends on (`dependsOn`). |
| `layout` | The status page tree. `monitor` and `chart` nodes name their monitor with `monitorKey` instead of a numeric id. |

Monitors and channels are identified by their [key](api.md#monitors-and-notification-channels-have-keys), which stays the same when the name changes.

### What is left out

Runtime state does not belong in a configuration: the current status, the last check, the certificate expiry that was read, and the heartbeat token of a webhook monitor are not exported. Incidents, maintenance windows, branding, languages, subscribers and subscription settings, SMTP settings, users, single sign-on, status page access, API tokens and vaults are not part of the file.

---

## Secrets

The fields that hold a secret are never exported with their value. Wherever a monitor or channel has one (a password, an OAuth2 client secret, a credential header, a Slack, Discord or Teams webhook URL, a Telegram bot token) it is written as `••••••••`, exactly as the [API masks it](api.md#secrets-are-masked). A Telegram bot token of 16 characters or more keeps its last four characters visible.

The export contains nothing that `GET /monitors` and `GET /notifications/channels` do not already return. Only the known secret fields are masked, so the following are written as they are stored: credentials typed into a URL (`https://user:password@host`), a query string, a request body or a database query; header values whose name does not look like a credential; the URL of a generic webhook channel; and the Docker endpoint. Check the file before you share it, and keep such credentials in the authentication fields, in headers or in a vault.

A secret that is read from a [vault](vault.md) is not a secret of the file but a reference, and is written with the names of the vault and of the secret:

```yaml
vault: { vault: Production, secret: db-login, fieldMapping: { user: u, password: p } }
```

### Names that cannot be exported

Vault names are not unique. If a monitor or channel refers to a vault whose name another vault also has, the export is refused with `409`, because the file could not say which one is meant. Rename one of the vaults. A file that names a vault or a secret also stops working when that vault or secret is renamed, so rename them together with the file.

A layout node or a vault reference that points at something that no longer exists is written as a placeholder, for example `(deleted monitor 12)` or `(deleted vault 3)`, so the broken reference is visible in the file instead of being dropped. Such a file is refused on import until the placeholder is replaced or removed.

---

## Importing

The same document can be applied to an installation: from a pipeline after a pull request is merged, or to bring a second installation in line with the first. Send it as JSON or as YAML (`Content-Type: application/yaml`):

```bash
# What would change? Nothing is written.
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @bsp.yaml "$BSP_URL/api/v1/admin/config/validate"

# Apply it.
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @bsp.yaml "$BSP_URL/api/v1/admin/config/apply"

# Apply it, and remove the monitors and channels the file leaves out.
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @bsp.yaml "$BSP_URL/api/v1/admin/config/apply?prune=true"
```

Both answer with what was, or would be, done, channels first, then monitors, then the layout, then removals. Every entry is listed, unchanged ones included. A settings change lists the names of the settings that differ, never their values:

```json
{
  "dryRun": false,
  "prune": false,
  "summary": { "create": 1, "update": 1, "unchanged": 1, "delete": 0 },
  "changes": [
    { "kind": "channel", "key": "pager", "action": "create" },
    { "kind": "monitor", "key": "public-site", "action": "update", "fields": ["intervalSecs", "dependsOn"] },
    { "kind": "layout", "action": "unchanged" }
  ]
}
```

### How a file is applied

- **By key.** A monitor or channel whose key exists is updated; a key that does not exist is created. Changing a key in the file is therefore a new object, and the old one stays until you prune. To rename something, change its `name`, not its key.
- **The file is the whole truth for what it describes.** A setting that is left out takes its default (a monitor without `intervalSecs` checks every 60 seconds), it does not keep its current value. The notification channels and dependencies of a monitor are replaced by the lists in the file. Only `version` is required at the top; an entry needs a `key`, a `name` and a `type`.
- **Sections you leave out are left alone.** A file with only `version` and `layout` changes only the layout. With `prune=true`, monitors and channels are removed only when the file has a `monitors` or a `channels` section, and only those missing from it. Removing a monitor removes its history and its links to channels, incidents and maintenance windows. A `layout` in the same file that still shows a monitor the import removes is refused. If the file has no `layout`, the nodes of the removed monitors are taken out of the stored one, so that the page does not keep showing them, and the answer lists that as a change to the layout.
- **A section that is empty is not an instruction to empty the installation.** `monitors: []` or `channels: []` together with `prune=true` is refused, because it would remove every monitor or channel (an export of an installation without channels contains `channels: []`). Add `allowEmpty=true` if that is what you want.
- **All or nothing.** The whole file is checked before anything is written, and the changes are made in one transaction. Applying the same file again changes nothing.
- **Heartbeat tokens stay.** A webhook monitor keeps its token, so the URL it is called on does not change; a new one gets a token.
- **Changes are audited.** Each change appears in the audit log under the object it changed, and a file that changes something also gets one entry for the import itself. An entry lists the names of the settings that changed, not their old and new values, so a secret never ends up in the log.
- **Not part of the file:** see [What is left out](#what-is-left-out). A file can refer to a vault by name, but the vault has to exist.

### Secrets in a file

| In the file | Result |
|---|---|
| `••••••••` for an existing monitor or channel | The stored secret is kept. This is what the export writes, so exporting a file and importing it again changes nothing. |
| A new value | The secret is replaced. |
| The field is left out | The secret is cleared. |
| `••••••••` for an object that does not exist yet, or one whose `type` the file changes | Refused: there is nothing to keep. Write the value. |
| A kept secret, but a different URL, OAuth2 token URL, CAS server or database host or port of a monitor, or a different URL of a webhook channel | Refused. A saved secret is never sent somewhere new; enter it again. |

A file in version control should not contain the values, so put placeholders in it and fill them in from the environment of the pipeline before sending it:

```yaml
# bsp.template.yaml
version: 1
monitors:
  - key: billing-db
    name: Billing DB
    type: postgresql
    config:
      host: db.internal
      port: 5432
      database: billing
      user: app
      password: "${BILLING_DB_PASSWORD}"
      query: select 1
```

```bash
envsubst '${BILLING_DB_PASSWORD}' < bsp.template.yaml | curl -fsS -X POST \
  -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @- "$BSP_URL/api/v1/admin/config/apply"
```

`envsubst` comes with GNU gettext. Name the variables it may replace, as above: without the list it replaces every `$NAME` in the file, and an unset one becomes empty, which would silently change a `$` in a database query or a request body. A value that contains `"` or `\` would break the double-quoted YAML string (or be read as an escape), so keep such secrets in a vault instead.

A secret that is read from a vault does not need this: write `vault: { vault: Production, secret: db-login }`. Both names must match exactly one vault and one of its secrets.

### A file that is not valid

Nothing is changed, the answer is `400`, and `problems` lists what is wrong with the file, each with its place in it (at most 100). A file is checked in two steps: first its own shape (settings, keys, values), and only when that is right, the layout and what the file refers to (channels, monitors, vaults, secrets, dependency cycles). A mistake in the shape is therefore reported before the references are looked at, and a second list can follow once the first is fixed.

```json
{
  "error": "monitors[public-site].dependsOn: unknown monitor \"ghost\"",
  "problems": [
    { "path": "monitors[public-site].dependsOn", "message": "unknown monitor \"ghost\"" },
    { "path": "layout.children[2].monitorKey", "message": "unknown monitor \"old-api\"" }
  ]
}
```

A file is refused when:

- its `version` is not `1`, or it has a setting the format does not know (a typo is not ignored, also inside an `alertPolicy`);
- a key is not valid or is used twice;
- a value is outside the limits the [API](api.md#validation) has (where the API clamps a threshold or an alert policy value into range, a file has to be in range itself);
- it refers to a channel, monitor, vault or secret that does not exist, uses `vaultId` or `secretId` instead of names, or contains a placeholder such as `(deleted monitor 12)`;
- a monitor depends on itself, or the dependencies form a cycle;
- the layout does not start with a `page`, has a `page` anywhere else, a node of an unknown type or with a repeated `id`, children on a node that cannot have any, `monitorId` instead of `monitorKey`, more than 2000 nodes or more than 12 levels;
- a configuration is nested more than 20 levels deep, or a name is `__proto__`;
- a masked secret has nothing to keep (see above).

A file that cannot be read at all (a YAML syntax error, a `%YAML` directive, an alias that contains itself, a `prune` or `allowEmpty` that is not `true` or `false`) is refused with `400` and only an `error` message. A YAML file is read as YAML 1.2, and at most 20 alias references (`*name`) are accepted.

Importing is for administrators and is checked before the file is read. Whoever can apply a file can create a monitor that uses any secret of any vault, by name, so treat an Admin API token like the administrator it stands for; see [Handling tokens](api.md#handling-tokens).

---

## YAML in every tool

The YAML is written to be read the same by parsers of YAML 1.1 and 1.2. Strings that one of them would take for something else are quoted: `"22:00"` (a number in YAML 1.1), `"yes"`, `"on"`, dates, `"0o17"` (a number in YAML 1.2) and a header named `<<` (the merge key of YAML 1.1). Long lines are not folded.
