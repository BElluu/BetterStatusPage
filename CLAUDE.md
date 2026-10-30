# BetterStatusPage

Full-stack TypeScript status page: Fastify + Drizzle + `node:sqlite` API, React admin with drag-and-drop builder, public status app, SSE realtime.

## Model selection

Default to the main session model (Sonnet) for implementation. Delegate to subagents defined in `.claude/agents/`:

| Agent | Model | Use for |
|---|---|---|
| `recon` | haiku | Read-only scouting: where is X defined/used, which files a concept touches |
| `quick-ops` | haiku | Mechanical edits: renames, formatting, boilerplate, changelog/docs entries, repetitive multi-file changes |
| `architect` | opus | Design and analysis: new feature or monitor type design, data model/migration impact, hard-to-diagnose bugs |
| `reviewer` | opus | Security and correctness review of a finished diff |

Rules:
- Do trivial single-file edits directly; delegating has a cold-start cost.
- Use `recon` before a cross-cutting change to build a checklist of every place that needs updating.
- Use `architect` only when the design is genuinely non-trivial; skip it for simple, pattern-following work.
- Escalate to `architect` when an implementation attempt fails twice rather than retrying the same approach.
- Run `reviewer` on any change that performs outbound requests or queries from user-supplied config, handles credentials/vault references, or exposes data on public routes.
- Subagents return findings; the main session makes the edits unless the task is explicitly mechanical (`quick-ops`).

## Adding a monitor type

Touch every layer, using `sqlserver` as the reference implementation:

1. `packages/shared/src/types/monitor.ts`: extend `MonitorType`, add the `XConfig` interface, add it to `MonitorConfig`.
2. `apps/api/src/db/schema.ts` / `migrate.ts`: update type constraints if present.
3. `apps/api/src/workers/<type>.ts`: the checker; wire into `scheduler.ts` and `testRunner.ts`.
4. `apps/api/src/services/monitorConfigSchema.ts`: the zod schema of the new type's `config`. It is the one place that says what the API accepts (`validateMonitorConfig`, used when a monitor is created or changed, including the config import) and what an agent is told (`monitor_config_fields` serves its JSON Schema), and the build fails until every key of the `XConfig` interface has an entry. The Test button judges a config with the same schema. Add the type's one-line summary to `MONITOR_TYPE_SUMMARY` in `apps/api/src/mcp/monitorFields.ts`, and its `XConfig` schema to `docs/public/openapi.yaml`.
5. `apps/admin/src/components/monitors/`: `monitorTypes.ts`, `MonitorTypeConfigFields.tsx`, `MonitorFormModal.tsx` (shared form parts such as `Note` and `SectionDivider` come from `@better-forge/ui`); also `pages/Builder.tsx` if monitor types are listed there.
6. Tests: worker, test-runner, API route, form modal, `apps/api/test/monitor-fields.test.ts` (the schema says what it does: required, unchecked, ranges, secrets); e2e in `e2e/monitors.spec.ts` when the flow changes.
7. Docs: `docs/monitors.md` and `docs/changelog.md`.

Suggested flow: `architect` (if non-trivial) → `recon` checklist → implement worker and its tests → remaining layers → `quick-ops` for docs/changelog → `reviewer`.

## Layers: shared modules and products

The code that is not specific to a status page lives in its own repository, Better-Forge (`D:\Program Files (x86)\Code\Better-Forge`, `github.com/BElluu/Better-Forge`), and comes from npm as `@better-forge/*`. This repository (`apps/api`, `apps/admin`, `apps/status`) is one product composed from them; `packages/shared` (`@bsp/shared`) holds the status-page types.

| Package | Owns |
|---|---|
| `contracts` | browser-safe types (API tokens, audit, notification channels, locales) |
| `db` | SQLite + Drizzle bootstrap, transactions, `DbModule` migration registry |
| `audit`, `auth`, `vault` | audit log; accounts, sessions, SSO, 2FA, API tokens, setup routes, `registerAdminApi`; vaults and secrets |
| `notify` | channels, transports, delivery engine, alert hygiene, routes, delivery worker |
| `backup`, `config-as-code` | backup/restore/CLI/scheduler/routes; YAML engine with a kind registry, entity keys |
| `mcp` | MCP endpoint (Streamable HTTP): Bearer-only access, scoped tools, bounded and sanitised output |
| `mirror` | publishes a set of files to static hosting |
| `runtime` | `createBetterApp`, health, SSE, update check, app lock, shutdown, data paths |
| `ui` | React shell, shared pages, API client, styles and Tailwind preset |

Rules:

