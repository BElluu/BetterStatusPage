# Coverage baseline (0.4.0, before the shared-module extraction)

Moved code keeps these thresholds; the gates in `package.json` and `vitest.config.ts` stay as they are.

| Suite | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| API (`npm run test:api:coverage`) | 97.55 | 86.84 | 94.25 | n/a |
| Frontend (`npm run test:coverage`) | 85.44 | 77.73 | 78.57 | 83.27 |

Regression snapshots that must stay unchanged through the extraction (regenerate only on purpose with
`UPDATE_SNAPSHOTS=1`): `apps/api/test/fixtures/route-table.txt`, `apps/api/test/fixtures/schema-0.4.0.json`.
