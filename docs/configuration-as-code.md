# Configuration as code

Monitors and notification channels can be written as YAML documents, and created or updated from them. A document does not depend on the numeric ids of an installation, so it reads the same anywhere, diffs well in version control, and can be reviewed like any other configuration file. A pipeline that applies the documents on every merge keeps the installation in step with the repository.

Every document says what it describes in its `kind`: `Monitor` or `NotificationChannel`. Several documents can share one file, separated by `---`.

| Where | What it does |
|---|---|
| **YAML** button on a monitor or a notification channel | Shows that one object as a document, to copy or download. Read only. |
| **Import YAML** button on the Monitors and Notifications pages | Takes pasted or uploaded documents, shows what they would change, and creates or updates the objects when you apply them. |
| [The API](api.md) | `GET /config/export` writes the documents, `POST /config/validate` and `POST /config/apply` read them, for scripts and pipelines. |

**Who may use it.** The Operator role (and administrators), the same as for editing monitors and notification channels in the panel. An [API token](api.md#permissions) needs the permission of each kind in the file: `monitors`, `channels` or `actions`, read to export and write to import, and `vault:use` besides to add a vault reference or change a monitor, channel or action that has one. [Actions](actions.md) are for administrators only: an operator's export leaves them out (and the `actions` list of each monitor), and an operator cannot import an `Action` document or a monitor that carries an `actions` list. A token that predates actions keeps working for a full export, which then holds no actions.

---

## In the admin panel

### The YAML of an object

Open a monitor (its page, or **Edit**) or a notification channel (**Edit**) and click **YAML**. The dialog shows the saved object as a document, with **Copy** and **Download**. It is only a view: to change the object, change it in the panel, or edit a copy of the document and import it.

The view shows what is saved, not what you have typed into an open form.

### Importing

Click **Import YAML** on **Monitors** or **Notifications**, then paste one or more documents into the box, or **Choose file** (YAML, up to 2 MB). The text is checked a moment after you stop typing, and nothing is written yet: the page lists what applying it would create and update, and for an update which settings differ, never their values. Text with mistakes shows its problems with their place instead, and cannot be applied.

**Apply changes** carries it out, completely or not at all. Nothing is ever deleted by an import. Open the YAML of an existing object, change it, and paste it back to edit; paste a new document with a new `key` to add one.

---

## What a document contains

The export writes every setting in full and in block style; this example is shortened. The documents can be in one file, as here, or in separate ones.

```yaml
kind: NotificationChannel
key: ops-slack
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
---
kind: Monitor
key: public-site
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
autoIncident:
  afterMinutes: 10
  mode: draft
  template: Payments
```

| `kind` | Contents |
|---|---|
| `NotificationChannel` | One channel: its settings, its alert policy (quiet hours, rate cap, grouping) and whether it is enabled. |
| `Action` | One [action](actions.md): its HTTP request (the vault secret it reads is named, see [Secrets](#secrets)), whether it is enabled, and the **keys** of the notification channels told when a run fails (`failureNotifications`). |
| `Monitor` | One monitor: its schedule and thresholds, its configuration and tags, the **keys** of the channels it alerts through (`notifications`) and of the monitors it depends on (`dependsOn`), the [actions](actions.md) it runs (`actions`), and optionally its [automatic incident](#automatic-incidents). |

```yaml
kind: Action
key: start-vm2
name: Start VM2
config:
  url: https://jenkins.example.com/job/start-vm2/build
  method: POST
  headers:
    Authorization: Basic {{secret_jenkins_basic}}
  secrets:
    - { name: jenkins, vault: { vault: Production, secret: jenkins-login } }
failureNotifications: [ops-slack]
---
kind: Monitor
key: vm1-sql
name: VM1 SQL
type: sqlserver
config: { host: vm1.internal, port: 1433, database: app, user: sa, vault: { vault: Production, secret: sql-login }, query: SELECT 1, mode: fields }
actions:
  - { action: start-vm2, onStatus: down, delayMinutes: 5, cooldownMinutes: 60 }
```

The `actions` list of a monitor is optional. **A monitor document without it leaves the links of the monitor as they are**, so a file written before actions existed does not remove them; `actions: []` removes them all. A link needs the `action` key, `onStatus` (`down` or `up`) and optionally `delayMinutes` and `cooldownMinutes` (0 to 10080, 0 by default); an action can be linked once per status. Runs that wait for a link the file removed are cancelled.

Monitors, channels and actions are identified by their [key](api.md#monitors-and-notification-channels-have-keys), a technical name that is generated when the object is created, is not shown in the forms, and never changes.

### Automatic incidents

The optional `autoIncident` block of a `Monitor` switches on [automatic incidents](incidents-and-maintenance.md#automatic-incidents):

| Setting | Meaning |
|---|---|
| `afterMinutes` | Required. How long the confirmed outage must last, `1`–`10080`. |
| `mode` | `draft` (default) or `published`. |
| `template` | The **name** of an [incident template](incidents-and-maintenance.md#incident-templates). Leave it out to use the default template. |
| `enabled` | Optional. `false` turns the feature off, whatever else the block says. |

A monitor without an `autoIncident` block, or with `enabled: false`, has automatic incidents **off**. Because a file describes the whole monitor, importing a monitor without the block also switches the feature off if it was on. The export writes the block only for monitors that have it on, and leaves out `template` for the default one.

Templates are not documents: create them in the admin console or through the API first. An unknown template name is refused. A token needs the `incidents:write` permission to import `mode: published` or a `template`.

### What is left out

Runtime state does not belong in a configuration: the current status, the last check, and the certificate expiry that was read are not exported. The status page layout, incidents, maintenance windows, branding, languages, subscribers and subscription settings, SMTP settings, users, single sign-on, status page access, API tokens and vaults are not documents.

---

## Secrets

The fields that hold a secret are never exported with their value. Wherever a monitor, channel or action has one (a password, an OAuth2 client secret, a credential header, a Slack, Discord or Teams webhook URL, a Telegram bot token) it is written as `••••••••`, exactly as the [API masks it](api.md#secrets-are-masked). A Telegram bot token of 16 characters or more keeps its last four characters visible. The credential headers of an [action](actions.md) are masked the same way, and the vault secret an action reads is written by name.

The export contains nothing that `GET /monitors` and `GET /notifications/channels` do not already return. Only the known secret fields are masked, so the following are written as they are stored: credentials typed into a URL (`https://user:password@host`), a query string, a request body or a database query; header values whose name does not look like a credential; the URL of a generic webhook channel; and the Docker endpoint. Check a document before you share it, and keep such credentials in the authentication fields, in headers or in a vault.

A secret that is read from a [vault](vault.md) is not a secret of the document but a reference, and is written with the names of the vault and of the secret:

```yaml
vault: { vault: Production, secret: db-login, fieldMapping: { user: u, password: p } }
```

### Heartbeat token

> [!WARNING]
> **Not released yet.** The `heartbeatToken` field is not in a published release; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

The URL a sender calls on a `webhook` monitor contains its token. A monitor that is created again (deleted and imported, or a new installation from the same file) gets a new random token, and every cron job or CI step that called the old URL stops reporting. To keep the URL, put the token in the document:

```yaml
kind: Monitor
key: nightly-job
name: Nightly job
type: webhook
heartbeatToken: 3f9c1d7a2b6e4f08a5d1c9e7b2a64f303f9c1d7a2b6e4f08   # 48 lowercase hex characters
config: {}
```

The token is 48 lowercase hexadecimal characters, the same form as a generated one; `openssl rand -hex 24` makes one. The current token of a monitor is the last part of its heartbeat URL, shown on the monitor's page in the admin console. The token is a secret, so the export writes `••••••••` and never the value. A document without `heartbeatToken`, or with the mask, keeps the stored token of an existing monitor and gives a new monitor a random one. A new value replaces the token, which changes the URL. The token must not belong to another monitor at the time of the import (to swap two tokens, free one first in a separate import), and only a `webhook` monitor can have one. Because the file then holds a working credential, keep it out of git or inject it before posting, like the other secrets.

### Names that cannot be exported

Vault names are not unique. If a monitor or channel refers to a vault whose name another vault also has, the export is refused with `409`, because the document could not say which one is meant. Rename one of the vaults. A document that names a vault or a secret also stops working when that vault or secret is renamed, so rename them together with the document.

A vault reference that points at something that no longer exists is written as a placeholder, for example `(deleted vault 3)` or `(deleted secret 9)`, so the broken reference is visible instead of being dropped. Such a document is refused on import until the placeholder is replaced or removed.

---

## Exporting with the API

```bash
# Everything: a YAML stream, one document per object, separated by ---.
curl -fsS -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export" > bsp.yaml
# One object, by kind and key.
curl -fsS -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export?kind=Monitor&key=public-site"
```

`-fsS` makes `curl` fail on an error status instead of saving the error message as the file.

The export is always YAML. The output is the same every time for the same data: documents come channels first, then monitors, each sorted by key, so two exports differ only where the configuration differs. A token needs the read permission of every kind the export holds, or of the one kind it is asked for.

---

## Importing with the API

The same documents can be applied to an installation: from a pipeline after a pull request is merged, or to bring a second installation in line with the first. Send one or more documents as YAML, separated by `---` (`Content-Type: application/yaml`). Only YAML is read for an import; a request with another content type, JSON included, is refused with `415`:

```bash
# What would change? Nothing is written.
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @bsp.yaml "$BSP_URL/api/v1/admin/config/validate"

# Apply it.
curl -fsS -X POST -H "Authorization: Bearer $BSP_TOKEN" -H "Content-Type: application/yaml" \
  --data-binary @bsp.yaml "$BSP_URL/api/v1/admin/config/apply"
```

Both answer with what was, or would be, done, channels first, then monitors. Every document is listed, unchanged ones included. A settings change lists the names of the settings that differ, never their values:

```json
{
  "dryRun": false,
  "summary": { "create": 1, "update": 1, "unchanged": 0 },
  "changes": [
    { "kind": "NotificationChannel", "key": "pager", "action": "create" },
    { "kind": "Monitor", "key": "public-site", "action": "update", "fields": ["intervalSecs", "dependsOn"] }
  ]
}
```

### How documents are applied

- **By key.** A monitor, channel or action whose key exists is updated; a key that does not exist is created. A key cannot be changed, so a different key is a different object. To rename something, change its `name`, not its key.
- **Nothing is deleted.** An import only creates and updates. What the documents do not mention stays as it is, and removing a monitor, channel or action is done in the panel or with the API's `DELETE`. This keeps a file that describes only a few objects, or an empty one, from touching the rest.
- **A document is the whole truth for the object it describes.** A setting that is left out takes its default (a monitor without `intervalSecs` checks every 60 seconds), it does not keep its current value. The notification channels and dependencies of a monitor are replaced by the lists in the document, and so are the failure channels of an action (the actions of a monitor only when the document has an `actions` list). A document needs its `kind`; a monitor or channel also needs `key`, `name` and `type`, an action `key`, `name` and `config`.
- **All or nothing.** All documents are checked before anything is written, and the changes are made in one transaction. Applying the same documents again changes nothing.
- **Heartbeat tokens stay.** A webhook monitor keeps its token, so the URL it is called on does not change; a new one gets a token, unless the document sets one (see [Heartbeat token](#heartbeat-token)).
- **Changes are audited.** Each change appears in the audit log under the object it changed, and an import that changes something also gets one entry (**Import**) with the counts. An entry lists the names of the settings that changed, not their old and new values, so a secret never ends up in the log.
- **Not documents:** see [What is left out](#what-is-left-out). A document can refer to a vault by name, but the vault has to exist, and a token needs `vault:use` to add such a reference, or to change the configuration of a monitor or channel that has one. Without it a token can still change the name, schedule, tags and links of such a monitor.

### Secrets in a document

| In the document | Result |
|---|---|
| `••••••••` for an existing monitor or channel | The stored secret is kept. This is what the export writes, so exporting a document and importing it again changes nothing. |
| A new value | The secret is replaced. |
| The field is left out | The secret is cleared. |
| `••••••••` for an object that does not exist yet, or one whose `type` the document changes | Refused: there is nothing to keep. Write the value. |
| A kept secret, but a different URL, OAuth2 token URL, CAS server or database host or port of a monitor, or a different URL of a webhook channel | Refused. A saved secret is never sent somewhere new; enter it again. |

A file in version control should not contain the values, so put placeholders in it and fill them in from the environment of the pipeline before sending it:

```yaml
# bsp.template.yaml
kind: Monitor
key: billing-db
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

### From a pipeline

Keep the documents in a repository, check them in every pull request and apply them when the pull request is merged. Create a token with the **Deploy monitoring** preset (`monitors:write` and `channels:write`) and store it as the secret `BSP_TOKEN`, with the address of the installation as `BSP_URL`. This example is for GitHub Actions, in `.github/workflows/bsp.yml`; any other CI works the same way, as it only needs `curl`:

```yaml
name: Status page
on:
  pull_request:
    paths: ["status/**.yaml"]
  push:
    branches: [main]
    paths: ["status/**.yaml"]

jobs:
  status-page:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # In a pull request: show what would change. A document that is not valid fails the job.
      - name: Check
        if: github.event_name == 'pull_request'
        run: |
          for f in status/*.yaml; do echo "---"; cat "$f"; echo; done | curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.BSP_TOKEN }}" -H "Content-Type: application/yaml" \
            --data-binary @- "${{ secrets.BSP_URL }}/api/v1/admin/config/validate"
      # After the merge: apply it.
      - name: Apply
        if: github.event_name == 'push'
        run: |
          for f in status/*.yaml; do echo "---"; cat "$f"; echo; done | curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.BSP_TOKEN }}" -H "Content-Type: application/yaml" \
            --data-binary @- "${{ secrets.BSP_URL }}/api/v1/admin/config/apply"
```

The loop puts `---` before every file, so the documents stay apart whatever they end with. Remember that:

- A monitor or channel whose file is deleted from the repository is **not** deleted from the installation (see [How documents are applied](#how-documents-are-applied)).
- A change made in the panel is overwritten by the next apply of a document with the same key. Make changes in the repository, or export the object again first.
- Do not put secret values in the repository; use [placeholders](#secrets-in-a-document) filled in from the secrets of the pipeline, or a vault.

### Documents that are not valid

Nothing is changed, the answer is `400`, and `problems` lists what is wrong, each with its place (at most 100). The place names the document by its kind and key, for example `Monitor[public-site].dependsOn` or `NotificationChannel[ops-slack].alertPolicy.throttle`, or by its position (`document 3`) when it has neither. Documents are checked in two steps: first their own shape (settings, keys, values), and only when that is right, what the documents refer to (channels, monitors, vaults, secrets, dependency cycles). A mistake in the shape is therefore reported before the references are looked at, and a second list can follow once the first is fixed.

```json
{
  "error": "Monitor[public-site].dependsOn: unknown monitor \"ghost\"",
  "problems": [
    { "path": "Monitor[public-site].dependsOn", "message": "unknown monitor \"ghost\"" },
    { "path": "Monitor[old-api].notifications", "message": "unknown channel \"pager\"" }
  ]
}
```

A document is refused when:

- it has no `kind`, or one other than `Monitor` or `NotificationChannel`;
- it has a setting the format does not know (a typo is not ignored, also inside an `alertPolicy`);
- a key is not valid or is used twice for the same kind;
- a value is outside the limits the [API](api.md#validation) has (where the API clamps a threshold or an alert policy value into range, a document has to be in range itself);
- it refers to a channel, monitor, vault or secret that does not exist, uses `vaultId` or `secretId` instead of names, or contains a placeholder such as `(deleted vault 3)`;
- a monitor depends on itself, or the dependencies form a cycle;
- a configuration is nested more than 20 levels deep, or a name is `__proto__`;
- a masked secret has nothing to keep (see above).

Text that cannot be read at all (a YAML syntax error, a `%YAML` directive, an alias that contains itself, more than 2000 documents, or nothing in it) is refused with `400` and only an `error` message. YAML is read as YAML 1.2, and at most 20 alias references (`*name`) are accepted. A request body is limited to 2 MB.

Who is asking and their role are checked before the body is read, and so is whether a token has any write permission for a document at all; the permission for each kind is checked once the body is parsed. Whoever can import can create a monitor that uses any secret of any vault, by name, so a token gets that only with the separate `vault:use` permission, and a user with the Operator role has it as they do in the panel; see [Handling tokens](api.md#handling-tokens) and [the vault](vault.md#who-can-use-the-vault).

---

## YAML in every tool

The YAML is written to be read the same by parsers of YAML 1.1 and 1.2. Strings that one of them would take for something else are quoted: `"22:00"` (a number in YAML 1.1), `"yes"`, `"on"`, dates, `"0o17"` (a number in YAML 1.2) and a header named `<<` (the merge key of YAML 1.1). Long lines are not folded.
