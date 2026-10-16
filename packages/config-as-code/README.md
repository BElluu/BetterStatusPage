# @better-kit/config-as-code

Configuration as code: the objects of an application as YAML documents, exported and applied back.

- `createConfigEngine` reads a stream of documents (`---` separated), each with a `kind` registered by the application, checks the whole file, then either reports what would change (`dryRun`) or applies it in one transaction, writes the audit entries after the commit and exports the documents again. A kind supplies how to parse, plan, apply and export its documents; the engine supplies the checks that do not depend on the kind (keys, unknown fields, `__proto__`, at most 100 problems), vault references by name, and the order of everything.
- `createConfigRoutes` serves `GET /export` and `POST /validate`, `POST /apply` with the permission checks per kind (API token resource or user role), the media type and size checks.
- `toYaml`, `toYamlStream`, `readDocuments` write and read the YAML (1.1-safe quoting, no folding, limits on documents and aliases).
- Entity keys: `isValidEntityKey`, `slugifyKey`, `keyForNew` and `backfillKeys` give every object the stable key a document refers to it by.

The database, the transaction and the audit log are supplied by the application. Depends on `@better-kit/contracts` (token permissions) and `yaml`.
