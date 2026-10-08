# Changelog

All notable changes to BetterStatusPage are documented in this file.
The project follows [Semantic Versioning](https://semver.org/); while it is below 1.0, a new minor version marks new features.

## [Unreleased]

### Added

- **Docker monitor**: checks the state and healthcheck of a container through the Docker Engine API, over a local socket, a Windows named pipe or HTTP(S). Running and healthy is operational; restarting, unhealthy or starting is degraded; stopped, paused or missing is down. Includes the **Test** button. See the [monitors guide](monitors.md#docker).

### Fixed

- **Audit log**: the **Entity** filter now lists every recorded type: user security, branding, page layout, languages, backups, backup schedule and notification deliveries.
- **Delivery history**: the **Event** filter now includes **Certificate**.
- **HTTP(S) monitor**: a GET or HEAD monitor with an empty request body now passes scheduled checks, not only the **Test** button. The body is ignored for these methods.
- **Ping monitor**: the **Test** button now sends an ICMP ping in ICMP mode, instead of always opening a TCP connection.
- **Webhook notifications**: variables such as `{{error_message}}` are now escaped inside the JSON body, so quotes and new lines no longer produce invalid JSON.
- **SMTP with a Vault secret**: a **Secure Value** secret (no username) now makes sending fail with a clear error instead of silently sending without signing in. The SMTP form warns about it.
- **Maintenance windows**: saving a window with no monitors selected and "all monitors" unchecked is now rejected with a message, instead of being saved as a window that suppresses nothing.
- **Status page translations**: English text overrides set in **Settings → Translations** now apply on the public status page.

### Removed

- **"None" incident impact**: the option is gone from the incident form, along with its translation key `incident.impact.none`. Incidents now have `minor`, `major` or `critical` impact.

## [0.2.0] - 2026-10-02

BetterStatusPage now has a home of its own: the project website at [betterstatuspage.dev](https://betterstatuspage.dev) and full documentation at [docs.betterstatuspage.dev](https://docs.betterstatuspage.dev).

### Added

- **Single sign-on with OpenID Connect**: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, Auth0 and other providers, configured in **Users → Single sign-on** without a restart. Authorization Code flow with PKCE, `state` and `nonce`. See the [single sign-on guide](single-sign-on.md).
  - The first sign-in matches the account by verified email, then links it to the provider's issuer and `sub`, so later sign-ins keep working when the email changes.
  - Microsoft Entra ID verified-email claim (`xms_edov`) is supported.
  - Password sign-in can be disabled while SSO is active, with safeguards against locking everyone out.
  - Two-factor authentication still applies after an SSO sign-in for users who turned it on.
  - Every sign-in, allowed or denied, is written to the audit log with the reason.
- **Private status pages**: the page shows its content only to signed-in users; everyone else gets a sign-in screen in the page's own branding. See the [private status page guide](private-status-page.md).
- **Viewer role**: can view a private status page but not the admin console. SSO can create viewer accounts automatically for the email domains you list.
- **Documentation site** at [docs.betterstatuspage.dev](https://docs.betterstatuspage.dev).

### Changed

- Users are no longer asked to change their password when password sign-in is disabled.

### Fixed

- Page builder: dragging blocks into groups.

### Upgrading from 0.1.x

Point `BSP_IMAGE` in `.env` at the `0.2.0` image tag, then `docker compose pull && docker compose up -d`. Database migrations run automatically on startup and no new `.env` variables are required. SSO uses `PUBLIC_URL` to build its callback URL, so set it before turning SSO on.

## Earlier releases

Versions 0.1.0 – 0.1.6 were released before this changelog was started; see the [Git tags](https://github.com/BElluu/BetterStatusPage/tags).
