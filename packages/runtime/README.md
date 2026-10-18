# @better-kit/runtime

Application bootstrap: Fastify defaults, health, shutdown, update check, app lock and SSE.

Request logs hide secrets: `redactQueryParams` replaces the value of those query parameters (names are compared after decoding), `redactPathTokenPrefixes` the path segment after a prefix such as `/links/`. `redactUrl` does the same for any URL.

Status: skeleton. Depends on: `@better-kit/db`.
