# @laguzjs/client

Batch every GraphQL query a React commit needs into one request, and stream the
answer back field by field.

```sh
npm install @laguzjs/client
```

```tsx
import { createPool, httpFetcher } from "@laguzjs/client";
import { useData } from "@laguzjs/client/react";

const pool = createPool(httpFetcher("/graphql", { stream: true }));

function Header() {
  const { data, loading, error } = useData(pool, "user", { id: 1 }, ["name"]);
  return <h1>{data?.name}</h1>;
}
```

Works with any GraphQL server. Pair it with
[`@laguzjs/server`](https://www.npmjs.com/package/@laguzjs/server) to stream
fields as they resolve and to resolve dependent queries in one round trip.

Documentation: [guide](https://github.com/maxenceleguery/laguz/blob/main/docs/guide.md)
and [laguz.maxenceleguery.net](https://laguz.maxenceleguery.net).

## License

MIT
