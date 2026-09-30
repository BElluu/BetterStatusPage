# Single sign-on (OpenID Connect)

BetterStatusPage can sign administrators in through any OpenID Connect (OIDC) identity provider: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, Auth0 and others. Sign-in uses the Authorization Code flow with PKCE, `state` and `nonce`, and ends in the same server-side session (HttpOnly cookie + CSRF token) as a password sign-in.

## How it works

- SSO signs in **existing users only**. It never creates accounts. Create the user first in **Users → New User**, then they can use SSO.
- The account is matched by the **email** claim from the identity provider, case-insensitively. The provider must report `email_verified: true`.
- The user keeps their BetterStatusPage role (`admin`, `operator`, `branding`). Roles are not read from the identity provider.
- An SSO sign-in skips the local password and TOTP step, because the identity provider authenticates the user and enforces its own MFA.
- Password sign-in stays available next to SSO unless you disable it.
- Every SSO sign-in and every settings change is written to the audit log. The client secret is never logged.

## Configure it in the admin panel

No restart or `.env` change is needed.

1. In your identity provider, register a **web application** (confidential client) and set the redirect URI to
   `<PUBLIC_URL>/api/v1/auth/oidc/callback`, for example `https://status.example.com/api/v1/auth/oidc/callback`.
   The exact URI is also shown in the form.
2. Open **Users → Single sign-on**, switch it on and fill in:

   | Field | Notes |
   |-------|-------|
   | Issuer URL | The provider's issuer, for example `https://login.microsoftonline.com/<tenant-id>/v2.0` or `https://keycloak.example.com/realms/main`. `/.well-known/openid-configuration` must be reachable from the server. |
   | Client ID / Client secret | The secret is stored encrypted with `VAULT_ENCRYPTION_KEY` and is never shown again. Leave the field empty to keep the stored one. |
   | Redirect URI | Optional. Defaults to `PUBLIC_URL` + `/api/v1/auth/oidc/callback`. Set it when the admin panel is served from another origin. |
   | Scopes | Defaults to `openid email profile`. |
   | Button label | Text of the button on the sign-in page. |
   | Accept providers that omit `email_verified` | Needed for Microsoft Entra ID. Enable it only when the provider's email claim is trustworthy. |
   | Disable password sign-in | See [Password sign-in and lockout protection](#password-sign-in-and-lockout-protection). |

3. Click **Test connection** to run OIDC discovery against the issuer, then **Save**. Saving requires your current password.

The sign-in page shows the SSO button as soon as the settings are saved.

## Configure it with environment variables

For infrastructure-as-code deployments the same settings can come from the environment. When `OIDC_ISSUER` and `OIDC_CLIENT_ID` are both set, the environment **wins** and the **Single sign-on** form becomes read-only.

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | Required to enable OIDC from the environment. |
| `OIDC_CLIENT_SECRET` | Client secret, when the provider issues one. |
| `OIDC_REDIRECT_URI` | Overrides the callback URL derived from `PUBLIC_URL`. |
| `OIDC_SCOPES` | Default `openid email profile`. |
| `OIDC_BUTTON_LABEL` | Default `Sign in with SSO`. |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | `true` accepts providers that omit `email_verified`. |
| `OIDC_DISABLE_PASSWORD_LOGIN` | `true` disables password sign-in while OIDC is active. |
| `OIDC_FORCE_PASSWORD_LOGIN` | Break-glass override, see below. |

Environment variables are read at start-up, so changing them needs a restart.

## Password sign-in and lockout protection

**Disable password sign-in** hides the password form and makes the API reject password logins. Two safeguards keep you from locking everyone out:

- The setting can only be saved after OIDC discovery against the issuer succeeds, and it has no effect while OIDC itself is off or misconfigured.
- If the identity provider is down later, set `OIDC_FORCE_PASSWORD_LOGIN=true` in the server environment and restart. Password sign-in works again until you remove the variable.

## Provider notes

| Provider | Issuer URL | Notes |
|----------|-----------|-------|
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Enable *Accept providers that omit `email_verified`*. Add the `email` optional claim to the ID token if users have no email in the token. |
| Keycloak | `https://<host>/realms/<realm>` | Client authentication on; the user's email must be marked verified. |
| Okta / Auth0 | `https://<tenant>.okta.com` / `https://<tenant>.auth0.com/` | Use a *Web application* with the Authorization Code grant. |
| Google Workspace | `https://accounts.google.com` | Create an OAuth client of type *Web application*. |

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| "Single sign-on failed" on the sign-in page | Discovery failed, the code exchange failed, or the login took longer than 10 minutes. The server log has the reason. Check that the redirect URI registered at the provider matches exactly. |
| "No account matches your single sign-on identity" | No BetterStatusPage user has that email, or the provider did not send a verified email. Create the user, or see *Accept providers that omit `email_verified`*. |
| Test connection fails | The server cannot reach `<issuer>/.well-known/openid-configuration`, or the URL is not the issuer. |
| The form is read-only | `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set in the environment. |
