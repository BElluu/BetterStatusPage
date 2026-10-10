# Vault

The vault keeps the passwords, tokens and connection strings your monitors and email delivery need, encrypted in the BetterStatusPage database. A monitor or the SMTP settings then point at a secret instead of holding the credential themselves.

Open it from **Vault** in the admin sidebar (administrators only).

## How secrets are stored

Every secret value is encrypted with **AES-256-GCM** before it is written to the database. Each value gets its own random 12-byte IV, and the authentication tag is checked on every decrypt, so a value that was changed in the database fails to decrypt instead of returning garbage. Secret names and types are stored in plain text; only the values are encrypted.

The value is decrypted only at the moment it is used: when a check runs, when an email is sent, or when an administrator clicks **Reveal**. Secret values are not returned by the API that lists secrets.

### `VAULT_ENCRYPTION_KEY`

The encryption key comes from the `VAULT_ENCRYPTION_KEY` environment variable. It must be exactly **64 hexadecimal characters** (32 bytes). Generate one with:

```bash
openssl rand -hex 32
```

| Situation | What happens |
| --- | --- |
| Production, key missing, malformed or left at the `.env.example` value | The server refuses to start |
| Development, key missing | A fixed, insecure all-zero key is used and a warning is printed |
| Key changed or lost | Every stored secret becomes unreadable. Checks that use a secret fail, and **Reveal** answers *Failed to decrypt secret* |

There is no way to recover secrets without the original key, and no built-in way to re-encrypt them under a new key. Treat the key as part of your data.

The same key also encrypts the single sign-on client secret, two-factor authentication secrets and the custom headers of webhook subscriptions, so losing it affects those too.

### Backups and the key

