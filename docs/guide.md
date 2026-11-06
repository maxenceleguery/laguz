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

| Option               | Default                     | Meaning                                                                                                                       |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `staleTime`          | `0`                         | Milliseconds before cached data is refetched when a new consumer mounts. Cached data is shown meanwhile.                      |
| `gcTime`             | `300000`, server `Infinity` | Milliseconds an entry without consumers stays in the cache.                                                                   |
| `retry`              | `3`, server `0`             | Retries before an error is reported. Fields that fail together are retried together.                                          |
| `retryDelay`         | exponential, capped at 30 s | `(attempt) => ms`.                                                                                                            |
| `maxBatch`           | unlimited                   | Maximum root fields per request, for servers that cap aliases.                                                                |
| `serverRefs`         | `"auto"`                    | Whether the server resolves `ref()` arguments. See [Dependent queries](#dependent-queries).                                   |
| `refetchOnFocus`     | `true` in browsers          | When the tab becomes visible again, refetch the entries in use older than `staleTime`, and retry failed ones, in one request. |
| `refetchOnReconnect` | `true` in browsers          | The same when the network comes back.                                                                                         |
| `operationName`      | unnamed                     | `(roots, type) => name`: names each request (`query Load_user { ... }`) for server logs and tracing.                          |

`httpFetcher(url, options)` POSTs `{ query }` as JSON:

| Option    | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `stream`  | Ask for one NDJSON line per root field. Falls back to JSON if the server doesn't stream. |
| `headers` | Headers, or a function (sync or async) that runs before each request.                    |
| `init`    | Other `fetch` options, such as `credentials: "include"` for cookies on another origin.   |
| `fetch`   | Replaces the global `fetch`.                                                             |

```ts
const fetcher = httpFetcher("/graphql", {
  stream: true,
  // Read on every request, so a refreshed token is picked up.
  headers: async () => ({ authorization: `Bearer ${await auth.token()}` }),
});
```

A response that isn't JSON, such as a proxy's error page, fails with its HTTP
status instead of a parse error. Any function
`(query, { signal }) => Promise<Response> | AsyncIterable<Response>` works as a
fetcher, so you can bring your own transport.

### Cancellation

A request is aborted once nothing waits for any of its pending fields: the
components that asked for them unmounted, or an invalidation replaced them.
The check runs at the end of the task, so a component that unmounts and mounts
again right away (React's StrictMode, a quick remount) keeps its request. An
aborted request reports no error and isn't retried; the data is fetched again
if a component asks for it later. Mutations are never aborted.

The pool passes an `AbortSignal` as `options.signal` to the fetcher, and
`httpFetcher` hands it to `fetch`. A fetcher that wraps another must pass the
options on:

```ts
const logged: Fetcher = (query, options) => {
  console.debug(query);
  return http(query, options);
};
```

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
dropped and dates are printed with `toJSON()`. Strings always print quoted; wrap
enum values with `enumValue`:

```ts
import { enumValue } from "@laguzjs/client";

useData(
  pool,
  "issues",
  { orderBy: { field: enumValue("CREATED_AT"), direction: enumValue("DESC") } },
  ["id", "title"],
);
```

Values forwarded by `@laguzjs/server` through `ref()` are typed by the argument
they fill, so a referenced enum field can feed an enum argument.

## Typed results

Generate TypeScript types from your schema once, and again whenever it changes.
`laguz-types` ships with `@laguzjs/server` and reads an SDL file, an
introspection result, or a running endpoint:

```sh
npx laguz-types schema.graphql -o src/schema.generated.ts --scalar DateTime=string
npx laguz-types https://api.example.com/graphql -o src/schema.generated.ts
```

An endpoint that needs a key takes `--header "Name: value"` (repeatable); see
the [recipes](recipes.md) for Supabase and Hasura. With `--watch`, it
regenerates whenever the schema file changes, next to your dev server. The file is only rewritten when the types change, and a schema
saved halfway through an edit prints its error without stopping the watch.

Create the pool with the generated `Schema`:

```ts
import type { Schema } from "./schema.generated";

const pool = createPool<Schema>(httpFetcher("/graphql", { stream: true }));

const { data } = useData(pool, "user", { id: 1 }, [
  "name",
  { projects: { args: { first: 3 }, fields: ["id", "name"] } },
]);
// data: { name: string; projects: { id: string; name: string }[] } | null | undefined
```

Root fields, their arguments, field names and field arguments are checked, and
editors autocomplete field names inside the selection. The same goes for
`pool.load`, and for mutations in `pool.mutate` and `useMutation`. Object fields need a
nested selection. Enum arguments take `enumValue()` of one of the enum's
values. Custom scalars are `unknown` unless mapped with `--scalar`.

On a union or an interface, only the fields shared by every member can be
selected, since laguz doesn't send fragments. Without a schema type, pools and
hooks accept any selection and return `any`.

## Queries defined once

`queries<Schema>()` returns a typed factory of query descriptors, so a query is
written once, checked and autocompleted where it is defined, and used
everywhere:

```ts
// queries.ts
import { queries } from "@laguzjs/client";
import type { Schema } from "./schema.generated";

const query = queries<Schema>();
export const user = (id: string) => query("user", { id }, ["name", "email"]);
export const postsBy = (id: string) => query("posts", { author: id }, ["id", "title"]);
```

```tsx
await pool.load(user(id)); // a server component, or a prefetch
const { data } = useData(pool, user(id)); // a component; data is typed
const { data: posts } = useData(pool, open ? postsBy(id) : null); // null skips
```

`useData`, `useSuspenseData` and `pool.load` take a descriptor in place of
`root, args, fields`, and a page function of `useInfiniteData` can return one.
The cache finds an entry by its root field and arguments, so a server load and
a component built from the same descriptor always meet; that is what makes
server rendering cover the page.

## React hooks

All hooks come from `@laguzjs/client/react`.

### A pool in context

`createPoolContext(create)` returns a provider and hooks bound to its pool, so
components don't pass the pool around:

```tsx
export const {
  PoolProvider,
  Hydrate,
  usePool,
  useData,
  useSuspenseData,
  useInfiniteData,
  useMutation,
} = createPoolContext(() => createPool<Schema>(fetcher));

function Profile({ id }: { id: string }) {
  const { data } = useData(user(id)); // a query from queries<Schema>()
  const rename = useMutation("renameUser", ["name"]);
}
```

`PoolProvider` creates the pool once per mount: once per request when React
renders on the server, so users never share a cache, and once per page load in
the browser. Its `state` prop hydrates the pool; `Hydrate` does the same deeper
in the tree. The bound `useData` and `useSuspenseData` take queries from
`queries<Schema>()`; the hooks below take the pool as their first argument and
work without a context.

### `useData(pool, root, args, fields)`

Returns `{ data, error, loading, previous, fetching, refetch }`. Pass
`args: null` to skip the query.

```tsx
const { data: user } = useData(pool, "user", { id }, ["teamId"]);
const { data: team } = useData(pool, "team", user ? { id: user.teamId } : null, ["name"]);
```

With `{ keepPrevious: true }` as a fifth argument, `data` keeps the result of
the previous arguments while the new ones load or are `null`, and `previous`
is true. Use it for filters, search and pagination, where emptying the screen
on every change would flicker. An error replaces the previous data.

`{ refetchInterval: ms }` polls while the component is mounted, except when the
tab is hidden. Everything polled at the same interval, across components,
shares one request per tick.

`loading` means there is no data to show yet. `fetching` means data is shown
and a refresh is in flight, retries included: use it for a discreet spinner.
`refetch()` refreshes this entry; the data stays on screen meanwhile.

### `useSuspenseData(pool, root, args, fields)`

Returns the data, suspends while it loads, and throws errors to the nearest
error boundary. Call `pool.invalidate(root)` when the boundary resets to retry.

Wrap each component in its own `<Suspense>`. When a component suspends, React
stops rendering its siblings inside the same boundary and renders them later,
so components sharing a boundary are fetched in two requests instead of one.
React also reveals Suspense content in batches about 300 ms apart, whatever the
data layer; use `useData` where the fastest first paint matters.

To keep the current content on screen while new arguments load, change them
inside `startTransition`: React then waits instead of showing the fallback.

### `useInfiniteData(pool, page, { prefetch, keepPrevious })`

Cursor or offset pagination. `page(previous, index)` returns the selection for
page `index`, built from the data of the previous page, or `null` after the
last page.

```tsx
const fields = [{ edges: [{ node: ["id", "text"] }] }, { pageInfo: ["endCursor", "hasNextPage"] }];

const { pages, loadMore, hasMore, loading, loadingMore, fetching, refetch, error } =
  useInfiniteData(
    pool,
    (prev, i) =>
      i === 0 || prev?.pageInfo.hasNextPage
        ? { root: "feed", args: { first: 20, after: prev?.pageInfo.endCursor }, fields }
        : null,
    { prefetch: 1 },
  );
```

Each page is an ordinary cache entry. A refresh (`refetch()`, or invalidating
the root field) refetches every loaded page in one request; if a cursor moved
as a result, the pages after it are fetched right after. `prefetch: n` keeps `n` pages loaded ahead of what's shown, so
`loadMore()` displays the next page immediately.

When the first page's arguments change (a new filter), it is another list,
and the hook starts over at one page. `keepPrevious: true` keeps the current
pages, with `previous: true`, until the new first page arrives.

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

`useMutation` runs a mutation of the schema and tracks its state:

```tsx
const rename = useMutation(pool, "renameUser", ["id", "name"], (vars) => ({
  optimistic: [["user", { id: vars.id }, (user) => ({ ...user, name: vars.name })]],
  invalidate: ["users"],
}));

return (
  <>
    <button disabled={rename.pending} onClick={() => rename.mutate({ id, name })}>
      Rename
    </button>
    {rename.error && <p role="alert">{rename.error.message}</p>}
  </>
);
```

It returns `{ mutate, data, error, pending, reset }`. With a typed pool, the
mutation name, its variables and the selection are checked and `data` has the
selected shape. `mutate(vars)` returns a promise of the result that rejects on
failure, but the error also lands in `error`, so an event handler can call it
without catching. When calls overlap, the latest one sets the state. Instead
of a mutation name, `useMutation(pool, run, options)` takes any async function:
a server action, a REST call.

The options can be an object, or a function of the variables. Optimistic writes
apply at once and roll back if the mutation fails; the `invalidate` matches
refetch afterwards either way, together, in one request.

Outside React, `pool.mutate` does the same and resolves to the result:

```ts
const user = await pool.mutate("renameUser", { id: 1, name: "Ada" }, ["name"], {
  invalidate: ["users", (root, args) => root === "team"],
});
await pool.mutate(() => api.archive(1), { invalidate: ["projects"] });
```

A mutation is sent on its own as `mutation { field(args) { fields } }`, right
away rather than at the end of the task, and is never retried. Its arguments
are inline literals like a query's, so any fetcher works; `ref()` is only for
queries. A GraphQL error rejects with the server's message.

The building blocks are available on their own:

| Method                                     | Does                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pool.invalidate(match?, args?)`           | Marks matching entries stale: all, a root field, a predicate, or with `args` one entry. Entries in use refetch in one request. |
| `pool.set(root, args, fn)`                 | Writes `fn(data)` to the cache and drops in-flight reads of that entry. Returns an undo function.                              |
| `pool.load(root, args, fields)`            | Fetches without staying subscribed (prefetching). Resolves when the data is ready or failed.                                   |
| `pool.watch(root, args, fields, callback)` | Subscribes outside React. Returns the unsubscribe function.                                                                    |
| `pool.read(root, args)`                    | The current snapshot `{ data, error, has }`.                                                                                   |
| `pool.inspect()`                           | The cache, entry by entry: status, readers, age, data.                                                                         |
| `pool.observe(listener)`                   | Follows each request: its start, its fields as they arrive, how it ended. Returns the function that stops it.                  |

## Server rendering

Load the page's data on the server, send it along with the HTML, and hydrate
the browser's pool with it before the components render. With the Next.js App
Router, the browser pool lives in a client module, created with
`createPoolContext` (see [A pool in context](#a-pool-in-context)):

```tsx
// app/pool.tsx
"use client";
import { createPool, httpFetcher } from "@laguzjs/client";
import { createPoolContext } from "@laguzjs/client/react";
import type { Schema } from "./schema.generated";

export const { PoolProvider, Hydrate, useData, useMutation } = createPoolContext(() =>
  createPool<Schema>(httpFetcher("/graphql", { stream: true }), { staleTime: 60_000 }),
);
```

Put `<PoolProvider>` in the root layout, and `<Hydrate state={...}>` in each
page that loads data on the server.

A server component loads the data and passes it down. With the queries defined
once (see [Queries defined once](#queries-defined-once)), the server loads
exactly what the components read:

```tsx
// app/users/[id]/page.tsx
import { createPool, httpFetcher } from "@laguzjs/client";
import { Hydrate } from "../../pool";
import { postsBy, user } from "../../queries";
import type { Schema } from "../../schema.generated";

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // localFetcher from @laguzjs/server instead, when the schema lives in this app.
  const pool = createPool<Schema>(httpFetcher(process.env.GRAPHQL_URL!));
  // Loads started together go out as one request.
  await Promise.all([pool.load(user(id)), pool.load(postsBy(id))]);
  return (
    <Hydrate state={pool.dehydrate()}>
      <Profile id={id} />
    </Hydrate>
  );
}
```

- `pool.dehydrate()` returns the loaded entries as JSON-safe values. Entries
  that failed are left out, and the browser fetches them.
- `pool.hydrate(state)` adds them to a pool. Entries the pool has newer data
  for are kept, so it is safe to call on every navigation. `useHydrate(pool,
  state)` calls it during render, before the components below read the pool.
- Create a pool per request on the server: a pool holds the data of the user
  who made the request. Without a `window`, pools default to `gcTime: Infinity`
  and `retry: 0`, so a request never waits on retries or leaves timers behind.
- Hydrated entries keep the time they were loaded. With `staleTime: 0` the
  browser refetches them as soon as the components mount, in one request.
- Fields the components select but the server didn't load are fetched after
  hydration, in one request. `useSuspenseData` fetches during the server render
  instead, so load what it reads.
- In development, the browser pool warns when it has to fetch a hydrated entry
  right after hydration: the server loaded fewer fields than the components
  read, or the data was already older than `staleTime`. Entries the server
  didn't load at all are not reported, since that can be on purpose.
- If you write the state into a `<script>` tag yourself, escape `<` in the
  JSON. Frameworks that pass props from server to client components do it for
  you.

### Streaming, without loading first

Instead of loading each page's queries in a server component, the components
can suspend on them while the server renders, and the data streams to the
browser with the HTML. Give `createPoolContext` Next's `useServerInsertedHTML`:

```tsx
// app/pool.tsx
"use client";
import { createPool, httpFetcher } from "@laguzjs/client";
import { createPoolContext } from "@laguzjs/client/react";
import { useServerInsertedHTML } from "next/navigation";
import type { Schema } from "./schema.generated";

// Client components render on the server too, where only an absolute URL works.
const url = typeof window === "undefined" ? `${process.env.SITE_URL}/graphql` : "/graphql";

export const { PoolProvider, useSuspenseData } = createPoolContext(
  () => createPool<Schema>(httpFetcher(url, { stream: true }), { staleTime: 30_000 }),
  { useServerInsertedHTML },
);
```

```tsx
// a client component: no server component loads it first
function Issue({ id }: { id: string }) {
  const issue = useSuspenseData(issueQuery(id));
  return <h1>{issue.title}</h1>;
}

<Suspense fallback={<p>Loading…</p>}>
  <Issue id={id} />
</Suspense>;
```

While Next streams the page, each flush of HTML carries a script with the data
that settled since the last one, placed before the content that uses it. In
the browser, the provider hydrates its pool from those scripts before React
hydrates that content, so nothing is fetched twice. Data already hydrated from
props is not sent again.

- Only `useSuspenseData` loads during the server render; `useData` renders its
  loading state there and fetches in the browser.
- Components that suspend in the same pass share one request. A component
  suspends on the first query it lacks, so one that reads two queries fetches
  them one after the other: split it, one query per component.
- Client components can't read the request's cookies while the server renders
  them. For data that depends on the user, load it in a server component and
  pass it with `Hydrate`.
- On client-side navigations, Next doesn't render client components on the
  server: the components fetch in the browser, in one request.

The [Next.js example](../examples/nextjs) puts this together: its board loads
in a server component, its issue page streams.

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

Other requests run as one document, the way any GraphQL server runs them:
mutations, documents with variables or fragments, and `operationName`. Other
clients (GraphiQL, your mutations) can share the endpoint.

`context` runs once per request. Put your loaders there: every field of the
batch shares them, so lookups made by different components still end up in a
single database query. `batchLoader` is a small DataLoader; the `dataloader`
package works the same way.

When the client cancels a streamed request, the handler stops reading the
remaining results. To stop the database work too, give `req.signal` to your
loaders: `context: (req) => ({ users: usersLoader(req.signal) })`.

If your server already has its own `execute` and `validate` (envelop, Yoga),
pass them so its plugins keep running:

```ts
createHandler({ schema, execute: envelopExecute, validate: envelopValidate });
```

### With GraphQL Yoga

Keep your Yoga server and add the plugin:

```ts
import { useLaguz } from "@laguzjs/server";
import { createYoga } from "graphql-yoga";

const yoga = createYoga({ schema, context, plugins: [useLaguz()] });
```

Batches from the laguz client (they ask for NDJSON, or carry `ref()`
placeholders) then stream field by field and forward references, through
Yoga's own context, validation and execution: its plugins, such as auth,
query limits, tracing and masked errors, still apply. Other requests, from
GraphiQL or another client, are left to Yoga.

### With Express, Fastify or Node's http server

`toNodeHandler` from `@laguzjs/server/node` mounts `createHandler` where
handlers take Node's `req` and `res`. It streams each result as it is written,
uses a body that `express.json()` has already read, and stops reading the
results when the client goes away:

```ts
import { createHandler } from "@laguzjs/server";
import { toNodeHandler } from "@laguzjs/server/node";

app.post("/graphql/laguz", toNodeHandler(createHandler({ schema, context })));
```

With Apollo Server, mount it on its own route next to Apollo's, with the same
schema and the same context function, and point the laguz client at it. Apollo
Server's plugins don't run for those requests.

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

## Devtools

`LaguzDevtools` shows what a pool sends and holds, in your app:

```tsx
import { LaguzDevtools } from "@laguzjs/client/devtools";

{
  process.env.NODE_ENV === "development" && <LaguzDevtools pool={pool} />;
}
```

The requests tab lists each request with its root fields, its duration and how
it ended; open one to see the query and when each field arrived, which shows
streaming at work. The cache tab lists each entry with its status (loading,
ready, refreshing, stale, failed), its readers and its age; open one for its
data and a refetch button. The panel renders in the browser only, after
hydration, and is built on `pool.inspect()` and `pool.observe()`, which cost
nothing until something observes the pool. Props: `initialOpen`, `position`
(a corner), `limit` (requests kept, 50 by default).

## Testing

`localFetcher` from `@laguzjs/server` runs queries in-process against your
schema, with resolvers you write for the test:

```tsx
import { createPool } from "@laguzjs/client";
import { localFetcher } from "@laguzjs/server";
import { buildSchema } from "graphql";

const schema = buildSchema(sdl); // the SDL you generate types from
const pool = createPool<Schema>(
  localFetcher({
    schema,
    rootValue: {
      user: ({ id }: { id: string }) => ({ id, name: "Ada", email: "ada@example.com" }),
    },
  }),
  { retry: 0 },
);
render(<Profile pool={pool} id="1" />);
```

Execution is the server's: a selection the schema rejects fails in the test as
it would in production, field by field, and batches, streaming and `ref()`
behave as they do over HTTP. `context` runs once per batch, for loaders. The
same fetcher serves stories, and server components when the schema lives in the
same app.

Request mocking libraries that match GraphQL operations by name, such as MSW's
`graphql.query`, don't see laguz batches, which are anonymous and aliased
(`q0: user(...)`). Mock the endpoint itself, or use `localFetcher`.

## Compared with TanStack Query

|                           | TanStack Query                       | laguz                                                                |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Requests                  | one per query                        | one per commit, merged by root field and arguments                   |
| Stale-while-revalidate    | `staleTime`                          | `staleTime`; the merged entry refetches as a whole                   |
| Retries                   | 3, exponential backoff               | 3, exponential backoff, batched                                      |
| Optimistic updates        | `onMutate` with manual rollback      | `pool.mutate` with `optimistic` and automatic rollback               |
| Invalidation              | one request per query                | one request for everything invalidated                               |
| Focus, reconnect, polling | one request per query                | one request for everything due                                       |
| Dependent queries         | `enabled`, one round trip per level  | `null` arguments, or `ref()`: one round trip with the server package |
| Infinite queries          | pages refetched one after the other  | all pages in one request, optional prefetch                          |
| Result types              | written by hand or by a codegen step | generated from the schema, inferred from each selection              |
| Suspense                  | `useSuspenseQuery`                   | `useSuspenseData`, one boundary per component                        |
| Server rendering          | `dehydrate`, `HydrationBoundary`     | `dehydrate`, `useHydrate`; server loads go out as one request        |
| Previous data             | `placeholderData: keepPreviousData`  | `keepPrevious: true`                                                 |
| Cancellation              | a signal per query                   | per batch, once nothing waits for it                                 |
| Devtools                  | `@tanstack/react-query-devtools`     | `LaguzDevtools`: requests with their field timelines, the cache      |

## Limitations

- Without the server package, a batch is only as fast as its slowest field.
- Composed queries change with what is on screen, so they can't be persisted
  queries or cached per URL by a CDN.
- Server limits on aliases or query cost apply to the whole batch. Use
  `maxBatch` to split large batches. Batches that forward refs are never split.
- Refs live in root field arguments and point at fields without arguments.
