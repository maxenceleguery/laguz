# Recipes

Most backends and auth providers need two things from laguz: a URL and a
token. `httpFetcher` takes headers as a function that runs before each
request, so a fresh token is always sent. These recipes show the wiring; check
each provider's documentation for the current details.

## Supabase

Supabase serves your database as GraphQL with pg_graphql, at
`https://<project-ref>.supabase.co/graphql/v1`. Every request needs the
project's API key in `apikey`, and the user's access token in `authorization`
so that row level security applies:

```ts
import { createPool, httpFetcher } from "@laguzjs/client";
import { supabase } from "./supabase"; // your createClient(...)

const pool = createPool<Schema>(
  httpFetcher(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/graphql/v1`, {
    headers: async () => {
      const { data } = await supabase.auth.getSession();
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
      return { apikey: key, authorization: `Bearer ${data.session?.access_token ?? key}` };
    },
  }),
);
```

Generate the types from the endpoint. Since pg_graphql 1.6.0, introspection is
off by default; turn it on for the schema first:

```sql
comment on schema public is e'@graphql({"introspection": true})';
```

```sh
npx laguz-types "$SUPABASE_URL/graphql/v1" --header "apikey: $SUPABASE_ANON_KEY" -o src/schema.generated.ts
```

pg_graphql is not a laguz server, so responses aren't streamed and `ref()`
values resolve in the browser. Batching works as with any GraphQL server.

## Clerk

In the browser, read the session token when each request goes out:

```ts
const pool = createPool<Schema>(
  httpFetcher("/graphql", {
    headers: async () => {
      const token = await window.Clerk?.session?.getToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
  }),
);
```

In a server component, `auth()` from `@clerk/nextjs/server` gives the token of
the request (it needs `clerkMiddleware()`):

```ts
import { auth } from "@clerk/nextjs/server";

const { getToken } = await auth();
const pool = createPool<Schema>(
  httpFetcher(process.env.GRAPHQL_URL!, {
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  }),
);
```

Pass `getToken({ template: "..." })` to use a JWT template your GraphQL server
expects.

## Cookies

With a session cookie (Auth.js, Lucia, your own), a same-origin endpoint needs
nothing: the browser sends the cookie. On another origin, ask `fetch` to send
it, and allow credentials in the server's CORS settings:

```ts
httpFetcher("https://api.example.com/graphql", { init: { credentials: "include" } });
```

In a server component, forward the incoming cookie:

```ts
import { cookies } from "next/headers";

const cookie = (await cookies()).toString();
const pool = createPool<Schema>(httpFetcher(process.env.GRAPHQL_URL!, { headers: { cookie } }));
```

## Hasura

Hasura reads a JWT from `authorization`, or an admin secret from
`x-hasura-admin-secret` on the server only:

```ts
httpFetcher(process.env.HASURA_URL!, {
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
```

```sh
npx laguz-types "$HASURA_URL" --header "x-hasura-admin-secret: $HASURA_ADMIN_SECRET" -o src/schema.generated.ts
```
