---
"@laguzjs/client": minor
"@laguzjs/server": minor
---

Typed mutations. `laguz-types` adds the mutation type to `Schema`. `pool.mutate(name, args, fields, options)` sends `mutation { name(args) { fields } }` on its own, never retried, and resolves to the selected data; a GraphQL error rejects with the server's message. The `useMutation` hook returns `{ mutate, data, error, pending, reset }` for a schema mutation or any async function, with optimistic writes and invalidations that can depend on the variables. `pool.load` is now typed by the schema too.
