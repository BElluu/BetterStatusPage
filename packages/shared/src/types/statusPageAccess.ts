import type { Branding } from './branding.js'

/** The error code public endpoints answer 401 with while the page is private and nobody is signed in. */
export const STATUS_PAGE_PRIVATE = 'STATUS_PAGE_PRIVATE'

/** Who may view the status page, set by an administrator. */
export interface StatusPageAccessSettings {
  /** Only signed-in users may view the page; its feeds and its status API are switched off. */
  private: boolean
  /** While private: an SSO sign-in without a matching account creates a viewer account. */
  ssoCreateViewers: boolean
  /** Email domains (lowercase, without "@") an SSO sign-in may create a viewer account for. */
  ssoViewerDomains: string[]
}

/** The settings as the admin console sees them. */
export interface AdminStatusPageAccess extends StatusPageAccessSettings {
  /** Viewer accounts can only be created by SSO while SSO sign-in is configured. */
  ssoConfigured: boolean
}

/** What the status page loads before anything else, without signing in. */
export interface PublicStatusPageAccess {
  private: boolean
  /** The request carried a valid session. */
  signedIn: boolean
  /** The signed-in user's email, so the page can show who is signed in. */
  email: string | null
  /** The signed-in user's role: everyone but a viewer is offered the admin console. */
  role: string | null
  /** The signed-in user must replace a temporary password before the page answers. */
  passwordChangeRequired: boolean
  /** Shown on the sign-in screen of a private page. */
  branding: Branding | null
}
