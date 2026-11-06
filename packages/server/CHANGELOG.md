# @laguzjs/server

## 0.2.0

### Minor Changes

- f7a340f: Enum arguments: `enumValue("DESC")` prints as `DESC` instead of a quoted string, in root and field arguments, inside input objects and lists. The server now types values forwarded through `ref()` by the argument they fill, so a referenced enum field can feed an enum argument.
- eb3c5b4: `localFetcher({ schema, rootValue, context })` in `@laguzjs/server` is a fetcher for `createPool` that runs queries in-process: for tests and stories with real GraphQL validation and execution, and for server components when the schema lives in the same app. `context` runs once per batch. The client's `Response` type accepts graphql-js results as they are (readonly `errors` and `path`), so no cast is needed.
- 51e04d9: Typed mutations. `laguz-types` adds the mutation type to `Schema`. `pool.mutate(name, args, fields, options)` sends `mutation { name(args) { fields } }` on its own, never retried, and resolves to the selected data; a GraphQL error rejects with the server's message. The `useMutation` hook returns `{ mutate, data, error, pending, reset }` for a schema mutation or any async function, with optimistic writes and invalidations that can depend on the variables. `pool.load` is now typed by the schema too.
- 69b0cfc: Server integrations. `useLaguz()` is a GraphQL Yoga plugin: batches from the laguz client stream field by field and forward `ref()` values through Yoga's own context, validation and execution, so its plugins (auth, limits, tracing, masked errors) still apply; other requests are left to Yoga. `toNodeHandler` from `@laguzjs/server/node` mounts `createHandler` on Node's http server, Express or Fastify, streaming each result as it is written and closing the results when the client goes away.
- eaafd09: Typed results. `laguz-types` (in `@laguzjs/server`, also available as `generateTypes`) generates TypeScript types from an SDL file, an introspection result or a running endpoint. With `createPool<Schema>(fetcher)`, `useData` and `useSuspenseData` type-check the root field, its arguments and the selection, autocomplete field names, and return the selected shape. `enumValue()` is now typed by the value it receives. Pools created without a schema behave as before; the hooks no longer take an explicit result type parameter (`useData<T>(...)`).
- ac71c03: `laguz-types --header "Name: value"` (repeatable) sends headers with the introspection query, for endpoints that need a key, such as Supabase or Hasura. An endpoint answering with something else than JSON now fails with its HTTP status.
- 574bef0: `laguz-types --watch` regenerates the types whenever the schema file changes. It rewrites the output only when the types change, keeps watching through a schema saved halfway through an edit, and follows editors that save by renaming a new file over the old one.

### Patch Changes

- 5b40d40: Request cancellation. The pool aborts a request once nothing waits for any of its pending fields (the components unmounted, or an invalidation replaced them), checked at the end of the task so StrictMode's remount keeps it. Aborted requests report no error, aren't retried and don't use up retries. Fetchers receive `options.signal`, which `httpFetcher` passes to `fetch` (combined with `init.signal`). On the server, cancelling a streamed response closes its results.
- 0e0c15c: `createHandler` passes `variables` and `operationName` from the request body to `execute`, so mutations and other ordinary GraphQL requests work on the same endpoint. It answers 400 when `variables` is not an object or `operationName` not a string.
- a3b9382: `laguz-types --watch` no longer depends on the file names in file system events, which macOS can report as the temporary file of a rename-over save: any change in the schema's directory rereads it, and only a new text regenerates the types, so the same error isn't printed again for unrelated changes.
- 8a9e3e8: `laguz-types --watch` starts watching before its first generation, so a save made while it starts isn't missed.

## 0.1.2

### Patch Changes

- 0b5c999: Validate a batch once instead of once per root field, and cache parsed and validated documents. A repeated 19-field query now costs about a third of the CPU of graphql-js's `graphql()`, down from five times as much. An exception thrown by a custom `execute` now fails only its field.

## 0.1.1

### Patch Changes

- 3c3a296: `createHandler` answers 400 when the body isn't JSON or has no `query` string, and 405 for methods other than POST, instead of throwing.

## 0.1.0

Initial release.
