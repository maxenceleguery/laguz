import { afterAll, expect, test } from "bun:test";
import { createPool, httpFetcher, ref } from "@laguzjs/client";
import { buildSchema, execute, validate } from "graphql";
import { batchLoader, createHandler, ndjson, splitExecute } from "./server.ts";

const schema = buildSchema(`
  enum Role { ADMIN MEMBER }
  type User { id: ID! name: String! teamId: ID! role: Role! }
  type Team { id: ID! name: String! leadId: ID! }
  type Query { user(id: ID!): User  team(id: ID!): Team  slow: Int!  fast: Int!  boom: User  byRole(role: Role!): [User!]! }
`);

let userBatches: string[][] = [];
const ctx = () => ({
  users: batchLoader(async (ids: string[]) => {
    userBatches.push(ids);
    return ids.map((id) => ({ id, name: `u${id}`, teamId: `t${id}`, role: "ADMIN" }));
  }),
});
const rootValue = {
  user: ({ id }: { id: string }, c: ReturnType<typeof ctx>) => c.users(id),
  slow: () => Bun.sleep(80).then(() => 1),
  fast: () => 2,
  team: ({ id }: { id: string }) => ({ id, name: `team ${id}`, leadId: "9" }),
  byRole: ({ role }: { role: string }) => [{ id: "1", name: `first ${role.toLowerCase()}` }],
  boom: () => {
    throw new Error("boom");
  },
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { query } = (await req.json()) as { query: string };
    return ndjson(splitExecute({ schema, source: query, rootValue, contextValue: ctx() }));
  },
});
afterAll(() => server.stop(true));

const collect = async (source: string) => {
  const out: unknown[] = [];
  for await (const r of splitExecute({ schema, source, rootValue, contextValue: ctx() })) {
    const { extensions: _, ...rest } = JSON.parse(JSON.stringify(r));
    out.push(rest);
  }
  return out;
};

test("root fields resolve independently and arrive in completion order", async () => {
  expect(await collect("{ q0: slow q1: fast }")).toEqual([
    { data: { q1: 2 } },
    { data: { q0: 1 } },
  ]);
});

test("an invalid root field fails alone, with its alias as path", async () => {
  const out = (await collect("{ q0: user(id: 1) { nope } q1: fast }")) as any[];
  expect(out).toContainEqual({ data: { q1: 2 } });
  const bad = out.find((r) => r.errors);
  expect(bad.data).toEqual({ q0: null });
  expect(bad.errors[0].path).toEqual(["q0"]);
});

test("one loader context is shared across the split fields, so lookups still batch", async () => {
  userBatches = [];
  await collect("{ q0: user(id: 1) { name } q1: user(id: 2) { name } q2: user(id: 3) { name } }");
  expect(userBatches).toEqual([["1", "2", "3"]]);
});

test("end to end: the pool gets the fast field before the slow one over HTTP", async () => {
  const seen: string[] = [];
  const pool = createPool(httpFetcher(server.url.href, { stream: true }));
  pool.watch("slow", {}, [], () => seen.push("slow"));
  pool.watch("fast", {}, [], () => seen.push("fast"));
  await Bun.sleep(200);
  expect(seen).toEqual(["fast", "slow"]);
  expect(pool.read("slow", {}).data).toBe(1);
});

test("forwarded refs: the dependent runs with the dependency's value, in one request", async () => {
  const out = (await collect(
    "{ q0: user(id: 1) { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
  )) as any[];
  expect(out).toEqual([{ data: { q0: { teamId: "t1" } } }, { data: { q1: { name: "team t1" } } }]);
});

test("a ref to a failed field fails the dependent with its alias as path", async () => {
  const out = (await collect(
    "{ q0: boom { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
  )) as any[];
  const dep = out.find((r) => r.data && "q1" in r.data);
  expect(dep.data.q1).toBeNull();
  expect(dep.errors[0].path).toEqual(["q1"]);
});

test("refs may only point backwards, so a request can't deadlock on a cycle", async () => {
  const out = (await collect(
    "{ q0: team(id: $_ref__q1__teamId) { name } q1: user(id: $_ref__q0__leadId) { teamId } }",
  )) as any[];
  expect(out).toHaveLength(2);
  expect(out.every((r) => r.errors?.length)).toBe(true);
});

test("end to end: a three-level chain is one HTTP request", async () => {
  let requests = 0;
  const pool = createPool((q) => (requests++, httpFetcher(server.url.href, { stream: true })(q)), {
    serverRefs: true,
  });
  const lead = ref("team", { id: ref("user", { id: 1 }, "teamId") }, "leadId");
  pool.watch("user", { id: lead }, ["name"], () => {});
  await Bun.sleep(100);
  expect(requests).toBe(1);
  expect(pool.read("user", { id: lead }).data).toEqual({ name: "u9" });
});

