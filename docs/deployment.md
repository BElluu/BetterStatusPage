# Deployment Guide

Two paths: **Docker Compose** (recommended — zero dependencies, five commands) or **bare metal** (if you manage your own Node.js environment).

---

## Option A — Docker Compose (recommended)

### Prerequisites

- Docker 24+ and Docker Compose v2 (`docker compose version`)
- A domain or IP pointing to your server

### 1. Clone and configure

```bash
git clone https://github.com/your-username/BetterStatusPage.git
cd BetterStatusPage
cp .env.example .env
```

Edit `.env` — at minimum set these three:

```env
JWT_SECRET=<random 64-char string>
VAULT_ENCRYPTION_KEY=<random 64-char hex string>
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=a-strong-password
```

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# run twice — once for JWT_SECRET, once for VAULT_ENCRYPTION_KEY
```

### 2. Build and start

```bash
docker compose up -d --build
```

First build takes 2–4 minutes (installs deps, compiles TypeScript, builds React apps). Subsequent starts are instant.

### 3. Open the setup wizard

Navigate to `http://your-server:3000/admin` — you'll be greeted by the setup wizard. Fill in your admin credentials from `.env` and finish setup.

The status page is at `http://your-server:3000`.

### Useful commands

```bash
docker compose logs -f          # stream logs
docker compose restart app      # restart after config change
docker compose down             # stop (data is preserved in the volume)
docker compose down -v          # stop AND delete all data — use with caution
docker compose pull && docker compose up -d --build  # update to latest
```

### Where is my data?

Everything lives in the `bsp_data` Docker named volume, mounted at `/app/data` inside the container:

```
/app/data/
├── db.sqlite       # the entire database
├── setup.json      # marks setup as complete
└── uploads/        # uploaded logos and favicons
```

Named volumes survive `docker compose down`, container rebuilds, and image upgrades. The data is **not** deleted unless you explicitly run `docker compose down -v`.

To back up:

```bash
docker compose exec app sh -c "cp /app/data/db.sqlite /tmp/db.backup.sqlite"
docker cp $(docker compose ps -q app):/tmp/db.backup.sqlite ./db.backup.sqlite
```

Or simpler — find the volume on disk and copy it directly:

```bash
docker volume inspect bettterstatuspage_bsp_data   # shows Mountpoint path
sudo cp <mountpoint>/db.sqlite ./db.backup.sqlite
```

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
git clone https://github.com/your-username/BetterStatusPage.git
cd BetterStatusPage
npm install
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Set `JWT_SECRET`, `VAULT_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. See the [environment variables reference](#environment-variables) below.

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
git pull
docker compose up -d --build
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

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Port to listen on. Default: `3000` |
| `NODE_ENV` | Yes (prod) | Set to `production`. Enables security headers, HSTS, enforces secrets. |
| `JWT_SECRET` | Yes (prod) | Signs JWT auth tokens. Min 32 chars. Changing it logs everyone out. |
| `VAULT_ENCRYPTION_KEY` | Yes (prod) | 64-char hex string (32 bytes) for AES-256-GCM vault encryption. **Changing it makes all stored secrets unreadable.** |
| `ADMIN_EMAIL` | Setup only | Email for the first admin account, created during setup wizard. |
| `ADMIN_PASSWORD` | Setup only | Password for the first admin account. Can be changed in the UI afterwards. |
| `DATABASE_PATH` | No | Path to the SQLite file. Default: `./data/db.sqlite` |
| `UPLOAD_DIR` | No | Directory for uploaded files (logos, favicons). Default: `./data/uploads` |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins. Leave unset if Nginx handles CORS, or in single-domain setups. |

Generate secrets:

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# VAULT_ENCRYPTION_KEY (must be exactly 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Backups

The entire state of BetterStatusPage is in two places:

| What | Where | How to back up |
|------|-------|----------------|
| Database | `DATABASE_PATH` (default `./data/db.sqlite`) | Copy the file. SQLite supports hot backups — you can copy a live database safely. |
| Uploads | `UPLOAD_DIR` (default `./data/uploads`) | Copy the directory. |
| Encryption key | `VAULT_ENCRYPTION_KEY` in `.env` | Store it somewhere safe separately — without it, vault secrets are lost even if you have the DB. |

For automated backups, a simple cron job:

```bash
# /etc/cron.daily/bsp-backup
#!/bin/bash
DEST=/var/backups/bsp/$(date +%Y-%m-%d)
mkdir -p "$DEST"
cp /path/to/data/db.sqlite "$DEST/db.sqlite"
cp -r /path/to/data/uploads "$DEST/uploads"
find /var/backups/bsp -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
```

```bash
sudo chmod +x /etc/cron.daily/bsp-backup
```

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
