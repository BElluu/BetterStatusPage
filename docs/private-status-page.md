# Private status page

By default the status page is public: anyone with the URL can see it. An administrator can make it **private**. A private page only shows its content to signed-in users. Everyone else gets a sign-in screen in the page's own branding, where they sign in with a password or through [single sign-on](single-sign-on.md).

Use it for internal status pages, or for a page you only want to share with selected customers.

## Turn it on

1. Open **Users → Status page access** (administrators only).
2. Switch on **Private status page** and click **Save**.

The change applies at once. Visitors who had the page open stop receiving live updates immediately, and the sign-in screen appears as soon as the page reloads its data. The change is written to the audit log as **Status Page Access**.

## Who can view a private page

Every user who can sign in can view the page: `admin`, `operator`, `branding` and `viewer`.

| Role | Status page | Admin console |
|------|-------------|---------------|
| **viewer** | Yes | No: it sends them to the status page |
| **branding**, **operator**, **admin** | Yes | As before |

Give people who should only view the page the **Viewer** role. Create them in **Users → New User**, pick **Viewer**, and send them the temporary password. On their first sign-in the sign-in screen asks them to replace it with their own password, then shows the page. A viewer who signs in on the admin sign-in page, or opens any admin console address, is taken to the status page.

Viewers cannot change their password or set up two-factor authentication themselves. When a viewer forgets their password, an administrator resets it in **Users**, and the viewer replaces the new temporary password on their next sign-in.

When signed in, the page header shows an account menu with who is signed in and **Sign out**. Everyone but a viewer also gets a link to the **Admin console** there.

## Viewer accounts through single sign-on

Creating an account for every person who may view the page does not scale for an internal page. With SSO configured you can let the identity provider decide instead:

1. Set up [single sign-on](single-sign-on.md).
2. In **Users → Status page access**, with the page private, switch on **Create viewer accounts on single sign-on**.
3. List the **email domains** that may get an account, for example `example.com`. At least one domain is required. Otherwise anyone with an account at a shared provider (a personal Google or Microsoft account) could sign up.

A person without an account who signs in through SSO with a **verified** email from one of these domains then gets a Viewer account. The account is linked to their identity-provider account at once, has no usable password and signs in through SSO only. Each such account is written to the audit log as a created user, with `createdBy: sso`.

Viewer accounts are only created while the page is private. Existing accounts are never changed: someone who already has an account keeps their role. **Test sign-in** in **Users → Single sign-on** shows *Creates the Viewer account …* for a sign-in that would create one, without creating it.

To take access away, delete the user or change their role in **Users**. Both end their sessions immediately. An account created by SSO is created again on the next SSO sign-in as long as its domain is listed, so for a person who should no longer have access, remove them at the identity provider (or remove the domain).

## What a private page switches off

Feed readers, Slack and scripts cannot sign in, so these stop working while the page is private:

- the RSS and Atom feeds (`/api/v1/public/incidents.rss`, `incidents.atom`)
- the Slack feed (`/api/v1/public/slack.rss`)
- the status API (`summary.json`, `components.json`)

They answer `404`, the subscribe dialog no longer offers them, and **Subscribers** shows why. They come back when the page is made public again.

Email and webhook subscriptions keep working. Signing up needs a signed-in user, because the form is on the page. Existing subscribers keep receiving notifications, and the confirm, manage and unsubscribe links in their emails work without signing in.

## Details

- Every public endpoint that shows status data (`/api/v1/public/status`, `layout`, `incidents`, uptime and response-time history, and the live event stream) answers `401` with the code `STATUS_PAGE_PRIVATE` without a session.
- Responses of a private page are sent with `Cache-Control: private` and `X-Robots-Tag: noindex, nofollow`, so shared caches do not keep them and search engines do not index them.
- An [API token](api.md) cannot be used to view a private page: the endpoints above answer it with `403`, not `401`.
- `/api/v1/public/access` is always open. It tells the page whether it is private and whether the visitor is signed in, and returns the branding for the sign-in screen. Branding, logos and translations stay public for the same reason.
- An SSO sign-in started on the sign-in screen comes back to the status page at `PUBLIC_URL`, also when the SSO redirect URI points to another origin. The session cookie belongs to the redirect URI's host, so use the same host name in both (not `localhost` in one and `127.0.0.1` in the other).
- The status page and the admin console share one session. An administrator who is signed in to the console sees the private page without signing in again, and the branding preview keeps working.
- Monitor webhooks (`/api/v1/hook/...`) are not affected.
