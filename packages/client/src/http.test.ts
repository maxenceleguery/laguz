import { expect, test } from "bun:test";
import { createPool, httpFetcher, type Response as GqlResponse } from "./index.ts";

// A fake `fetch` that records requests and answers with `reply`.
function fakeFetch(reply: () => Response = () => Response.json({ data: { q0: 1 } })) {
  const requests: Request[] = [];
  const inits: RequestInit[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    inits.push(init);
    return reply();
  }) as typeof fetch;
  return { fn, requests, inits };
}

const once = async (result: Promise<GqlResponse> | AsyncIterable<GqlResponse>) => {
  if (!(Symbol.asyncIterator in result)) return result;
  for await (const chunk of result) return chunk;
};

test("a headers function runs before every request, so a refreshed token is used", async () => {
  const { fn, requests } = fakeFetch();
  let token = "a";
  const fetcher = httpFetcher("http://x/graphql", {
    fetch: fn,
    headers: async () => ({ authorization: `Bearer ${token}` }),
  });
  await fetcher("{ q0: n }");
  token = "b";
  await fetcher("{ q0: n }");
  expect(requests.map((r) => r.headers.get("authorization"))).toEqual(["Bearer a", "Bearer b"]);
});

test("headers may be a Headers object or pairs, and override the defaults", async () => {
  const { fn, requests } = fakeFetch();
  await httpFetcher("http://x", { fetch: fn, headers: new Headers({ "x-a": "1" }) })("{ q0: n }");
  await httpFetcher("http://x", {
    fetch: fn,
    headers: [["accept", "application/graphql-response+json"]],
  })("{ q0: n }");
  expect(requests[0]!.headers.get("x-a")).toBe("1");
  expect(requests[0]!.headers.get("content-type")).toBe("application/json");
  expect(requests[1]!.headers.get("accept")).toBe("application/graphql-response+json");
});

test("init options reach fetch, but can't replace the method or the body", async () => {
  const { fn, requests, inits } = fakeFetch();
  const init = { credentials: "include", method: "GET", body: "x" } as RequestInit;
  await httpFetcher("http://x", { fetch: fn, init })("{ q0: n }");
  expect(inits[0]!.credentials).toBe("include");
  expect(requests[0]!.method).toBe("POST");
  expect(await requests[0]!.json()).toEqual({ query: "{ q0: n }" });
});

test("a non-JSON error page fails with its HTTP status, in both modes", async () => {
  const page = () =>
    new Response("<h1>Bad gateway</h1>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html" },
    });
  for (const stream of [false, true]) {
    const { fn } = fakeFetch(page);
    const result = httpFetcher("http://x", { fetch: fn, stream })("{ q0: n }");
    await expect(once(result)).rejects.toThrow("HTTP 502 Bad Gateway");
  }
});

test("a GraphQL error response is read whatever its status", async () => {
  const { fn } = fakeFetch(() =>
    Response.json({ errors: [{ message: "Cannot query field" }] }, { status: 400 }),
  );
  const pool = createPool(httpFetcher("http://x", { fetch: fn }), { retry: 0 });
  await pool.load("user", { id: 1 }, ["name"]);
  expect(pool.read("user", { id: 1 }).error?.message).toBe("Cannot query field");
});

test("the pool's signal reaches fetch, combined with one passed in init", async () => {
  const { fn, inits } = fakeFetch();
  const pool = new AbortController();
  const own = new AbortController();
  await httpFetcher("http://x", { fetch: fn })("{ q0: n }", { signal: pool.signal });
  await httpFetcher("http://x", { fetch: fn, init: { signal: own.signal } })("{ q0: n }", {
    signal: pool.signal,
  });
  pool.abort();
  expect(inits[0]!.signal!.aborted).toBe(true);
  expect(inits[1]!.signal!.aborted).toBe(true);

  const other = new AbortController();
  await httpFetcher("http://x", { fetch: fn, init: { signal: own.signal } })("{ q0: n }", {
    signal: other.signal,
  });
  own.abort();
  expect(inits[2]!.signal!.aborted).toBe(true);
});
