---
"@laguzjs/server": minor
"@laguzjs/client": patch
---

`localFetcher({ schema, rootValue, context })` in `@laguzjs/server` is a fetcher for `createPool` that runs queries in-process: for tests and stories with real GraphQL validation and execution, and for server components when the schema lives in the same app. `context` runs once per batch. The client's `Response` type accepts graphql-js results as they are (readonly `errors` and `path`), so no cast is needed.
