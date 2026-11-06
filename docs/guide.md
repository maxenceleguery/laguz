# Guide

## How batching works

A component asks for data with a hook. Instead of sending a request, the hook
registers what it needs with a shared **pool**. At the end of the current task
the pool sends one GraphQL query with everything that was registered.

In React, every component of a commit subscribes in the same synchronous pass,
so the batch boundary is the commit itself: no timer, no added delay. Outside
React, a batch is everything registered before the JavaScript stack empties.

The pool composes the query from what it knows:

- Requests for the same root field with the same arguments are merged into one
  aliased field with the union of their selections.
- A field that is already cached or already in flight is not requested again.
  A component mounting later only fetches what's missing.
- If a missing field sits inside a list that is already cached, the whole
  selection is refetched: two fetches of a list can't be merged by position if
  the list changed in between.

```graphql
{
  q0: user(id: 1) {
    name
    avatar_1kc87rv: avatar(size: 128)
  }
  q1: stats {
    revenue
  }
}
```

The response is dispatched per field. With `@laguzjs/server` and
`httpFetcher(url, { stream: true })`, each root field arrives on its own line as
soon as it resolves, so one slow field doesn't hold back the rest.

## Creating a pool

```ts
import { createPool, httpFetcher } from "@laguzjs/client";

const pool = createPool(httpFetcher("/graphql", { stream: true }), {
  staleTime: 0,
});
```

