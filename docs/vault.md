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

Secrets live in **vaults**. A vault is a named group with an optional description; create as many as you like, for example one per team or per environment. All vaults are of type **Local**, stored in the BetterStatusPage database. (**Azure Key Vault** is shown in the list as *Coming soon* and cannot be selected.)

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
| **admin** | Create, reveal, change and delete vaults and secrets | Yes |
| **operator** | No | Yes: sees vault and secret names and types, never values |
| **branding**, **viewer** | No | No |

See [Users and roles](users-and-roles.md) for the roles in general.

### Audit log

Creating, renaming and deleting a vault, and creating, changing and deleting a secret, are written to the audit log as **Vault** and **Vault Secret**. A secret is shown as `vault name / secret name`. When a value changes the entry shows `value: [redacted] → [redacted]`; secret values never reach the audit log. Revealing a secret is not logged.
