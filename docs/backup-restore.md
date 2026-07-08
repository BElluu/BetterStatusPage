# Backup and Restore Guide

BetterStatusPage stores runtime state in SQLite plus uploaded assets. Backups are built into the application so operators do not need to copy a live WAL-mode SQLite database manually.

## What a backup contains

A backup archive is named:

```text
bsp-backup-TIMESTAMP.backup
```

It contains:

- a consistent SQLite snapshot created with `VACUUM INTO`,
- `setup.json`,
- uploaded files,
- a versioned manifest,
- SHA-256 checksums.

It does not contain:

- `.env`,
- `JWT_SECRET`,
- `VAULT_ENCRYPTION_KEY`.

Keep `VAULT_ENCRYPTION_KEY` separately. Restore requires it explicitly because encrypted vault records cannot be validated or used without the original key.

## Create a backup

Build first when using the CLI:

```bash
npm run build
npm run backup -- --output ./backups
```

Docker Compose:

```bash
docker compose exec app node apps/api/dist/cli/backup.js
```

The admin Backups page can also create and download backups.

## Verify a backup

CLI:

```bash
npm run backup:verify -- --input ./backups/bsp-backup-TIMESTAMP.backup
```

The admin Backups page can validate an uploaded `.backup` file before restore.

## Restore model

Restore is intentionally offline. Stop the running application before replacing data.

The restore procedure:

1. validates the archive structure,
2. verifies checksums,
3. checks that the supplied `VAULT_ENCRYPTION_KEY` matches the backup,
4. creates a safety backup of the current state,
5. atomically replaces the database and uploads,
6. runs migrations,
7. rolls back if migration fails.

## Restore on bare metal or PM2

```bash
pm2 stop bsp
npm run restore -- --input ./backups/bsp-backup-TIMESTAMP.backup --vault-encryption-key YOUR_64_CHARACTER_HEX_KEY
pm2 start bsp
```

If you do not use PM2, stop the Node.js process with your service manager before running restore.

## Restore with Docker Compose

```bash
docker compose stop app
docker compose run --rm app node apps/api/dist/cli/restore.js --input /app/backups/bsp-backup-TIMESTAMP.backup --vault-encryption-key YOUR_64_CHARACTER_HEX_KEY
docker compose up -d app
```

Docker Compose uses a separate `bsp_backups` volume, so backup archives survive container rebuilds and application data volume changes.

## Automatic backups

The admin Backups page can schedule daily or weekly backups. Retention is count-based: after a successful scheduled backup, older automatic archives are removed according to the configured retention count.

Recommended baseline:

- daily backups,
- at least 7 retained archives,
- periodic download to off-host storage,
- restore drill before production launch and after major upgrades.

## Restore drill checklist

Before relying on backups in production:

- create a fresh backup,
- copy it to a non-production environment,
- stop the test app,
- restore with the original `VAULT_ENCRYPTION_KEY`,
- start the test app,
- verify login,
- verify monitors,
- reveal or resolve one test vault secret,
- verify uploads/branding,
- verify `/ready` returns 200.

## Common failures

### `VAULT_ENCRYPTION_KEY does not match`

The supplied key is not the key used when the backup was created. Use the original 64-character hex key.

### `Database is in use` or `BetterStatusPage is still running`

The application is still running. Stop the app first. Restore is not an online operation.

### `Unsupported backup format`

The file is not a BetterStatusPage `.backup` archive or was created by an incompatible future version.

### Checksum or integrity failure

Treat the backup as corrupted. Use another archive and investigate storage/download corruption.
