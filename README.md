# laguz

Batch every GraphQL query a React commit needs into one request, and stream the
answer back field by field.

[![CI](https://github.com/maxenceleguery/laguz/actions/workflows/ci.yml/badge.svg)](https://github.com/maxenceleguery/laguz/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Components keep declaring their own data, as with any hook-based client. laguz
collects what a commit asks for, sends one composed query, and hands each
component its fields as soon as the server resolves them. With the server
package, a slow field doesn't hold back the others, and queries that depend on
each other resolve in a single round trip.

## Install

```sh
npm install @laguzjs/client
npm install @laguzjs/server graphql   # optional, on the server
```

## Usage

```ts
// app/graphql/route.ts (any runtime with Request/Response: Node, Bun, Deno, Workers)
import { batchLoader, createHandler } from "@laguzjs/server";

export const POST = createHandler({
  schema,
  rootValue,
  // One context per request, so every field of a batch shares its loaders.
  context: () => ({ users: batchLoader(loadUsersById) }),
});
```

```tsx
import { createPool, httpFetcher, ref } from "@laguzjs/client";
import { useData } from "@laguzjs/client/react";

const pool = createPool(httpFetcher("/graphql", { stream: true }));

function Header() {
  const { data } = useData(pool, "user", { id: 1 }, ["name", { avatar: { args: { size: 32 } } }]);
  return <h1>{data?.name}</h1>;
}

function TeamLead() {
  // Arguments can come from another query's result. With @laguzjs/server the
  // whole chain is resolved in the same request.
  const lead = ref("team", { id: ref("user", { id: 1 }, "teamId") }, "leadId");
  const { data } = useData(pool, "user", { id: lead }, ["name"]);
  return <p>{data?.name}</p>;
}
```

`Header` and `TeamLead` render in the same commit, so their queries go out as
one request. With types generated from your schema (`npx laguz-types
schema.graphql -o schema.generated.ts`, then `createPool<Schema>(...)`), selections
are checked and `data` has the selected shape. See the [guide](docs/guide.md)
for typed results, pagination, mutations, Suspense
and the full API.

## Numbers

Measured against TanStack Query in headless Chromium, with the same components
and the same server, over HTTP/2 with brotli on an emulated slow 4G link
(150 ms RTT). Medians of 5 runs.

| Scenario                                   | TanStack Query      | laguz             |
| ------------------------------------------ | ------------------- | ----------------- |
| 20-widget page, median widget on screen    | 278 ms, 20 requests | 171 ms, 1 request |
| Database round trips for that page         | 28                  | 6                 |
| Response bytes for that page               | 2.2 KB              | 0.9 KB            |
| Refresh an infinite list with 5 pages      | 832 ms, 5 requests  | 171 ms, 1 request |
| Three dependent queries (user, team, lead) | 498 ms, 3 requests  | 186 ms, 1 request |

The first and last widget appear at the same time in both. On a fast network
over HTTP/2 the latency is about even and the gain is server load. Against a
GraphQL server that doesn't stream, the batch waits for its slowest field.
Methodology and the full matrix are in [docs/benchmarks](docs/benchmarks).

## Packages

| Package                              | Purpose                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [`@laguzjs/client`](packages/client) | The batching cache, the HTTP transport and React hooks. No dependencies. Works with any GraphQL server. |
| [`@laguzjs/server`](packages/server) | Runs each root field on its own, streams results, resolves dependent queries. Wraps graphql-js.         |

The two talk over a small extension of GraphQL over HTTP, described in
[docs/protocol.md](docs/protocol.md).

## Documentation

- [Guide](docs/guide.md): concepts and API
- [Design notes](docs/design.md): why a commit is the batch boundary, and what comes next
- [Protocol](docs/protocol.md)
- [Benchmarks](docs/benchmarks)
- [laguz.maxenceleguery.net](https://laguz.maxenceleguery.net)

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the setup, the checks and how releases work.

## License

[MIT](LICENSE)