| Option       | Default                     | Meaning                                                                                                  |
| ------------ | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `staleTime`  | `0`                         | Milliseconds before cached data is refetched when a new consumer mounts. Cached data is shown meanwhile. |
| `gcTime`     | `300000`                    | Milliseconds an entry without consumers stays in the cache.                                              |
| `retry`      | `3`                         | Retries before an error is reported. Fields that fail together are retried together.                     |
| `retryDelay` | exponential, capped at 30 s | `(attempt) => ms`.                                                                                       |
| `maxBatch`   | unlimited                   | Maximum root fields per request, for servers that cap aliases.                                           |
| `serverRefs` | `"auto"`                    | Whether the server resolves `ref()` arguments. See [Dependent queries](#dependent-queries).              |

`httpFetcher(url, { stream, headers })` POSTs `{ query }` as JSON. Any function
`(query) => Promise<Response> | AsyncIterable<Response>` works as a fetcher, so
you can bring your own transport.

## Selecting fields

Hooks take a root field, its arguments and a selection:

```ts
useData(pool, "user", { id: 1 }, [
  "name", // a scalar
  { projects: ["id", "name"] }, // a nested selection
  { avatar: { args: { size: 64 } } }, // a field with arguments
  { recent: { field: "projects", args: { first: 3 }, fields: ["id"] } }, // renamed
]);
```

Each component receives only what it selected, under its own names, even when
the entry it reads from was merged with other components' selections.

Fields with arguments are sent under a stable alias (`avatar_1kc87rv`), so two
components can select the same field with different arguments. If you write to
the cache by hand, `fieldKey("avatar", { size: 64 })` gives you that key.

Argument values are printed as GraphQL literals. Object keys are sorted, so
`{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` share a cache entry. `undefined` values are
dropped and dates are printed with `toJSON()`. Enum values aren't supported yet.

## React hooks

All hooks come from `@laguzjs/client/react`.

### `useData(pool, root, args, fields)`

Returns `{ data, error, loading }`. Pass `args: null` to skip the query.

```tsx
const { data: user } = useData(pool, "user", { id }, ["teamId"]);
const { data: team } = useData(pool, "team", user ? { id: user.teamId } : null, ["name"]);
```

### `useSuspenseData(pool, root, args, fields)`

Returns the data, suspends while it loads, and throws errors to the nearest
error boundary. Call `pool.invalidate(root)` when the boundary resets to retry.

Wrap each component in its own `<Suspense>`. When a component suspends, React
stops rendering its siblings inside the same boundary and renders them later,
so components sharing a boundary are fetched in two requests instead of one.
React also reveals Suspense content in batches about 300 ms apart, whatever the
data layer; use `useData` where the fastest first paint matters.

### `useInfiniteData(pool, page, { prefetch })`

Cursor or offset pagination. `page(previous, index)` returns the selection for
page `index`, built from the data of the previous page, or `null` after the
last page.

```tsx
const fields = [{ edges: [{ node: ["id", "text"] }] }, { pageInfo: ["endCursor", "hasNextPage"] }];

const { pages, loadMore, hasMore, loading, loadingMore, error } = useInfiniteData(
  pool,
  (prev, i) =>
    i === 0 || prev?.pageInfo.hasNextPage
      ? { root: "feed", args: { first: 20, after: prev?.pageInfo.endCursor }, fields }
      : null,
  { prefetch: 1 },
);
```

Each page is an ordinary cache entry. A refresh refetches every loaded page in
one request; if a cursor moved as a result, the pages after it are fetched
right after. `prefetch: n` keeps `n` pages loaded ahead of what's shown, so
`loadMore()` displays the next page immediately.

## Dependent queries

When an argument comes from another query's result, describe it with `ref`:

```ts
import { ref } from "@laguzjs/client";

const teamId = ref("user", { id: 1 }, "teamId");
const leadId = ref("team", { id: teamId }, "leadId");
useData(pool, "user", { id: leadId }, ["name"]);
```

`ref(root, args, path)` points at a plain field (no arguments) of another root
field; `path` can be nested (`"team.id"`). The pool subscribes to that field on
your behalf.

- **Against any GraphQL server**, the pool waits until the value is known and
  then sends the dependent query with the literal value: one round trip per
  level, like chaining queries by hand.
- **Against `@laguzjs/server`**, the dependency and the dependent go in the same
  request. The dependent's argument is a placeholder that the server fills in
  once the dependency resolves: one round trip for the whole chain.

With `serverRefs: "auto"` (the default) the pool starts in the first mode and
switches once a response carries the server's protocol marker. Set
`serverRefs: true` to skip that first round when you know the server supports
it, or `false` to never forward.

When a dependency's value changes, the dependent refetches. When a dependency
fails, the dependent reports the same error.

## Mutations and cache updates

```ts
await pool.mutate(() => api.renameUser(1, "Ada"), {
  optimistic: [["user", { id: 1 }, (user) => ({ ...user, name: "Ada" })]],
  invalidate: ["user", (root, args) => root === "team"],
});
```

`mutate(run, options)` applies the optimistic writes at once, runs the
mutation, rolls the writes back if it throws, and invalidates the matching
entries either way. The invalidated entries that are on screen refetch
together, in one request.

The building blocks are available on their own:

| Method                                     | Does                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `pool.invalidate(match?)`                  | Marks matching entries stale (all if omitted). Entries in use refetch in one request.             |
| `pool.set(root, args, fn)`                 | Writes `fn(data)` to the cache and drops in-flight reads of that entry. Returns an undo function. |
| `pool.load(root, args, fields)`            | Fetches without staying subscribed (prefetching). Resolves when the data is ready or failed.      |
| `pool.watch(root, args, fields, callback)` | Subscribes outside React. Returns the unsubscribe function.                                       |
| `pool.read(root, args)`                    | The current snapshot `{ data, error, has }`.                                                      |

To refetch when the tab regains focus:

```ts
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pool.invalidate();
});
```

## Server

```ts
import { batchLoader, createHandler } from "@laguzjs/server";

const handler = createHandler({
  schema,
  rootValue,
  context: (request) => ({ users: batchLoader((ids) => db.users.findMany(ids)) }),
});
```

`createHandler` returns `(request: Request) => Promise<Response>`. It answers
with NDJSON when the client accepts `application/x-ndjson`, and with one merged
JSON response otherwise. Either way, each root field is validated and executed
on its own, so an invalid field fails alone, and `ref` placeholders are
resolved.

`context` runs once per request. Put your loaders there: every field of the
batch shares them, so lookups made by different components still end up in a
single database query. `batchLoader` is a small DataLoader; the `dataloader`
package works the same way.

If your server already has its own `execute` and `validate` (envelop, Yoga),
pass them so its plugins keep running:

```ts
createHandler({ schema, execute: envelopExecute, validate: envelopValidate });
```

Lower-level pieces, for other server setups:

| Export                  | Does                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `splitExecute(options)` | Async iterator of one `ExecutionResult` per root field, in completion order. |
| `merged(results)`       | Folds those results into one standard response.                              |
| `ndjson(results)`       | A streaming `Response` with one JSON line per result.                        |

### Compression

`ndjson()` doesn't compress. Whatever compresses the response downstream has to
flush after every line: gzip and brotli buffer their input, and without a flush
the client receives the whole stream at the end. If you compress in the
application, call `flush()` on the compressor after each write (the benchmark
server in `bench/server.ts` does). Behind nginx, disable `proxy_buffering` and
`gzip` for the GraphQL location rather than relying on nginx to flush.

## Compared with TanStack Query

|                        | TanStack Query                      | laguz                                                                        |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Requests               | one per query                       | one per commit, merged by root field and arguments                           |
| Stale-while-revalidate | `staleTime`                         | `staleTime`; the merged entry refetches as a whole                           |
| Retries                | 3, exponential backoff              | 3, exponential backoff, batched                                              |
| Optimistic updates     | `onMutate` with manual rollback     | `pool.mutate` with `optimistic` and automatic rollback                       |
| Invalidation           | one request per query               | one request for everything invalidated                                       |
| Dependent queries      | `enabled`, one round trip per level | `null` arguments, or `ref()`: one round trip with the server package         |
| Infinite queries       | pages refetched one after the other | all pages in one request, optional prefetch                                  |
| Suspense               | `useSuspenseQuery`                  | `useSuspenseData`, one boundary per component                                |
| Not available yet      |                                     | keeping previous data while arguments change, devtools, request cancellation |

## Limitations

- Without the server package, a batch is only as fast as its slowest field.
- Composed queries change with what is on screen, so they can't be persisted
  queries or cached per URL by a CDN.
- Server limits on aliases or query cost apply to the whole batch. Use
  `maxBatch` to split large batches. Batches that forward refs are never split.
- Refs live in root field arguments and point at fields without arguments.
- Enum arguments are not supported yet.
