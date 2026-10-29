# @better-forge/db

SQLite (`node:sqlite`) and Drizzle bootstrap, transactions, and the registries that let each module own its tables and
migrations. No state of its own: the application opens the connection and passes it in.

```ts
import { composeModules, openDatabase, runMigrations, type DbModule } from '@better-forge/db'

const notes: DbModule = {
  id: 'notes',
  tables: { notesTable },               // Drizzle tables the module owns
  migrations: [
    { kind: 'exec', sql: 'CREATE TABLE IF NOT EXISTS notes (...)' },                       // idempotent DDL
    { kind: 'column', sql: 'ALTER TABLE notes ADD COLUMN pinned INTEGER', desc: 'notes.pinned' }, // tolerates "already applied" only
    { kind: 'data', name: 'seed-notes-v1', run: (sqlite) => { /* once, in a transaction */ } },
  ],
}

const { schema } = composeModules([auth, audit, notes])   // throws on a repeated module, table export or data name
const { sqlite, db, close } = openDatabase({ path, schema })
runMigrations(sqlite, [auth, audit, notes])               // modules run in the order given
```

Rules for a module's migrations:

- Steps run in the listed order on every start, so each must be idempotent.
- A `data` step's name is stored in `schema_migrations`. Never rename or drop one: it would run again on existing data.
- Order matters where SQLite stores the statement text: columns added with `ALTER` keep their relative order per table.
- A module may rely on the tables of the modules listed before it.

`drizzle-orm` is a peer dependency, so the application and every module share one copy. Requires Node 22.5 or newer.

Status: pre-1.0.
