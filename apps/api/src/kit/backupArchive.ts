import { backup } from './backup.js'

// Forwards to the archive format of the backup service in ../kit/backup.ts; kept so call sites do not change.
export type { ArchiveEntry } from '@better-kit/backup'
export const { createArchive, extractArchive } = backup
