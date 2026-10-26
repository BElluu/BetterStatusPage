# @better-kit/runtime

Application bootstrap: Fastify defaults, health, shutdown, update check, app lock and SSE.

Request logs hide secrets: `redactQueryParams` replaces the value of those query parameters (names are compared after decoding), `redactPathTokenPrefixes` the path segment after a prefix such as `/links/`. `redactUrl` does the same for any URL.

`createSse(limits)` serves live event streams. `SseLimits` caps the open anonymous streams in total and per address (`rateLimitKey` groups an IPv6 address by its /64), and the unsent bytes a client may hold before it is disconnected; signed-in streams are not counted. `rateLimitKey(ip)` is the key to use for any per-address limit.

Status: skeleton. Depends on: `@better-kit/db`.
