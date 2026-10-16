# @better-kit/backup

Backup, restore and verification of a SQLite database and the files around it.

- `createBackupService` writes a consistent snapshot of the database (`VACUUM INTO`, integrity-checked) plus the files the application adds, into one checksummed archive, and verifies, lists, prunes and locks backups. The schedule and the last status are kept as files beside the backups.
- `createRestore` restores an archive over a stopped application, takes a safety backup first and puts every replaced file back if the restore fails half way. The application supplies the files around the database, its database handle and the checks that may refuse a backup.
- `createBackupRunner` and `@better-kit/backup/worker` run a backup or a verification on a worker thread.
- `createBackupRoutes` makes the admin routes (list, create, schedule, download, delete, verify an uploaded file) and `createBackupScheduler` runs backups on the configured schedule.
- `createArchiveFormat` is the archive format on its own; the `magic` bytes identify the archives of one product.

Depends on `@better-kit/audit` (the routes) and `node-cron` (the scheduler); the service itself needs only Node (`node:sqlite`).
