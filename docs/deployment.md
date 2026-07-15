# Deployment Guide

Two paths: **Docker Compose** (recommended — zero dependencies, five commands) or **bare metal** (if you manage your own Node.js environment).

---

## Option A — Docker Compose (recommended)

### Prerequisites

- Docker 24+ and Docker Compose v2 (`docker compose version`)
- A domain or IP pointing to your server

### 1. Clone and configure

```bash
git clone https://github.com/BElluu/BetterStatusPage.git
cd BetterStatusPage
cp .env.example .env
```

Edit `.env` — set these two production secrets:

```env
JWT_SECRET=<random 64-char string>
VAULT_ENCRYPTION_KEY=<random 64-char hex string>
```

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# run twice — once for JWT_SECRET, once for VAULT_ENCRYPTION_KEY
```

### 2. Pull and start

```bash
export BSP_IMAGE=ghcr.io/belluu/better-status-page:0.1.3
docker compose up -d
```

The container image contains the compiled API and both built frontends. For local image development, use the local override so the production Compose file continues to use GHCR:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

### 3. Open the setup wizard

Navigate to `http://your-server:3000/admin` — you'll be greeted by the setup wizard. Create the first administrator account there; the web setup wizard does not read administrator credentials from `.env`.

The status page is at `http://your-server:3000`.

### Useful commands

```bash
docker compose logs -f          # stream logs
docker compose restart app      # restart after config change
docker compose down             # stop (data is preserved in the volume)
docker compose down -v          # stop AND delete all data — use with caution
docker compose pull && docker compose up -d  # update to the configured published image
```

### Where is my data?

Application data lives in the `bsp_data` Docker named volume, mounted at `/app/data` inside the container:

```
/app/data/
├── db.sqlite       # the entire database
├── setup.json      # marks setup as complete
└── uploads/        # uploaded logos and favicons
```

Generated archives live in a separate `bsp_backups` volume mounted at `/app/backups`. Both volumes survive `docker compose down`, container rebuilds, and image upgrades. Use the backup commands below instead of copying the active WAL database or its volume directly.

---

## Option B — Bare metal (VPS / dedicated server)

### Prerequisites

- **Node.js 22.14+** — uses the built-in `node:sqlite` module
- **npm 10+**
- Linux (Ubuntu 22.04+ recommended) or any OS with Node.js support

