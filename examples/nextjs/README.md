# Next.js example

A small issue tracker on the Next.js App Router. The laguz devtools, open at the
bottom right, show each request the browser sends, when each of its fields
arrived, and the cache.

- Every query is defined once in [`lib/queries.ts`](lib/queries.ts), typed
  from the schema. Server components load them and client components read
  them, so both reach the same cache entry.
- The layout and the pages load their data in server components, which run
  queries in-process ([`lib/server-pool.ts`](lib/server-pool.ts)), and hand it
  to the browser's pool with `Hydrate` ([`lib/pool.tsx`](lib/pool.tsx)). A
  first visit sends one request from the browser: the issue counts, which the
  server leaves out because they are slow.
- The board ([`app/board.tsx`](app/board.tsx)) is an infinite list with a
  status filter passed as an enum. Checking an issue runs a typed mutation
  with `useMutation`: the list updates at once, then the list and the counts
  refetch in one request.
- The issue page ([`app/issues/[id]`](app/issues/[id])) has no prefetch: its
  components suspend on their queries during the server render, and the data
  streams to the browser with the HTML (`useServerInsertedHTML`). It lists the
  other issues of the assignee with `ref()`: both queries go out in one request.
- [`app/graphql/route.ts`](app/graphql/route.ts) serves the schema with
  `@laguzjs/server`. The data lives in memory and every call waits a little, so
  batching and streaming are visible.

## Running it

From the repository root:

```sh
bun install
bun run build
cd examples/nextjs
bun run dev
```

After editing [`lib/schema.graphql`](lib/schema.graphql), run `bun run types`
to regenerate `lib/schema.generated.ts`.

Outside `bun run dev`, set `SITE_URL` to the app's own address: when the server
renders the streamed issue page, its pool calls `/graphql` with an absolute URL.
