# Static fallback

When the server that runs BetterStatusPage is down, the status page is down with it, which is when visitors want it most. The static fallback keeps a **saved copy** of the public page on static hosting that does not depend on your server, so that visitors still see the last known state, with a banner saying when it was taken (you can turn the banner off).

The copy needs no server of its own: it is the same status page, answering its requests from a `snapshot.json` file instead of the API.

## How it fits together

The setup has three parts, and BetterStatusPage does only the first:

1. **BetterStatusPage pushes the copy.** Every minute (or the interval you choose) the instance uploads the page and its data to a bucket on S3-compatible storage.
2. **The bucket serves the copy.** Its content is readable by anyone, over HTTPS, from the root of an address.
3. **Something in front of your domain decides who gets what.** Your status address, for example `status.example.com`, normally leads to the instance. When the instance does not answer, the same address leads to the copy instead, and back to the instance when it returns. This is a proxy, CDN or DNS failover that you run; BetterStatusPage does not do the switching.

```
                     status.example.com
                             │
                  ┌──────────┴───────────┐
                  │  proxy, CDN or DNS   │   checks the instance
                  │  failover (yours)    │   every few seconds
                  └──────────┬───────────┘
        instance answers │                │ instance does not answer
                         ▼                ▼
               BetterStatusPage      bucket with the copy
                  (the live page)    (pushed by BetterStatusPage)
```

Visitors keep using the same address. They do not have to know that the copy exists.

## What is uploaded

| File | What it is |
|------|------------|
| `index.html`, `404.html` | The status page, marked as a saved copy |
| `assets/…`, `icon.png`, `logo_*.png` | The files of the status page |
| `uploads/…` | The logo and favicon images you uploaded in **Branding** |
| `snapshot.json` | The statuses, layout, latest incidents, 90 days of uptime, the data of the response time charts and translations, and the time it was taken |

The files of the page are uploaded again only when they change, so each minute only `snapshot.json` is sent. The snapshot is built from the same data the public page serves: a monitor that is not on the page, a draft incident or an internal maintenance window is not in it.

## What the saved copy does not have

A copy can only show what was in the snapshot. It has no live updates, no **Subscribe** button and no sign-in. It rereads `snapshot.json` every minute. The response time charts of the page are there, but only for the range each chart block was set to in the builder, as they were when the snapshot was taken.

The banner says when the snapshot was taken. When it is older than three intervals (three minutes at the default of 60 seconds), it turns into a warning that the state may be out of date. Turn it off with **Show a banner on the copy** if you do not want visitors to see it. Without the banner, visitors cannot tell the copy from the live page, and they get no warning when it is old.

## Set up the pushing

