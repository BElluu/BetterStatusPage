# Documentation

The guides in this folder are published at **https://docs.betterstatuspage.dev**. They are plain Markdown and read fine on GitHub too.

The site itself is an [Astro](https://astro.build) project in the same folder (`astro.config.mjs`, `src/`, `public/`). Search is [Pagefind](https://pagefind.app), built from the generated pages.

## Editing a guide

Edit the `.md` file and merge it into `main`. The [Docs workflow](../.github/workflows/docs.yml) builds the site and uploads it to the server, usually within a minute or two. Nothing needs restarting.

- The first `# heading` is the page title. Front matter (`title`, `description`) is optional and overrides it.
- Link to another guide by its file name, e.g. `[backups](backup-restore.md#restore)`. The site turns it into `/backup-restore/#restore`, and the link keeps working on GitHub.

## Marking unreleased features

Documentation for a feature that is on `main` but not in a release yet starts with a warning callout:

```md
```

It renders as a yellow block on the site and as GitHub's warning block on GitHub. Remove it when the feature is released.

## Adding a guide

Create `docs/<slug>.md`. It becomes `https://docs.betterstatuspage.dev/<slug>/`. To place it in the sidebar, add the slug to `SECTIONS` in `src/nav.ts`. Until then it is listed under "More".

`README.md` and `publishing-ghcr.md` (maintainer notes) are not published. The list is in `src/content.config.ts`.

## Running it locally

```sh
cd docs
npm install
npm run dev       # http://localhost:4321, reloads as you edit
npm run build     # static site in dist/, with the search index
npm run preview   # serve dist/ (search only works here, not in dev)
```

## Look and feel

Colours, fonts and the dark mode switch follow the admin console. The tokens at the top of `src/styles/global.css` are copied from `apps/admin/src/index.css`, so keep the two in step when the palette changes.

## Hosting

nginx on the project VPS serves the built files. The workflow copies `dist/` there with `rsync` over SSH, so the server needs no Node.js. The server setup (deploy user, web roots, nginx config) is in the landing page repo, [BSPLandingPage](https://github.com/BElluu/BSPLandingPage#deploy), which is hosted the same way.

Repository settings (**Settings → Secrets and variables → Actions**):

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_HOST` | secret | server address |
| `DEPLOY_USER` | secret | SSH user that owns the web root, e.g. `deploy` |
| `DEPLOY_SSH_KEY` | secret | that user's private key |
| `DEPLOY_KNOWN_HOSTS` | secret | output of `ssh-keyscan -p <port> <host>` |
| `DEPLOY_PORT` | variable (optional) | SSH port, default `22` |
| `DOCS_DEPLOY_PATH` | variable (optional) | web root, default `/var/www/docs.betterstatuspage.dev` |
