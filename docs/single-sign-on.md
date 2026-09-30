# Single sign-on (OpenID Connect)

BetterStatusPage can sign administrators in through any OpenID Connect (OIDC) identity provider: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, Auth0 and others. Sign-in uses the Authorization Code flow with PKCE, `state` and `nonce`, and ends in the same server-side session (HttpOnly cookie + CSRF token) as a password sign-in.

## How it works

- SSO signs in **existing users only**. It never creates accounts. Create the user first in **Users → New User**, then they can use SSO.
- The **first** SSO sign-in matches the account by the **email** claim from the identity provider, case-insensitively. The email must be verified: the provider must send `email_verified: true`, or, for Microsoft Entra ID, `xms_edov: true` (see [Microsoft Entra ID](#microsoft-entra-id)).
- That first sign-in links the provider account (issuer + `sub` claim) to the user, shown as **SSO** in **Users**. Later sign-ins match on this link, not on the email, so they keep working when the email changes at the provider. An email address that is later given to someone else at the provider cannot take over the account: that sign-in is refused with `subject_mismatch`. If the issuer URL is changed, the next sign-in links the account again by email.
- The user keeps their BetterStatusPage role (`admin`, `operator`, `branding`). Roles are not read from the identity provider.
- An SSO sign-in replaces the local password, because the identity provider authenticates the user. It never changes the stored password.
- A user who turned on two-factor authentication in **Settings** still enters their code after an SSO sign-in, the same as after a password sign-in. Users without 2FA go straight in, so the identity provider's own MFA applies to them.
- An SSO sign-in revokes a temporary password that was never replaced: it stops working, and the user is not asked to change it. The temporary password therefore never has to be handed to an SSO user, and the one the administrator knows cannot be used. A user who also wants to sign in with a password sets one in **Settings**, confirming with SSO. If an administrator resets the password of an SSO user, for example while the identity provider is down, the new temporary password works until that user's next SSO sign-in.
- Password sign-in stays available next to SSO unless you disable it.
- Every sign-in, with SSO or a password, is written to the audit log as a **Sign-in** entry, **Allowed** or **Denied**, and so is every settings change (**SSO Settings**). The client secret is never logged.
- A refused SSO sign-in shows the user only a generic message. The reason is written to the audit log for administrators, see [Why a sign-in was refused](#why-a-sign-in-was-refused).

## Configure it in the admin panel

No restart or `.env` change is needed.

1. In your identity provider, register a **web application** (confidential client) and set the redirect URI to
   `<PUBLIC_URL>/api/v1/auth/oidc/callback`, for example `https://status.example.com/api/v1/auth/oidc/callback`.
   The exact URI is also shown in the form.
2. Open **Users → Single sign-on**, switch it on and fill in:

   | Field | Notes |
   |-------|-------|
   | Issuer URL | The provider's issuer, for example `https://login.microsoftonline.com/<tenant-id>/v2.0` or `https://keycloak.example.com/realms/main`. `/.well-known/openid-configuration` must be reachable from the server. Use `https`; plain `http` works only for a provider that is itself served over http, such as a local test Keycloak. |
   | Client ID / Client secret | The secret is stored encrypted with `VAULT_ENCRYPTION_KEY` and is never shown again. Leave the field empty to keep the stored one. |
   | Redirect URI | Optional. Defaults to `PUBLIC_URL` + `/api/v1/auth/oidc/callback`. Set it when the admin panel is served from another origin. |
   | Scopes | Defaults to `openid email profile`. |
   | Button label | Text of the button on the sign-in page. |
   | Accept providers that omit `email_verified` | For providers that send no verification claim at all. Enable it only when the provider's email claim is trustworthy. Not needed for Microsoft Entra ID: add the `xms_edov` optional claim instead. |
   | Disable password sign-in | See [Password sign-in and lockout protection](#password-sign-in-and-lockout-protection). |

3. Click **Test connection** to run OIDC discovery against the issuer, then **Save**. Saving asks you to confirm who you are, see [Confirming sensitive actions](#confirming-sensitive-actions).
4. Reopen the form and click **Test sign-in**. It opens the identity provider in a new tab with the saved settings, and after you sign in there it shows every claim of the ID token and what a real sign-in would do: which user it signs in as, whether it links the account, or why it is refused. Nobody is signed in, nothing is linked and nothing is saved. It works while SSO is switched off, so you can check the setup before enabling it.

The sign-in page shows the SSO button as soon as the settings are saved. The button starts the sign-in on the host of the redirect URI, so it works even when the admin panel was opened under another name (for example `127.0.0.1` while the redirect URI uses `localhost`); after signing in you are on the redirect URI's host.

## Configure it with environment variables

For infrastructure-as-code deployments the same settings can come from the environment. When `OIDC_ISSUER` and `OIDC_CLIENT_ID` are both set, the environment **wins** and the **Single sign-on** form becomes read-only.

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | Required to enable OIDC from the environment. |
| `OIDC_CLIENT_SECRET` | Client secret, when the provider issues one. |
| `OIDC_REDIRECT_URI` | Overrides the callback URL derived from `PUBLIC_URL`. |
| `OIDC_SCOPES` | Default `openid email profile`. |
| `OIDC_BUTTON_LABEL` | Default `Sign in with SSO`. |
| `OIDC_ALLOW_UNVERIFIED_EMAIL` | `true` accepts providers that send neither `email_verified` nor `xms_edov`. |
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
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Add the `email` and `xms_edov` optional claims to the ID token, see below. |
| Keycloak | `https://<host>/realms/<realm>` | Client authentication on; the user's email must be marked verified. |
| Okta / Auth0 | `https://<tenant>.okta.com` / `https://<tenant>.auth0.com/` | Use a *Web application* with the Authorization Code grant. |
| Google Workspace | `https://accounts.google.com` | Create an OAuth client of type *Web application*. |

### Microsoft Entra ID

Entra ID never sends the standard `email_verified` claim, and its `email` claim is not verified by default: an administrator of any tenant can set a user's email to an address they do not own. Its verified equivalent is the optional `xms_edov` claim (*email domain owner verified*). It is `true` when the email's domain is verified in the user's tenant, or when the account is a Microsoft account (for example `@outlook.com`), a Google account or a one-time-passcode guest.

In the Entra admin center, open the app registration, then **Token configuration → Add optional claim → ID** and select both **email** and **xms_edov**. `xms_edov` is only sent together with `email`.

BetterStatusPage accepts the email when `xms_edov` is `true`. When it is `false`, the sign-in is refused, even if *Accept providers that omit `email_verified`* is on. Do not turn that option on for Entra ID: with a multi-tenant issuer (`/common`, `/organizations`) it would let a user of another tenant sign in as anyone whose email they copy.

## Confirming sensitive actions

Changing the sign-in settings, resetting another user's 2FA, turning your own 2FA on or off and changing your password all ask you to confirm who you are, the way you signed in:

- **Signed in with a password:** enter your current password.
- **Signed in with SSO:** no password is asked for. If you signed in, or last confirmed, less than 10 minutes ago, the action goes through. Otherwise clicking **Save** (or the action's button) opens a pop-up window at the identity provider, which asks you to sign in again (`prompt=login`). The ID token must report a sign-in (`auth_time`) from the last 5 minutes and belong to the same user; then the window closes and the action completes, keeping what you entered. While the window is open, **Cancel** abandons the action. If the browser blocks the pop-up, the form says so: allow pop-ups for the site and click the button again. A provider that sends no `auth_time` cannot confirm, and the attempt is logged as `token_exchange_failed`.

An SSO user can therefore set a password or turn on 2FA without ever knowing the temporary password.

## Why a sign-in was refused

The sign-in page shows only *"Single sign-on failed"* or *"No account matches your single sign-on identity"*, so it reveals nothing about accounts or configuration. The reason is written to the **Audit Log** as a *Sign-in* entry with the action **Denied** and `method: sso`; filter by *Entity: Sign-in* and *Action: Denied* and open **Show reason**. The entry holds the reason code, a description, the issuer and, when the provider sent one, the email.

| Code | Meaning | Fix |
|------|---------|-----|
| `no_matching_account` | No user has that email. | Create the user in **Users → New User**. |
| `subject_mismatch` | The user with that email is linked to a different account at the same provider. The email address may have been given to someone else. | Check who owns the provider account. If the user's account at the provider was really replaced, delete and re-create the user. |
| `email_not_verified` | The provider sent `email_verified` or `xms_edov` as `false`, or sent neither. | Verify the email at the provider. For Entra ID add the `xms_edov` claim. |
| `no_email_claim` | The ID token has no `email` claim. The entry lists the claims it had. | Add `email` to *Scopes*; for Entra ID also add the `email` optional claim. |
| `idp_error` | The provider returned an error, for example `access_denied` when the user is not assigned to the application. | Check the error description and the user's assignment at the provider. |
| `token_exchange_failed` | The code exchange or ID token validation failed. | Check the client secret and that the redirect URI registered at the provider matches exactly. |
| `flow_expired` | The sign-in took longer than 10 minutes, or the redirect URI points to another host than the one the sign-in started on (`localhost` vs `127.0.0.1`), so the browser did not send the sign-in cookie back. The SSO button on the sign-in page always starts on the redirect URI's host, so a host mismatch comes from **Test sign-in** or a [confirmation](#confirming-sensitive-actions) started while the admin panel was open on another host. | Try again; open the admin panel on the same host as the redirect URI. |
| `discovery_failed` | The server could not load `<issuer>/.well-known/openid-configuration`. | Check the issuer URL and the server's outbound network access. |
| `confirmation_mismatch` | A [confirmation](#confirming-sensitive-actions) signed in at the provider as a different user than the one whose session was being confirmed. | Confirm with the provider account linked to your user. |

Refused password sign-ins are recorded the same way with `method: password`: `password_login_disabled`, `no_matching_account`, `wrong_password`, and for the authentication-code step of either method `invalid_two_factor_code` and `two_factor_expired` (entered more than 5 minutes after the first step). The password itself is never recorded.

The actor of these entries is user 0 with the email from the provider or the one that was entered, because nobody is signed in yet. Callbacks without a sign-in cookie are recorded only when they carry a `state` parameter, so someone opening the callback URL by hand does not fill the log.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| "Single sign-on failed" on the sign-in page | Discovery failed, the provider returned an error, the code exchange failed, or the login took longer than 10 minutes. The audit log has the reason, see [Why a sign-in was refused](#why-a-sign-in-was-refused). |
| "No account matches your single sign-on identity" | No BetterStatusPage user has that email, or the provider did not send a verified email. The audit log has the reason. |
| Test sign-in says the result expired | Results are kept in memory for 10 minutes and are lost when the server restarts. Run the test again. |
| Test connection fails | The server cannot reach `<issuer>/.well-known/openid-configuration`, or the URL is not the issuer. |
| The form is read-only | `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set in the environment. |