1. Create a bucket on S3-compatible storage: AWS S3, Cloudflare R2, Backblaze B2 or MinIO. Make its content readable by anyone (see [Serve the copy](#serve-the-copy)).
2. Create an access key that can write to the bucket. A push needs only `s3:PutObject`. **Check access** also tries to remove its test file, `.bsp-access-check`; give the key `s3:DeleteObject` too if you want it gone. Without it the check still passes and that one tiny file stays in the bucket, overwritten by the next check.
3. Open **Static fallback** in the admin console (administrators only). Pick your **Provider**: it fills in the usual region and says where to find the endpoint and the key. Fill in the rest of the target.
4. Click **Check access**. It writes a tiny object to the bucket and removes it again, without pushing the page, so a wrong key or bucket shows up before anything is switched on. It tries the values in the form, saved or not.
5. Click **Save and turn on**. The first push uploads the whole page. **Push now** uploads everything again at once; it works only while the mirror is on. The whole page is also uploaded again whenever you save the settings and every few hours, so a bucket that lost its files gets them back.

The card at the top says in words whether the copy is up to date, when it was last refreshed, when the next push is due, what the copy holds (files and size) and how the latest pushes went: one bar per push, hover it for its time and result. A failing push shows its error and how many in a row failed.

Only changed files are uploaded, so the first push sends the whole page and each later one little more than `snapshot.json`; that is why **Uploaded last time** is usually one file.

| Field | Meaning |
|-------|---------|
| **Bucket** | The name of the bucket |
| **Region** | The region of the bucket; `auto` for Cloudflare R2 |
| **Endpoint** | Leave empty for AWS S3. For another service, its URL, such as `https://ACCOUNT.r2.cloudflarestorage.com` |
| **How often** | 1, 5 or 15 minutes, or a custom number of seconds, at least 60 |
| **Access key ID**, **Secret access key** | The key from step 2. The secret is stored encrypted and is never shown again; **Replace** it, or save with it empty to remove it |
| **Show a banner on the copy** | On by default |

The endpoint may be an address on a private network. These settings are only where the copy is pushed: nothing here makes visitors reach it. That is part 3 below.

## Serve the copy

The page refers to its files with paths from the root (`/assets/…`), so the copy has to be served from the **root of an address**, never from a sub-path such as `example.com/status-copy/`. A custom domain on the bucket, a public bucket address, or a CDN in front of the bucket all do that. The copy must be reachable over HTTPS, because your status address is.

Cache the files as their own headers say: `index.html` and `snapshot.json` are marked `no-cache`, and the files under `assets/` never change under the same name. A CDN that caches `snapshot.json` for long makes the copy age.

## Send visitors to the copy

Your status address has to lead to the instance while it answers and to the copy while it does not. What you need from whatever does the switching:

- **One address for both.** Visitors use `status.example.com` in both cases, so the copy must answer for that name over HTTPS, with a valid certificate.
- **A health check on the instance.** Check `/health`: it answers 200 while the instance runs. The switch happens when the check, or a request, fails.
- **A place that does not go down with the instance.** The proxy, CDN or DNS provider that decides, and the bucket, must not run on the server that hosts BetterStatusPage, or they fall with it. Use another machine or provider.
- **The bucket's root as the fallback.** `/` must give `index.html`, every other path the file of that name, and a path the copy does not have should give `404.html`, as on the live page.

How long the switch takes is how often the check runs, times the number of failures it waits for, plus, with DNS failover, how long resolvers keep the old answer (the record's TTL). A proxy or CDN decides per request and is the quickest; with DNS failover, set a short TTL, 30 to 60 seconds.

### With a proxy or CDN in front

The simplest arrangement is a proxy that tries the instance and falls back to the bucket when it does not answer. This Caddy 2 configuration does that. It was run with an instance that was stopped and started again, and with a bucket on S3-compatible storage: with the instance up it served the instance, with the instance stopped it served `/`, the files of the page and `snapshot.json` from the bucket, and it went back to the instance by itself once the instance answered again.

```caddyfile
status.example.com {
	# Normal operation: the BetterStatusPage instance.
	handle {
		reverse_proxy bsp.internal:3000 {
			health_uri /health
			health_interval 5s
			health_timeout 2s
		}
	}

	# The instance does not answer: the saved copy, served from the root of this address.
	handle_errors {
		@root path /
		@other not path /
		rewrite @root /status-copy/index.html
		rewrite @other /status-copy{path}

		reverse_proxy BUCKET-HOST:9000 {
			# An address the copy does not have gets the page, as on the live site.
			@missing status 404
			handle_response @missing {
				rewrite * /status-copy/404.html
				reverse_proxy BUCKET-HOST:9000
			}
		}
	}
}
```

Adapt two things:

- **`bsp.internal:3000`** is where the instance listens.
- **`BUCKET-HOST:9000` and `/status-copy`** are the address of the bucket and its name in the path, as a storage service that puts the bucket name in the path (MinIO and similar) shows it. For a bucket that has an address of its own, such as a public bucket URL of Cloudflare R2, drop `/status-copy` from the three `rewrite` lines, write the upstream as `https://ADDRESS`, and add `header_up Host {upstream_hostport}` inside the `reverse_proxy` block. That variant was not run.

Run this proxy on another machine than the instance. The same idea works in other proxies and CDNs that can fall back to a second origin when the first does not answer (for example nginx with `error_page`, or a CDN's origin failover), with the same rewrites of `/`.

### With DNS failover

DNS failover, offered for instance by Route 53 and by Cloudflare Load Balancing, answers with the address of the instance while its health check passes and with another address while it fails. The other address has to be a host that serves the copy under your status name over HTTPS, usually a CDN or static host with your domain and a certificate for it, whose origin is the bucket. Point the health check at `https://…/health` of the instance, and set a short TTL on the record. The exact steps depend on the provider.

### What visitors see

While the instance is down, visitors get the copy at the same address, with the banner (unless you turned it off). It rereads `snapshot.json` every minute; with the instance down the file no longer changes, so after three intervals the banner turns into the out-of-date warning. When the instance answers again, new visitors get the live page. A visitor who still has the copy open keeps seeing it, ageing, until they reload.

### Try it

Stop the instance, or block its address, and open your status address. You should get the copy, with its banner. Start the instance again and reload: you should get the live page.

## A private page is never uploaded

A copy lives on public hosting, so it is only made for a [public status page](private-status-page.md). The mirror cannot be switched on while the page is private, and the page cannot be made private while the mirror is on: turn **Static fallback** off first, and remove the files from the bucket, because the last copy stays public until you do.

## Health

**System Health** has a **Static fallback** card, and the **Static fallback** page shows the same state:

| State | Meaning |
|-------|---------|
| **Waiting** | Switched on, and the first push has not finished yet |
| **Up to date** | The last push succeeded |
| **Stale** | The last success is older than three intervals |
| **Failing** | The last push failed; the error is shown. Pushes continue at every interval |
| **Off** | The mirror is switched off |

An error names the HTTP status and the error code of the storage service, and never the key.

## Backup and restore

The settings, with the secret key encrypted by your `VAULT_ENCRYPTION_KEY`, are part of a [backup](backup-restore.md). After a restore the mirror is on as it was, and its first push uploads the **restored** data. Switch it off before restoring if that copy must not replace the one that is up now, or restore with the instance stopped and check the page before you start it.

## API

The admin API serves the settings at `/api/v1/admin/static-mirror`: `GET` and `PUT` for the settings and the status of the latest push, `POST /check` to try a key without pushing (it answers `{ "ok": true }` or `{ "ok": false, "error": "…" }`), `POST /test` to push once now. `GET` also returns the latest pushes, oldest first. They need an administrator's session; API tokens cannot use them. Changes are written to the audit log as **Static Fallback**, and the secret is only ever shown as a mask.
