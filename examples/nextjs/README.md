# Next.js example

A small issue tracker on the Next.js App Router. The panel at the bottom right
lists every query the browser sends.

- The layout and the pages load their data in server components, which run
  queries in-process ([`lib/server-pool.ts`](lib/server-pool.ts)), and hand it
  to the browser's pool with `Hydrate` ([`lib/pool.tsx`](lib/pool.tsx)). A
  first visit sends one request from the browser: the issue counts, which the
  server leaves out because they are slow.
- The board ([`app/board.tsx`](app/board.tsx)) is an infinite list with a
  status filter passed as an enum. Checking an issue runs a typed mutation
  with `useMutation`: the list updates at once, then the list and the counts
  refetch in one request.
- The issue page ([`app/issues/[id]`](app/issues/[id])) lists the other issues
  of the assignee with `ref()`: the server resolves both queries in one pass.
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