### 1. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v22.x.x
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/BElluu/BetterStatusPage.git
cd BetterStatusPage
npm install
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Set `JWT_SECRET` and `VAULT_ENCRYPTION_KEY`. The web setup wizard asks for the first administrator credentials. See the [environment variables reference](#environment-variables) below.

### 4. Build

```bash
npm run build
```

This compiles the TypeScript API and builds both React frontends. Output:
- `apps/api/dist/` — compiled API
- `apps/admin/dist/` — admin panel static files
- `apps/status/dist/` — status page static files

### 5. Start

```bash
NODE_ENV=production node apps/api/dist/index.js
```

Open `http://localhost:3000/admin` to run the setup wizard.

### 6. Keep it running with PM2

```bash
npm install -g pm2
pm2 start apps/api/dist/index.js --name bsp --node-args="--env-file=.env"
pm2 save
pm2 startup    # generates the command to run on boot — follow the printed instructions
```

Or create `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: 'bsp',
    script: 'apps/api/dist/index.js',
    env: {
      NODE_ENV: 'production',
    },
  }],
}
```

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

---

## Nginx reverse proxy

Whether you're using Docker or bare metal, put Nginx in front — it handles SSL termination, compression, custom ports, and proper SSE proxying.

BetterStatusPage is a **single process** that serves everything (API + admin panel + status page) on one port. Nginx is what exposes different URLs or ports to the outside world, routing each domain transparently to that one backend. Because the frontend JavaScript uses relative URLs (`/api/v1/...`), requests always go to the same origin the user sees in their browser — Nginx handles the rest invisibly.

Set `TRUST_PROXY=1` when Nginx is the only path to the application. This makes authentication and setup rate limits use the real client IP from `X-Forwarded-For`. Do not enable it while the application port is directly reachable from the internet, because clients could spoof forwarding headers.

Production rule: do not expose the application port directly to the internet when `TRUST_PROXY` is enabled. Bind Docker to `127.0.0.1:3000:3000` or restrict the port with your firewall, then let Nginx be the only public entry point.

### Install Nginx

```bash
sudo apt install nginx
```

### Scenario 1 — everything on one domain (simplest)

The status page is at the root, admin panel at `/admin/`.

```nginx
server {
    listen 443 ssl;
    server_name status.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Required for Server-Sent Events — do not remove
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }
}
```

The admin panel is then reachable at `https://status.example.com/admin/`.

### Scenario 2 — separate subdomains for status page and admin panel

Two domains, one backend process. The browser JS on each domain makes relative API requests to its own domain, and Nginx proxies those to the shared backend.

```nginx
# ── Shared proxy settings ─────────────────────────────────────────────────────
# Put this in /etc/nginx/snippets/bsp-proxy.conf
# proxy_pass         http://127.0.0.1:3000;
# proxy_http_version 1.1;
# proxy_set_header   Host              $host;
# proxy_set_header   X-Real-IP         $remote_addr;
# proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
# proxy_set_header   X-Forwarded-Proto $scheme;
# proxy_buffering    off;
# proxy_cache        off;
# proxy_read_timeout 3600s;

# ── Public status page ────────────────────────────────────────────────────────
server {
    listen 443 ssl;
    server_name status.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }
}

# ── Admin panel ───────────────────────────────────────────────────────────────
# The admin panel assets are served at /admin/ by the Node.js process.
# Nginx proxies everything — both /admin/* (static files) and /api/v1/* (API calls).
server {
    listen 443 ssl;
    server_name admin.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;
    }
}
```

Users visit `https://admin.example.com/admin/` for the admin panel. The JS inside makes requests to `admin.example.com/api/v1/...`, Nginx proxies those to `localhost:3000/api/v1/...`. Transparent.

### Scenario 3 — custom ports per component

Some deployments expose specific ports directly (without port 443). Set the app's `PORT` in `.env`, then configure Nginx to listen on whatever external port you want:

```nginx
# Status page accessible on port 4000
server {
    listen 4000 ssl;
    server_name statusklient1.pl;
    ...
    location / { proxy_pass http://127.0.0.1:3000; ... }
}

# Admin panel accessible on port 5000
server {
    listen 5000 ssl;
    server_name adminpanelklient1.pl;
    ...
    location / { proxy_pass http://127.0.0.1:3000; ... }
}
```

The app itself still runs on port 3000 internally. Nginx is the only thing that needs to know about the external ports.

> For each port you expose, make sure your firewall allows it:
> ```bash
> sudo ufw allow 4000/tcp
> sudo ufw allow 5000/tcp
> ```

### Scenario 4 — multiple clients on the same server

Each client gets their own BetterStatusPage instance. Run one Docker Compose stack per client, each on a different internal port, then use Nginx to route domains:

```
/opt/bsp-client1/   → runs on port 3001
/opt/bsp-client2/   → runs on port 3002
/opt/bsp-client3/   → runs on port 3003
```

```bash
# /opt/bsp-client1/.env
PORT=3001
JWT_SECRET=<unique per client>
VAULT_ENCRYPTION_KEY=<unique per client>
```

```nginx
server {
    listen 443 ssl;
    server_name status.client1.com;
    location / { proxy_pass http://127.0.0.1:3001; ... }
}

server {
    listen 443 ssl;
    server_name status.client2.com;
    location / { proxy_pass http://127.0.0.1:3002; ... }
}
```

Each client has fully isolated data (separate SQLite files, separate encryption keys, separate JWT secrets). They never share anything.

### Limit backend access to localhost only

When using Nginx as the public entry point, bind the app to localhost only so it can't be reached directly:

```yaml
# docker-compose.yml
ports:
  - "127.0.0.1:3000:3000"
```

```bash
# bare metal .env
# PORT=3000 — then Nginx proxies to 127.0.0.1:3000
TRUST_PROXY=1
```

### HTTPS with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d status.example.com -d admin.example.com
```

Certbot edits your Nginx configs automatically and sets up auto-renewal.

---

## Updates

### Docker Compose

```bash
export BSP_IMAGE=ghcr.io/belluu/better-status-page:0.1.3
docker compose pull
docker compose up -d
```

The volume is untouched. Database migrations run automatically on startup.

### Bare metal

```bash
git pull
npm install
npm run build
pm2 restart bsp
```

---

## Production checklist

Before exposing an instance publicly:

- `NODE_ENV=production` is set.
- `JWT_SECRET` is random, non-default, and at least 32 characters.
- `VAULT_ENCRYPTION_KEY` is a random 64-character hex string and stored outside the application.
- The app port is private; public traffic goes through Nginx/SSL.
- `TRUST_PROXY=1` is enabled only when Nginx is the only path to the app.
- Backups are configured, one backup was created, and verification passes.
- A restore drill was completed on a non-production copy.
- `/health` returns 200 and `/ready` returns 200 after setup.
- GitHub CI or equivalent release checks passed: lint, tests, build, Docker build, and E2E on Linux.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BSP_IMAGE` | Docker Compose | Container image used by `docker-compose.yml`, for example `ghcr.io/belluu/better-status-page:0.1.3`. |
| `BSP_BIND_ADDRESS` | Docker Compose | Host address for published port. Default/recommended behind Nginx: `127.0.0.1`. Use `0.0.0.0` only for direct testing. |
| `PORT` | No | Port to listen on. Default: `3000` |
| `NODE_ENV` | Yes (prod) | Set to `production`. Enables security headers, HSTS, enforces secrets. |
| `JWT_SECRET` | Yes (prod) | Signs the HttpOnly admin session cookie. Min 32 chars. Changing it logs everyone out. |
| `VAULT_ENCRYPTION_KEY` | Yes (prod) | 64-char hex string (32 bytes) for AES-256-GCM vault encryption. **Changing it makes all stored secrets unreadable.** |
| `ADMIN_EMAIL` | `db:seed` only | Required only when intentionally running `npm run db:seed`. The web setup wizard does not read it. |
| `ADMIN_PASSWORD` | `db:seed` only | Required only when intentionally running `npm run db:seed`; minimum 8 characters. |
| `DATABASE_PATH` | No | Path to the SQLite file. Default: `./data/db.sqlite` |
| `UPLOAD_DIR` | No | Directory for uploaded files (logos, favicons). Default: `./data/uploads` |
| `BACKUP_DIR` | No | Directory for generated backup archives. Default: `./data/backups` |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins. Leave unset if Nginx handles CORS, or in single-domain setups. |
| `TRUST_PROXY` | No | Trusted proxy setting (`1` for one reverse proxy, or trusted addresses). Enable only when the app port is not directly exposed. |
| `SCHEDULER_TICK_SECONDS` | No | How often the scheduler scans for due monitors. Default: `10`. Must be 1-59 seconds. |
| `MONITOR_CHECK_CONCURRENCY` | No | Maximum number of due monitors checked concurrently. Default: `20`. |
| `MONITOR_RESULT_RETENTION_DAYS` | No | Monitor result retention period. Default: `90`. |
| `MONITOR_RESULT_PURGE_CRON` | No | Cron expression for purging old monitor results. Default: `0 2 * * *` (daily at 02:00). |

Generate secrets:

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# VAULT_ENCRYPTION_KEY (must be exactly 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Backups

BetterStatusPage creates a consistent SQLite snapshot with `VACUUM INTO`; do not copy a live `db.sqlite` directly while WAL mode is active. A `bsp-backup-TIMESTAMP.backup` archive contains the database, `setup.json`, uploads, a versioned manifest, and SHA-256 checksums.

For the full operational procedure, including restore drills and key handling, see [backup-restore.md](backup-restore.md).

Build the application before using the CLI, then create or verify a backup:

```bash
npm run build
npm run backup -- --output ./backups
npm run backup:verify -- --input ./backups/bsp-backup-TIMESTAMP.backup
```

The admin **Backups** page can create, download, validate, delete, and schedule backups. Automatic backups support daily or weekly execution and count-based retention.

Restore is deliberately offline. Stop the application first:

```bash
pm2 stop bsp
npm run restore -- --input ./backups/bsp-backup-TIMESTAMP.backup --vault-encryption-key YOUR_64_CHARACTER_HEX_KEY
pm2 start bsp
```

The restore validates every checksum, runs SQLite integrity checks, creates a safety backup of the current state, atomically replaces the data, runs migrations, and rolls back if migration fails.

Docker Compose uses a separate `bsp_backups` volume, so deleting the application data volume does not delete backup archives:

```bash
# Online backup
docker compose exec app node apps/api/dist/cli/backup.js

# List available archives
docker compose run --rm app ls -lh /app/backups

# Offline restore
docker compose stop app
docker compose run --rm app node apps/api/dist/cli/restore.js --input /app/backups/bsp-backup-TIMESTAMP.backup --vault-encryption-key YOUR_64_CHARACTER_HEX_KEY
docker compose up -d app
```

`VAULT_ENCRYPTION_KEY` and `.env` are never included. Keep the key separately. Restore requires the key explicitly and rejects malformed or mismatched values.

---

## Recover access when 2FA is lost

An administrator can reset 2FA for another user from **Admin → Users**. The action requires the administrator's current password and exact confirmation of the target email address. It removes only the target user's 2FA configuration, revokes all of their active sessions, and writes an audit entry. It does not change their password.

An administrator cannot use this action on their own account. If the installation has only one administrator and both the authenticator and recovery codes are unavailable, use the emergency CLI from a trusted host. Access to the application host and data volume is the authority for this operation.

Build the application before running the local CLI:

```bash
npm run build
npm run 2fa:reset -w apps/api -- --email admin@example.com --confirm admin@example.com
```

Docker Compose:

```bash
docker compose exec app node apps/api/dist/cli/resetTwoFactor.js --email admin@example.com --confirm admin@example.com
```

If the application container is not running, use the same persistent data volume through a one-off container:

```bash
docker compose run --rm app node apps/api/dist/cli/resetTwoFactor.js --email admin@example.com --confirm admin@example.com
```

The confirmation must exactly match the email. A successful reset revokes every session for the account and records an `emergency_cli` entry in the audit log. Sign in with the existing password and configure 2FA again immediately.

---

## Firewall

Only expose port 443 (and 80 for redirect) to the internet. Keep the app port (3000) internal:

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (for Let's Encrypt redirect)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

If using Docker without Nginx, you can publish the port to localhost only:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

This prevents direct access to port 3000 from outside — all traffic goes through Nginx.