- All `@better-forge/*` dependencies are pinned to one released version, exactly (`"0.1.1"`, no range); they are released together and `npm run check:kit` (also in CI) fails on a range, a `file:`/`link:` or a mixture of versions. Dependabot raises them in one pull request. Nothing imports a package's `src/` or `dist/` (ESLint).
- Code that is status-page-specific (monitors, incidents, "status page") stays here; code that another product could use belongs in Better-Forge, behind an option or a factory, never with a product name in it.
- In `apps/api/src`, `kit/*.ts` is the composition root: it creates each module's instance with the product's choices (`kit/auth.ts`, `kit/vault.ts`, `kit/notify.ts`, ...) and exports the members the rest of the code uses as plain re-exports (`export const { requireAuth } = auth.middleware` in `kit/authMiddleware.ts`; likewise `kit/authSession.ts`, `kit/secretBox.ts`, `kit/resolveSecret.ts`, `writeAudit` in `kit/audit.ts`, `kit/userRoutes.ts`, ...). Code outside `kit/` imports those bindings; a member that has none is used through the instance (`auth.twoFactor.resetTwoFactor(...)`), not by adding a forwarding function. Because they read the instance when the module loads, no import cycle may run through `kit/` (`npm run check:cycles`, also in CI). Everything else in `apps/api/src` is status-page code. Paths to `kit/*.js` that are built as strings (the backup worker's `moduleUrl`, `kit/backupService.ts`) are not rewritten by an import refactor; check them by hand.
- The admin icon font (`apps/admin/src/fonts/`) holds the admin's icons plus the ones in `@better-forge/ui/icons.json`; after raising the version, `npm run check:icons` may ask for `npm run build:icons`. The admin Tailwind config adds `uiContent` from `@better-forge/ui/tailwind-preset` to `content`, and vitest lists `@better-forge/ui` in `server.deps.inline` (the package is built for bundlers).

### Changing a module together with this product (two repositories)

A feature or fix here may need a change in a module. Make it in Better-Forge first (its `CLAUDE.md` has the rules; add a changeset; merging to `main` releases it), then raise every `@better-forge/*` here to the released version and continue. To try it before it is released: `npm run kit:local` builds `../Better-Forge` (or `KIT_DIR`) and copies the packages into `node_modules/@better-forge/` (`-- --watch` repeats it on every build there; `npm run kit:reset` is `npm ci`). `package.json` and the lockfile are not changed, so a pull request never carries a local copy. Subagents that scout or review a change must look in both repositories.

### Starting a new Better product

Copy `apps/template` from Better-Forge (`npx degit BElluu/Better-Forge/apps/template my-product`); its `CLAUDE.md` describes the server and the interface.

### Registering what a product adds

- **Role**: `roles.register([...], { fallback, defaultForNewUsers })` on the registry from `createRoleRegistry()` (`apps/api/src/kit/roles.ts`); the shell and `createRoleGuard` take the rank of each role.
- **API token part**: add a `TokenResource` to the catalogue given to `createTokenCatalogue`, and give the routes `part: '<key>'` in a `registerAdminApi` group (`apps/api/src/adminApi.ts`).
- **Config kind**: write a `ConfigKind` (`parse`, `plan`, `apply`, `existingIds`, `export`, optional `link`) like `apps/api/src/kit/config/monitor.ts`, add it to `kinds` and `order` in `kit/config.ts` and to `access` in `kit/configRoutes.ts`.
- **Health contributor**: add a `HealthContributor` to `createSystemHealth({ contributors })` (`services/systemHealth.ts`).
- **Audit entity**: add its type to the product's `AuditEntityType` and its label, icon and filter group to `AuditEntities` (`apps/admin/src/pages/AuditLog.tsx`).
- **Notification kind of event**: build its variables, name its `events` for `createNotifyEngine`, and map them to a `Notice` (`workers/notice.ts`).

## Conventions

- Tests and the end-to-end scenarios run through `tsx`, which does not check types; `npm run typecheck` (`tsconfig.test.json`, then `tsc --noEmit` of `apps/admin`, `apps/status` and `apps/api`) does, and CI runs it. Run it after editing tests or code.

- Icons come from a subset of Material Symbols. After using a new icon name (or raising `@better-forge/*`), run `npm run build:icons` to add it to the fonts (`npm run check:icons` fails in CI otherwise).
- Rename code, CSS, and DB identifiers when UI wording changes; names must match what the UI says.
- Do not reference other products as the model for a feature in docs, README, or code comments.
- README links point to `https://docs.betterstatuspage.dev/<slug>/`; the changelog lives in `docs/changelog.md`.
- Docs for a feature that is not in a published release yet get a yellow callout at the top of its section (or page), in GitHub alert syntax so it also renders on GitHub: `> [!WARNING]` followed by `> **Not released yet.** ... build the image yourself from the `main` branch (see [Deployment](deployment.md)).` List the feature under `## [Unreleased]` in `docs/changelog.md`. When the feature ships, remove the callout and move the changelog entry to the release.
- Keep the docs in sync with the code. On every bug fix and every new feature, check whether `docs/`, `README.md`, and the changelog (`docs/changelog.md`) are still true and up to date, and update whatever the change made wrong or incomplete. Do not finish the task before this check.
- Do not add AI attribution (no `Co-Authored-By`, no AI mentions) to commits, PRs, or comments.
- For styling that must be consistent with the admin, reuse the existing admin design tokens instead of choosing new colours.
