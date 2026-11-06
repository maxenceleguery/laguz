---
"@laguzjs/server": minor
---

Server integrations. `useLaguz()` is a GraphQL Yoga plugin: batches from the laguz client stream field by field and forward `ref()` values through Yoga's own context, validation and execution, so its plugins (auth, limits, tracing, masked errors) still apply; other requests are left to Yoga. `toNodeHandler` from `@laguzjs/server/node` mounts `createHandler` on Node's http server, Express or Fastify, streaming each result as it is written and closing the results when the client goes away.
