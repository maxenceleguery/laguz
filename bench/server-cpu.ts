import { createPool } from "@laguzjs/client";
import { batchLoader, merged, splitExecute } from "@laguzjs/server";
import { execute, graphql, parse, validate, type OperationDefinitionNode } from "graphql";
import { schema } from "./schema";

// Server CPU per request for the 20-widget dashboard query, without I/O:
// graphql-js on its own, and @laguzjs/server with a cold and a warm cache.
//   bun bench/server-cpu.ts

// The exact query the pool composes for the 20-widget dashboard.
let query = "";
const pool = createPool(async (q) => ((query = q), { data: {} }), { retry: 0 });
const specs: [string, object, any[]][] = [
  ["user", { id: 1 }, ["name", { avatar: { args: { size: 32 } } }]],
  ["user", { id: 1 }, ["name", "email", { avatar: { args: { size: 128 } } }]],
  ["notifications", {}, ["id", "message"]],
  ["stats", {}, ["activeUsers", "revenue"]],
  ...Array.from({ length: 8 }, (_, i): [string, object, any[]] => [
    "project",
    { id: `p${i}` },
    ["name", "tasks", { owner: ["name"] }],
  ]),
  ...Array.from({ length: 8 }, (_, i): [string, object, any[]] => [
    "activity",
    { projectId: `p${i}` },
    ["id", "text", "at"],
  ]),
];
for (const [r, a, f] of specs) pool.watch(r, a, f, () => {});
await new Promise((r) => setTimeout(r, 5));

// In-memory resolvers: measures graphql-js + laguz CPU, no I/O.
const users: Record<string, any> = Object.fromEntries(
  [1, 2, 3, 4].map((i) => [
    String(i),
    {
      id: String(i),
      name: `U${i}`,
      email: `u${i}@x`,
      teamId: "t1",
      avatar: ({ size }: any) => `/a/${i}?s=${size}`,
    },
  ]),
);
const context = () => ({ users: batchLoader(async (ids: string[]) => ids.map((id) => users[id])) });
const rootValue = {
  user: ({ id }: any, c: any) => c.users(id),
  project: ({ id }: any, c: any) => ({ id, name: `P ${id}`, tasks: 3, owner: () => c.users("2") }),
  activity: ({ projectId }: any) =>
    Array.from({ length: 5 }, (_, i) => ({
      id: `${projectId}e${i}`,
      text: `E${i}`,
      at: "2026-11-01",
    })),
  notifications: () => [1, 2, 3].map((i) => ({ id: `n${i}`, message: `N${i}` })),
  stats: () => ({ activeUsers: 1, revenue: 2 }),
};

async function time(label: string, n: number, fn: () => unknown) {
  for (let i = 0; i < 200; i++) await fn();
  const t = performance.now();
  for (let i = 0; i < n; i++) await fn();
  const us = ((performance.now() - t) / n) * 1000;
  console.log(`${label.padEnd(44)} ${us.toFixed(0).padStart(6)} µs`);
  return us;
}

console.log(`query: ${query.length} chars, ${(query.match(/q\d+:/g) ?? []).length} root fields\n`);
const doc = parse(query);
const op = doc.definitions[0] as OperationDefinitionNode;
const parts = op.selectionSet.selections.map((sel) => ({
  ...doc,
  definitions: [{ ...op, selectionSet: { ...op.selectionSet, selections: [sel] } }],
}));
const N = 3000;
await time("parse (whole query)", N, () => parse(query));
await time("validate whole document once", N, () => validate(schema, doc));
await time("validate each root field separately", N, () =>
  parts.forEach((p) => validate(schema, p)),
);
await time("execute whole document", N, () =>
  execute({ schema, document: doc, rootValue, contextValue: context() }),
);
await time("execute each root field separately", N, () =>
  Promise.all(
    parts.map((p) => execute({ schema, document: p, rootValue, contextValue: context() })),
  ),
);
const plain = await time("graphql() end to end (plain server)", N, () =>
  graphql({ schema, source: query, rootValue, contextValue: context() }),
);
let unique = 0;
const cold = await time("laguz server, new query (cold cache)", N, () =>
  merged(
    splitExecute({ schema, source: `${query} # ${unique++}`, rootValue, contextValue: context() }),
  ),
);
const split = await time("laguz server, repeated query (warm cache)", N, () =>
  merged(splitExecute({ schema, source: query, rootValue, contextValue: context() })),
);
const res = await merged(
  splitExecute({ schema, source: query, rootValue, contextValue: context() }),
);
await time("JSON.stringify of the response", N, () => JSON.stringify(res));
console.log(
  `\nlaguz vs graphql(): ${(cold / plain).toFixed(2)}x cold, ${(split / plain).toFixed(2)}x warm`,
);
process.exit(0);