test("the first result carries the protocol marker, so clients can upgrade by themselves", async () => {
  const out: any[] = [];
  for await (const r of splitExecute({
    schema,
    source: "{ q0: fast q1: slow }",
    rootValue,
    contextValue: ctx(),
  }))
    out.push(r);
  expect(out[0].extensions).toEqual({ laguz: 1 });
  expect(out[1].extensions).toBeUndefined();
});

const handler = createHandler({ schema, rootValue, context: ctx });
const post = (query: string, accept = "application/json") =>
  handler(
    new Request("http://x/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept },
      body: JSON.stringify({ query }),
    }),
  );

test("createHandler, JSON mode: one merged response, still per-field validation and forwarding", async () => {
  const res = await post(
    "{ q0: user(id: 1) { teamId } q1: team(id: $_ref__q0__teamId) { name } q2: user(id: 1) { nope } }",
  );
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as any;
  expect(body.data).toEqual({ q0: { teamId: "t1" }, q1: { name: "team t1" }, q2: null });
  expect(body.errors.map((e: any) => e.path)).toEqual([["q2"]]);
  expect(body.extensions).toEqual({ laguz: 1 });
});

test("createHandler streams NDJSON when asked", async () => {
  const res = await post("{ q0: slow q1: fast }", "application/x-ndjson");
  expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.map((l) => Object.keys(l.data)[0])).toEqual(["q1", "q0"]);
});

test("a custom execute (envelop, Yoga) is used for every field", async () => {
  let calls = 0;
  const h = createHandler({
    schema,
    rootValue,
    context: ctx,
    execute: (args) => (calls++, execute(args)),
  });
  await h(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ query: "{ q0: fast q1: slow }" }),
    }),
  );
  expect(calls).toBe(2);
});

test("createHandler answers 400 to a malformed body or a missing query", async () => {
  const send = (body: string) => handler(new Request("http://x", { method: "POST", body }));
  for (const body of ["{not json", "{}", JSON.stringify({ query: 42 })]) {
    const res = await send(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { errors: { message: string }[] };
    expect(json.errors[0]!.message).toContain("query");
  }
});

test("createHandler answers 405 to anything but POST", async () => {
  const res = await handler(new Request("http://x?query={fast}"));
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

const countingValidate = () => {
  const calls = { n: 0 };
  const fn: typeof validate = (...args) => {
    calls.n++;
    return validate(...args);
  };
  return { calls, fn };
};
const run = async (source: string, check: typeof validate) => {
  const out: any[] = [];
  for await (const r of splitExecute({
    schema,
    source,
    rootValue,
    contextValue: ctx(),
    validate: check,
  }))
    out.push(r);
  return out;
};

test("a valid batch is validated in one pass, not once per field", async () => {
  const { calls, fn } = countingValidate();
  await run("{ q0: fast q1: user(id: 1) { name } q2: user(id: 2) { teamId } }", fn);
  expect(calls.n).toBe(1);
});

test("a repeated query is not parsed or validated again", async () => {
  const { calls, fn } = countingValidate();
  const source = "{ q0: fast q1: user(id: 3) { name } }";
  await run(source, fn);
  const again = await run(source, fn);
  expect(calls.n).toBe(1);
  expect(again.map((r) => Object.keys(r.data)[0]).sort()).toEqual(["q0", "q1"]);
});

test("fields with forwarded values are still validated once their values are known", async () => {
  const { calls, fn } = countingValidate();
  const out = await run(
    "{ q0: user(id: 1) { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
    fn,
  );
  expect(out.find((r) => r.data.q1)?.data.q1).toEqual({ name: "team t1" });
  expect(calls.n).toBe(2); // the batch, then the field whose argument was substituted
});

test("a field whose execute throws reports an error, and the other fields still arrive", async () => {
  const throwing: typeof execute = (args) => {
    const field = (args.document.definitions[0] as any).selectionSet.selections[0];
    if (field.alias?.value === "q0") throw new Error("plugin crashed");
    return execute(args);
  };
  const out: any[] = [];
  for await (const r of splitExecute({
    schema,
    source: "{ q0: fast q1: slow }",
    rootValue,
    execute: throwing,
  })) {
    out.push(r);
  }
  expect(out).toHaveLength(2);
  expect(out.some((r) => r.errors?.[0]?.message === "plugin crashed")).toBe(true);
  expect(out.some((r) => r.data?.q1 === 1)).toBe(true);
});

test("a forwarded value is typed by the argument it fills, so enums forward as enums", async () => {
  const out = (await collect(
    "{ q0: user(id: 1) { role } q1: byRole(role: $_ref__q0__role) { name } }",
  )) as any[];
  expect(out.find((r) => r.data?.q1)?.data.q1).toEqual([{ name: "first admin" }]);
});
