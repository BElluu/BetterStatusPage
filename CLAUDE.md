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
4. `apps/api/src/routes/monitors.ts`: config validation.
5. `apps/admin/src/components/monitors/`: `monitorTypes.ts`, `MonitorTypeConfigFields.tsx`, `monitorFormParts.tsx`, `MonitorFormModal.tsx`; also `pages/Builder.tsx` if monitor types are listed there.
6. Tests: worker, test-runner, API route, form modal; e2e in `e2e/monitors.spec.ts` when the flow changes.
7. Docs: `docs/monitors.md` and `docs/changelog.md`.

Suggested flow: `architect` (if non-trivial) → `recon` checklist → implement worker and its tests → remaining layers → `quick-ops` for docs/changelog → `reviewer`.

## Conventions

- Rename code, CSS, and DB identifiers when UI wording changes; names must match what the UI says.
- Do not reference other products as the model for a feature in docs, README, or code comments.
- README links point to `https://docs.betterstatuspage.dev/<slug>/`; the changelog lives in `docs/changelog.md`.
- Docs for a feature that is not in a published release yet get a yellow callout at the top of its section (or page), in GitHub alert syntax so it also renders on GitHub: `> [!WARNING]` followed by `> **Not released yet.** ... build the image yourself from the `main` branch (see [Deployment](deployment.md)).` List the feature under `## [Unreleased]` in `docs/changelog.md`. When the feature ships, remove the callout and move the changelog entry to the release.
- Keep the docs in sync with the code. On every bug fix and every new feature, check whether `docs/`, `README.md`, and the changelog (`docs/changelog.md`) are still true and up to date, and update whatever the change made wrong or incomplete. Do not finish the task before this check.
- Do not add AI attribution (no `Co-Authored-By`, no AI mentions) to commits, PRs, or comments.
- For styling that must be consistent with the admin, reuse the existing admin design tokens instead of choosing new colours.
