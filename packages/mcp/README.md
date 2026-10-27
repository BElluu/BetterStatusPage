# @better-kit/mcp

A Model Context Protocol endpoint for a Fastify app (Streamable HTTP, stateless).

- **Bearer only.** Cookies are never read, so a web page cannot use the endpoint; a request with a foreign `Origin`, or
  a `Host` that is not the public URL, is refused.
- **Scoped tools.** Each tool names the permission it needs and whether it only reads, writes, or is destructive (announced to the client as annotations); a tool can only GET, POST, PATCH or PUT, never DELETE; `tools/list` shows a caller only the tools its token may use.
- **The host's own API does the work.** A tool reads through `ctx.get(path)`, a request to the same app with the caller's
  `Authorization` header, so validation, permissions, rate limits and audit stay where they are.
- **Bounded, plain-data output.** Strings are stripped of control, bidi and zero-width characters and cut to 2000
  characters; a result is cut to 64 KB (a list under `items` is shortened first).

The package knows nothing about what the tools are about; the product supplies them with `defineTool` and the
authentication with `authenticate`. Depends on: `@better-kit/contracts`.
