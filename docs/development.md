# Development

How to run BetterStatusPage from source, check a change, and find your way around the code. To run it in production, see [Deployment](deployment.md).

## You'll need

- **Node.js 26.10+**: the API uses the built-in `node:sqlite` module.
- **npm 11+**

## Run it

```bash
git clone https://github.com/BElluu/BetterStatusPage.git
cd BetterStatusPage
npm install
npm run dev
```

Three things start:

| App | URL |
|-----|-----|
| API | `http://localhost:3000` |
| Admin | `http://localhost:5173` |
| Status page | `http://localhost:5174` |

Open the admin URL and a setup wizard creates your administrator account.

The shared packages in `packages/*` are used from their built `dist`. `npm run dev` builds only the packages that changed since the last build (`npm run build:kit -- --force` builds all of them). To see an edit in a package while the apps run, watch it with `npm run dev -w @better-kit/<name>`.

For a production-style run from source:

```bash
npm run build   # builds the API and both frontends
npm start       # starts the API, which serves them as static files
```

One process, one port.

## Check a change

```bash
npm run lint               # ESLint for the API, the shared packages and the React apps
npm run typecheck          # types of tests and apps (tests run through tsx, which does not check them)
npm test                   # API integration tests and frontend component tests
npm run test:api:coverage  # API tests with enforced coverage thresholds
npm run test:coverage      # frontend coverage report with enforced thresholds
npm run build              # strict TypeScript and production builds for all workspaces
npm run backup             # a consistent database and uploads backup (after a build)
```

Browser tests use Playwright. Install Chromium once, then run the suite:

```bash
npx playwright install chromium
npm run test:e2e
```

The E2E suite starts from an empty instance every run (runtime data lives under `.e2e/` and is wiped first), walks through the setup wizard, and then covers monitors, incidents, maintenance, email subscriptions, the page builder's drag and drop, role-based access and a private status page with a viewer account. GitHub Actions runs lint, tests, coverage, builds, Playwright E2E and a production Docker smoke test on pull requests and pushes to `main`.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│                                                             │
│   ┌──────────────────┐        ┌──────────────────────────┐  │
│   │   Admin UI       │        │   Public Status Page     │  │
│   │   React 19       │        │   React 19               │  │
│   │   Vite · RQ · DnD│        │   SSE · i18n · dark mode │  │
│   └────────┬─────────┘        └────────────┬─────────────┘  │
└────────────┼───────────────────────────────┼────────────────┘
             │  REST + SSE                   │  REST + SSE
┌────────────▼───────────────────────────────▼────────────────┐
│                    Fastify 5  (Node.js 26+)                 │
│                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│   │  Admin API   │  │  Public API  │  │  Webhook API     │  │
│   │ Auth + RBAC  │  │ open/session │  │  token auth      │  │
│   └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │               Background Workers                     │  │
│   │                                                      │  │
│   │  Scheduler                  Notifier                 │  │
│   │  ├── HTTPS checker          Vault resolver           │  │
│   │  ├── Ping / TCP             Result purger (daily)    │  │
│   │  ├── DNS resolver                                    │  │
│   │  └── DB checkers (SQL, PostgreSQL, MySQL, Mongo)     │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │           Drizzle ORM  ·  SQLite (WAL mode)          │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**SQLite instead of Postgres.** A status page for most teams doesn't need a database server. SQLite in WAL mode handles concurrent reads and writes, has no operations overhead, and the whole database is a single file you can back up.

**SSE instead of WebSockets.** Status updates only flow from the server to the client. SSE does that over plain HTTP, needs nothing from a reverse proxy beyond turning buffering off, and reconnects by itself.

**A monorepo with shared types.** The API and both frontends share one TypeScript package for the domain types (`@bsp/shared`), so a type changed in one place fails the build everywhere it matters.

**An AES-256-GCM vault in the process.** A random 12-byte IV per secret, authentication tag verification on decrypt, secrets never logged. See [Secrets vault](vault.md).

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 26+ |
| Language | TypeScript 5.7 |
| Backend | Fastify 5 |
| Database | SQLite (`node:sqlite`), Drizzle 0.45 |
| Frontend | React 19, Vite 6, Tailwind CSS 3 |
| Data and state | TanStack Query 5, Zustand 5 |
| Drag and drop | dnd-kit 6 |
| Auth | Server-side sessions, HttpOnly cookies, CSRF, TOTP, bcrypt, OpenID Connect (PKCE) |
| Email | Nodemailer 9 |
| Monitors | mssql 11, pg 8, mysql2 3, mongodb 7 |
| Scheduler | node-cron 3 |

## Project structure

```
BetterStatusPage/
├── apps/
│   ├── api/           # Fastify backend: monitors, workers, incidents, public routes
│   │   └── src/
│   │       ├── kit/       # Composition of the shared modules (auth, vault, notify, backup, ...)
│   │       ├── db/        # Application tables and migrations
│   │       ├── routes/    # Endpoint handlers
│   │       ├── workers/   # Scheduler, checkers, notification events
│   │       └── services/  # Application services
│   ├── admin/         # Admin console (React): status-page pages on top of @better-kit/ui
│   ├── status/        # Public status page (React)
│   └── template/      # Minimal app built only from the shared modules
└── packages/
    ├── shared/        # Status-page types (@bsp/shared)
    └── …              # Shared modules (@better-kit/*): contracts, db, audit, auth, vault,
                       # notify, backup, config-as-code, runtime, ui
```

The shared modules hold everything that is not specific to a status page, so another product can be built on the same foundation. `CLAUDE.md` in the repository root describes the layering rules and how to start a new product from `apps/template`.

## Contributing

Found a bug or have an idea? Pull requests are welcome. Open an issue first for anything bigger than a typo fix so the approach can be discussed.

1. Fork the repository and create a branch (`git checkout -b feature/your-idea`).
2. Make the change, with tests.
3. Run `npm run lint && npm run typecheck && npm test && npm run build`.
4. Update `docs/` and `docs/changelog.md` if behaviour changed.
5. Open a pull request.