Backups never contain `VAULT_ENCRYPTION_KEY`. Each backup records a fingerprint (SHA-256) of the key it was made with, and a restore refuses to run unless you pass the same key. Store the key somewhere outside the server, next to where your backups go. See [Backup and restore](backup-restore.md) and the [environment variables reference](deployment.md#environment-variables).

## Vaults and secrets

Secrets live in **vaults**. A vault is a named group with an optional description; create as many as you like, for example one per team or per environment. A vault is either **Local**, with the values stored encrypted in the BetterStatusPage database, or **HashiCorp Vault**, where BetterStatusPage reads the values from your own HashiCorp Vault (see [HashiCorp Vault](#hashicorp-vault)). The type is chosen when the vault is created and cannot be changed. (**Azure Key Vault**, **GCP Secret Manager** and **AWS Secrets Manager** are listed in the type picker as *Coming soon* and cannot be selected.)

### Create a vault

1. Open **Vault** and click **+** (**Create vault**) next to **Vaults**.
2. Enter a **Vault name** and, if you want, a **Description**.
3. Click **Create Vault**.

### Add a secret

1. Select the vault and click **New Secret**.
2. Enter a **Secret name**. Names must be unique within a vault.
3. Pick the **Type** and fill in the value.
4. Click **Save Secret**.

### Secret types

| Type | Label in the UI | Stored fields | Use it for |
| --- | --- | --- | --- |
| `userpass` | **User / Password** | `username`, `password` | Basic auth, CAS, database monitors, SMTP sign-in |
| `value` | **Secure Value** | `value` (one string) | An API token, a client secret, a full connection string |
| `json` | **JSON** | Any JSON object | Several related values in one secret, such as an OAuth2 client ID and secret |

A `json` secret must be valid JSON when saved. Only top-level keys can be used; every value is turned into a string when the secret is resolved.

### Reveal a secret

Click **Reveal** on a secret to see its value. For a **User / Password** secret the password stays hidden until you click **Show**. Each field has a copy button.

### Change or rotate a secret

The **Vault** page has no edit form: a secret's type and value cannot be changed there. To rotate a credential:

1. Add a new secret with the new value (under a new name, as names are unique per vault).
2. Point every monitor and the SMTP settings that used the old secret at the new one.
3. Delete the old secret.

The admin API also accepts `PATCH /api/v1/admin/vaults/{vaultId}/secrets/{secretId}` with a new `name`, or a new value in the field for its type (`userpass`, `value` or `json`). The value is re-encrypted and everything that references the secret picks it up on its next use. The type cannot be changed.

### Delete a secret or a vault

Click the delete icon on a secret and confirm. Click the delete icon on a vault to delete it **and all its secrets**; when the vault holds secrets you must tick a confirmation box first.

Deleting does not check what still uses the secret. A monitor or the SMTP settings that point at a deleted secret keep the reference, and every use fails with *Vault secret … not found*: the check reports the monitor **down** with that error, and email notifications fail to send. Re-point them before you delete.

## HashiCorp Vault

> [!WARNING]
> **Not released yet.** This feature is only in the `main` branch; build the image yourself from the `main` branch (see [Deployment](deployment.md)).

A **HashiCorp Vault** vault keeps no secret values in BetterStatusPage. It stores only how to connect to your Vault server, and each secret in it is a **reference** to a path in a KV version 2 secrets engine. The value is read from HashiCorp Vault every time it is used, so a rotation in Vault takes effect on the next check or email, and the monitor and SMTP forms work exactly as with a local vault.

### Connect to HashiCorp Vault

1. Open **Vault**, click **+** (**Create vault**) and choose **HashiCorp Vault**.
2. Fill in the **Connection**. **Address**, **Auth method** and the credentials are in the form; **Namespace**, **KV v2 mount**, **AppRole mount** and **CA certificate** are in the **Connection options** tab on the right edge of the dialog (its badge counts the options changed from their defaults):

| Field | Meaning |
| --- | --- |
| **Address** | The server, for example `https://vault.example.com:8200`. No path, user name or query. A plain `http://` address is accepted but sends the token unencrypted, so the form warns you. |
| **Namespace** | Optional. Sent as the `X-Vault-Namespace` header (Vault Enterprise and HCP Vault). |
| **KV v2 mount** | The mount of the KV version 2 engine. Default `secret`. |
| **Auth method** | **Token**, or **AppRole**. |
| **Token** | For **Token**: typed here, or **From Vault** (see [Credentials from a local vault](#credentials-from-a-local-vault)). |
| **Role ID**, **Secret ID**, **AppRole mount** | For **AppRole**: typed here, or **From Vault**. The mount defaults to `approle`. |
| **CA certificate** | Optional PEM, for a server certificate signed by a private CA. Include the full chain; it replaces the default trust store for this vault. There is no option to skip certificate verification. |

3. Click **Test connection** between **Cancel** and **Create Vault** to check the settings before saving; the same button is in **Connection settings**, where a blank credential uses the saved one. Then click **Create Vault**. You can run **Test connection** again later in the vault header. The test checks the token with `auth/token/lookup-self` (and shows how long it stays valid) or performs the AppRole login.

Prefer **AppRole**: BetterStatusPage logs in when needed and again when the token expires. A **Token** is sent as it is and is never renewed, so use a periodic or long-lived token.

The connection (including the token or Secret ID) is encrypted with `VAULT_ENCRYPTION_KEY` like every other secret, is never returned by the API (the settings form only shows whether a credential is set) and never reaches the audit log. Open **Connection settings** to change it; leave a credential blank to keep the saved one. When you change the address, namespace, KV mount, CA certificate, auth method or AppRole mount you must enter the credentials again, so a stored credential is never sent to a different server.

### Credentials from a local vault

Instead of typing the **Token**, or the **Role ID** and **Secret ID**, switch the field to **From Vault** and pick a secret from a **local** vault. This way the credentials are kept and rotated in one place, and the connection stores only the reference:

| Auth method | Secret type | Used as |
| --- | --- | --- |
| **Token** | **Secure Value** | The token |
| **Token** | **JSON** | The token, from the JSON key you enter under **Token** (default `token`) |
| **AppRole** | **User / Password** | The username is the Role ID, the password is the Secret ID |
| **AppRole** | **JSON** | The Role ID and Secret ID, from the JSON keys you enter (defaults `roleId` and `secretId`) |

Only local vaults are offered, so a HashiCorp vault never depends on another external vault. The secret is read every time it is needed, so changing it takes effect on the next request. If the secret is deleted, or no longer has the right type, every check and email that uses the HashiCorp vault fails with a clear error until you pick another secret in **Connection settings**. Like typed credentials, a chosen secret is dropped when you change the address, namespace, KV mount, CA certificate or auth method; pick it again then.

Give the token or role a policy that only reads what you reference, for example:

```hcl
path "secret/data/bsp/*" { capabilities = ["read"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
```

The second rule is only needed for **Test connection** with a token.

### Add a secret reference

BetterStatusPage only **reads** from HashiCorp Vault. It never creates, changes or deletes anything there, so create the secret in HashiCorp Vault first. In BetterStatusPage you only add a **reference** to it: select the vault, click **Add Reference** and enter a **Reference name** (the name monitors and SMTP settings show), the **Type** and the location in Vault:

| Type | Fields | Result |
| --- | --- | --- |
| **User / Password** | **Path** | The keys `username` and `password` at that path |
| **Secure Value** | **Path** and **Key** | The value of that key |
| **JSON** | **Path** | Every key at that path; use the [JSON field mapping](#how-each-type-is-mapped) to pick the ones you need |

The path is relative to the mount (`bsp/database` reads `secret/data/bsp/database` on the default mount) and always reads the latest version. BetterStatusPage reads the path once when you save, and refuses the reference if Vault denies access or the path or key does not exist. **Reveal** reads the value live and shows its source. Deleting a reference or the vault removes only the reference; nothing is deleted in HashiCorp Vault. A read-only policy is enough for the token or role (see above).

### When Vault is unavailable

Values are not cached. While HashiCorp Vault cannot be reached, denies access, or a referenced path is gone, every check and email that uses one of its secrets fails with an error naming the vault, for example `HashiCorp Vault "Corporate": cannot connect (ECONNREFUSED)`. Monitors that depend on it are reported **down**, and email notifications are not sent. Requests time out after 10 seconds, redirects are not followed and responses are limited to 1 MiB.

> Downgrading BetterStatusPage to a version without HashiCorp Vault support leaves these vaults in the list as local vaults whose secrets cannot be used. Nothing is lost; upgrading again restores them.

## Use a secret

Wherever a credential can come from the vault, the form has a **Direct input** / **From Vault** switch. Choose **From Vault**, then pick the **Vault** and the **Secret**. The secret list shows each secret's name and type. When a secret is selected, the vault value replaces anything entered under **Direct input**.

| Where | Fields filled from the secret |
| --- | --- |
| HTTPS monitor, **Auth** panel, **Basic** | Username, Password |
| HTTPS monitor, **Auth** panel, **OAuth2** | Client ID, Client Secret |
| HTTPS monitor, **Auth** panel, **CAS** | Username, Password |
| Database monitor, **Individual fields** | User, Password (under **Credentials**) |
| Database monitor, **Connection string** | The whole connection string (vault only, there is no direct input) |
| **Notifications → SMTP Settings** | SMTP user, SMTP password (under **Credentials**) |

Custom request headers on an HTTPS monitor and the other monitor fields cannot use the vault.

### How each type is mapped

**User / Password** maps automatically: `username` goes to the user or client ID field, `password` to the password or client secret.

**Secure Value** is used as the password, the client secret, or (for **Connection string**) the whole connection string. Any user name still comes from the direct field. For SMTP, use a **User / Password** or **JSON** secret: a single value gives no SMTP user, so sending fails with an error instead of connecting without signing in.

**JSON** shows a **JSON Field Mapping** table when selected. For each credential, enter the key in your JSON that holds it:

```json
{ "client_id": "status-probe", "client_secret": "s3cr3t" }
```

| Field | JSON key |
| --- | --- |
| Client ID | `client_id` |
| Client Secret | `client_secret` |

If you leave the mapping empty, all keys are passed through under their own names. That works when your JSON already uses the names BetterStatusPage looks for: `username` and `password`, `clientId` and `clientSecret`, or `connectionString`. A mapped key that is missing from the JSON resolves to an empty string.

A **User / Password** secret cannot be used for **Connection string**; the form warns you if you pick one.

## Who can use the vault

| Role | Vault page | Pick a secret in a monitor or SMTP settings |
| --- | --- | --- |
| **admin** | Create, reveal, change and delete vaults and secrets; HashiCorp connection settings and **Test connection** | Yes |
| **operator** | No | Yes: sees vault and secret names and types, never values |
| **branding**, **viewer** | No | No |

The vault does not decide which secret may be used where. Anyone who can create or edit a monitor, a notification channel or the SMTP settings (operators and administrators, in the panel or with an [API token](api.md)) can point it at any secret of any vault and at any address, and the secret is then sent there when the monitor runs or is tested. Give the operator role, and operator and Admin tokens, only to people and pipelines you trust with every vault secret.

An Operator or Admin [API token](api.md) can list vault and secret names, like an operator in the panel, but it can never manage vaults or read a value.

See [Users and roles](users-and-roles.md) for the roles in general.

### Vaults in configuration files

A [configuration file](configuration-as-code.md#secrets) refers to a secret by the names of the vault and of the secret, and the vault has to exist when the file is imported.

- Vault names are not unique. If a file would have to name a vault whose name another vault also has, the export is refused with `409` and an import refuses the reference. Rename one of the vaults.
- Renaming a vault or a secret breaks files that name it; change the file with it.
- A vault or secret that was deleted is exported as `(deleted vault 3)` or `(deleted secret 9)`, and an import refuses that.
- Importing a file never creates a vault or a secret and never reads a value.

### Audit log

Creating, renaming and deleting a vault, and creating, changing and deleting a secret, are written to the audit log as **Vault** and **Vault Secret**. A secret is shown as `vault name / secret name`. For a HashiCorp Vault vault the entry shows the address, namespace, mount and auth method (never the token, Role ID or Secret ID; replacing them is logged as `credentials: [redacted] → [redacted]`), and a secret reference shows its path and key. When a value changes the entry shows `value: [redacted] → [redacted]`; secret values never reach the audit log. Revealing a secret is not logged.
