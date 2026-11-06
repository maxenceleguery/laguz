# @laguzjs/server

The server side of [laguz](https://github.com/maxenceleguery/laguz). Executes
each root field of a batched GraphQL query on its own, streams the results as
they complete, and resolves queries that depend on each other in the same
request.

```sh
npm install @laguzjs/server graphql
```

```ts
import { batchLoader, createHandler } from "@laguzjs/server";

export const POST = createHandler({
  schema,
  rootValue,
  context: () => ({ users: batchLoader(loadUsersById) }),
});
```

`createHandler` takes a `Request` and returns a `Response`, so it runs on Node,
Bun, Deno, Cloudflare Workers and Next.js route handlers. Pass your server's
`execute` and `validate` to keep envelop or Yoga plugins.

Documentation: [guide](https://github.com/maxenceleguery/laguz/blob/main/docs/guide.md#server)
and [protocol](https://github.com/maxenceleguery/laguz/blob/main/docs/protocol.md).

## License

MIT
