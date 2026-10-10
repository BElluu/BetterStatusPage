# Configuration as code

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

The monitors, notification channels and status page layout of an installation can be exported as one YAML or JSON document. It does not depend on the numeric ids of the installation, so it reads the same anywhere, diffs well in version control, and can be reviewed like any other configuration file.

---

## Exporting

An administrator, or an [API token](api.md) with the **Admin** role, can download the document:

```bash
curl -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export" > bsp.yaml
curl -H "Authorization: Bearer $BSP_TOKEN" "$BSP_URL/api/v1/admin/config/export?format=json" > bsp.json
```

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
| `version` | The format version, currently `1`. |
| `channels` | Every notification channel: its settings, its alert policy (quiet hours, rate cap, grouping) and whether it is enabled. |
| `monitors` | Every monitor: its schedule and thresholds, its configuration and tags, the **keys** of the channels it alerts through (`notifications`) and of the monitors it depends on (`dependsOn`). |
| `layout` | The status page tree. `monitor` and `chart` nodes name their monitor with `monitorKey` instead of a numeric id. |

Monitors and channels are identified by their [key](api.md#monitors-and-notification-channels-have-keys), which stays the same when the name changes.

### What is left out

Runtime state does not belong in a configuration: the current status, the last check, the certificate expiry that was read, and the heartbeat token of a webhook monitor are not exported. Branding, languages, maintenance windows, subscribers, users, vaults and settings are not part of the file.

---

## Secrets

The fields that hold a secret are never exported with their value. Wherever a monitor or channel has one (a password, an OAuth2 client secret, a credential header, a Slack, Discord or Teams webhook URL, a Telegram bot token) it is written as `••••••••`, exactly as the [API masks it](api.md#secrets-are-masked). A Telegram bot token keeps its last four characters visible.

The export contains nothing that `GET /monitors` and `GET /notifications/channels` do not already return. Only the known secret fields are masked, so the following are written as they are stored: credentials typed into a URL (`https://user:password@host`), a query string, a request body or a database query; header values whose name does not look like a credential; the URL of a generic webhook channel; and the Docker endpoint. Check the file before you share it, and keep such credentials in the authentication fields, in headers or in a vault.

A secret that is read from a [vault](vault.md) is not a secret of the file but a reference, and is written with the names of the vault and of the secret:

```yaml
vault: { vault: Production, secret: db-login, fieldMapping: { user: u, password: p } }
```

### Names that cannot be exported

Vault names are not unique. If a monitor or channel refers to a vault whose name another vault also has, the export is refused with `409`, because the file could not say which one is meant. Rename one of the vaults.

A layout node or a vault reference that points at something that no longer exists is written as a placeholder, for example `(deleted monitor 12)` or `(deleted vault 3)`, so the broken reference is visible in the file instead of being dropped.

---

## YAML in every tool

The YAML is written to be read the same by parsers of YAML 1.1 and 1.2. Strings that one of them would take for something else are quoted: `"22:00"` (a number in YAML 1.1), `"yes"`, `"on"`, dates, `"0o17"` (a number in YAML 1.2) and a header named `<<` (the merge key of YAML 1.1). Long lines are not folded.
