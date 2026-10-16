# @better-kit/ui

The interface the Better products share: React components, the API client, hooks and the look.

- **Components and helpers**: `Modal`, `ConfirmModal`, `CopyButton`, `SidePanelFrame`, the form and state components (`Alert`, `Field`, `Switch`, `Toast`, ...), `useDarkMode`, `useDebouncedValue`, date formatting and the changelog parser.
- **API client** (`api`): cookie session, CSRF header, typed errors.
- **Look**: `@better-kit/ui/styles.css` (the Material 3 colour tokens for light and dark, base styles, buttons, inputs, the navigation, bundled fonts) and `@better-kit/ui/tailwind-preset` (colours backed by those variables, type faces). An application imports the stylesheet first in its own CSS (`@import '@better-kit/ui/styles.css';`), uses the preset in its Tailwind config and adds `packages/ui/src` to Tailwind's `content`.
- **`configureUi({ storagePrefix, apiBase, csrfCookie, basePath, redirectAfterSignIn })`** tells the interface what application it is part of: what it keeps in the browser, where the API answers and where the sign-in page is. Call it before anything is rendered.

Depends on `@better-kit/contracts`; React 19, `react-dom` and `clsx` are peer dependencies.
