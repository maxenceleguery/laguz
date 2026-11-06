# @laguzjs/client

## 0.2.0

### Minor Changes

- 92efa20: Automatic refetching. In browsers, pools refetch the entries in use that are older than `staleTime`, and retry failed ones, when the tab becomes visible again (`refetchOnFocus`) and when the network comes back (`refetchOnReconnect`), in one request; both default to true. `useData` and `useInfiniteData` take `refetchInterval` to poll while mounted, paused while the tab is hidden; entries polled at the same interval share one request. `pool.watch` takes an options object (`{ minStaleTime, refetchInterval }`) instead of a minimum stale time.
- 5b40d40: Request cancellation. The pool aborts a request once nothing waits for any of its pending fields (the components unmounted, or an invalidation replaced them), checked at the end of the task so StrictMode's remount keeps it. Aborted requests report no error, aren't retried and don't use up retries. Fetchers receive `options.signal`, which `httpFetcher` passes to `fetch` (combined with `init.signal`). On the server, cancelling a streamed response closes its results.
- 74a27cf: Devtools. `LaguzDevtools` from `@laguzjs/client/devtools` is a panel that lists each request a pool sends, with when each of its fields arrived, and each cache entry with its status, readers, age and data, with refetch and invalidate buttons. It renders in the browser only, after hydration. It is built on two new pool methods: `pool.inspect()` reports the cache entry by entry, and `pool.observe(listener)` follows each request's start, results and outcome, at no cost until something observes.
- f7a340f: Enum arguments: `enumValue("DESC")` prints as `DESC` instead of a quoted string, in root and field arguments, inside input objects and lists. The server now types values forwarded through `ref()` by the argument they fill, so a referenced enum field can feed an enum argument.
- cd09909: `httpFetcher` options: `headers` can be a function, sync or async, that runs before each request (fresh auth tokens), `init` passes other `fetch` options such as `credentials`, and `fetch` replaces the global one. A response that isn't JSON, such as a proxy's error page, now fails with its HTTP status instead of a JSON parse error.
- 623b434: In development, the pool warns when a hydrated entry has to be fetched right after hydration: the server loaded fewer fields than the components read (the warning names them), or the data was already older than `staleTime`.
- cd7c068: `keepPrevious`: `useData` and `useInfiniteData` can keep returning the previous arguments' data, flagged with `previous: true`, while new arguments load, instead of emptying the screen on every filter or search change. `useInfiniteData` now starts over at one page when the first page's arguments change, instead of refetching as many pages as were shown, one after the other.
- 51e04d9: Typed mutations. `laguz-types` adds the mutation type to `Schema`. `pool.mutate(name, args, fields, options)` sends `mutation { name(args) { fields } }` on its own, never retried, and resolves to the selected data; a GraphQL error rejects with the server's message. The `useMutation` hook returns `{ mutate, data, error, pending, reset }` for a schema mutation or any async function, with optimistic writes and invalidations that can depend on the variables. `pool.load` is now typed by the schema too.
- b22c845: `operationName: (roots, type) => name` names the operations a pool sends, `query <name> { ... }` and `mutation <name> { ... }`, from their root fields, so server logs and tracing can tell batches apart. An invalid name fails the fields of that request. Named batches are still split, streamed and forwarded by `@laguzjs/server`.
- cd08925: `createPoolContext(create)` returns `PoolProvider`, `Hydrate`, `usePool` and `useData`, `useSuspenseData`, `useInfiniteData` and `useMutation` bound to the provided pool, replacing the context code every server-rendered app wrote by hand. The provider creates one pool per mount, so per request on the server and per page load in the browser, and hydrates it from its `state` prop.
- 941d345: Queries defined once: `queries<Schema>()` returns a typed factory of query descriptors (`{ root, args, fields }`), checked and autocompleted where they are defined. `useData`, `useSuspenseData` and `pool.load` take a descriptor in place of `root, args, fields` (`null` skips in `useData`), and `useInfiniteData` pages can be descriptors, so a server load and the components that read it always build the same entry.
- 82908f5: Background refresh state. `useData` and `useInfiniteData` return `fetching`, true while data already shown is refreshed (retries included; a first load is `loading`), and `refetch()`, which refreshes the entry or every loaded page while the data stays on screen. Snapshots carry `fetching`. `pool.invalidate(root, args)` targets a single entry.
- 93fdc82: Server rendering. The hooks no longer throw during a server render: `useSyncExternalStore` was missing its server snapshot. `pool.dehydrate()` returns the loaded entries as JSON-safe values and `pool.hydrate(state)` adds them to another pool, keeping newer data and the fields only the browser loaded; `useHydrate(pool, state)` hydrates during render. Without a `window`, pools default to `gcTime: Infinity` and `retry: 0`, so a server request never waits on retries or leaves timers behind. `gcTime: Infinity` used to collect entries at once.
- d2b44c0: Streaming server rendering. `createPoolContext(create, { useServerInsertedHTML })`, given Next's hook from `next/navigation`, streams the data `useSuspenseData` loads during the server render to the browser with the HTML: each flush carries the entries settled since the last one, and the browser pool hydrates from them before React hydrates the content that uses them. Pages need no server-side prefetch; data already hydrated from props isn't sent again.
- eaafd09: Typed results. `laguz-types` (in `@laguzjs/server`, also available as `generateTypes`) generates TypeScript types from an SDL file, an introspection result or a running endpoint. With `createPool<Schema>(fetcher)`, `useData` and `useSuspenseData` type-check the root field, its arguments and the selection, autocomplete field names, and return the selected shape. `enumValue()` is now typed by the value it receives. Pools created without a schema behave as before; the hooks no longer take an explicit result type parameter (`useData<T>(...)`).

### Patch Changes

- eb3c5b4: `localFetcher({ schema, rootValue, context })` in `@laguzjs/server` is a fetcher for `createPool` that runs queries in-process: for tests and stories with real GraphQL validation and execution, and for server components when the schema lives in the same app. `context` runs once per batch. The client's `Response` type accepts graphql-js results as they are (readonly `errors` and `path`), so no cast is needed.

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

Initial release.
