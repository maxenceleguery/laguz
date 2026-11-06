import { expect, test } from "bun:test";
import {
  createPool,
  enumValue,
  fieldKey,
  ready,
  ref,
  toTree,
  view,
  type Fields,
  type Options,
  type Response,
} from "./index.ts";

// Fake transport: records every query, answers from `reply`.
function setup(
  reply: (query: string, n: number) => Response | Promise<Response> = () => ({ data: {} }),
  opts: Options = {},
) {
  const queries: string[] = [];
  const pool = createPool(
    async (q) => {
      queries.push(q);
      return reply(q, queries.length);
    },
    { retry: 0, ...opts },
  );
  return { pool, queries };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
// console.warn calls made while `fn` runs.
async function warnings(fn: () => Promise<void>) {
  const original = console.warn;
  const seen: string[] = [];
  console.warn = (message: string) => void seen.push(message);
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

// --- batching and composition ---

test("everything registered in one turn goes out as one request", async () => {
  const { pool, queries } = setup();
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("notifications", {}, ["id", "message"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await tick();
  expect(queries).toEqual([
    "{ q0: user(id: 42) { name } q1: notifications { id message } q2: stats { revenue } }",
  ]);
});

test("same root + args from two consumers merge into one selection", async () => {
  const { pool, queries } = setup();
  pool.watch("user", { id: 42 }, ["name", { projects: ["id"] }], () => {});
  pool.watch("user", { id: 42 }, ["email", { projects: ["name"] }], () => {});
  await tick();
  expect(queries).toEqual(["{ q0: user(id: 42) { name projects { id name } email } }"]);
});

test("results are dispatched to every consumer of the entry", async () => {
  const { pool } = setup(() => ({ data: { q0: { name: "Ada", email: "ada@x.io" } } }));
  let calls = 0;
  pool.watch("user", { id: 42 }, ["name"], () => calls++);
  pool.watch("user", { id: 42 }, ["email"], () => calls++);
  await tick();
  expect(calls).toBe(2);
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada", email: "ada@x.io" });
});

test("a later turn only asks for fields nobody asked for yet (while fresh)", async () => {
  const { pool, queries } = setup(
    (q) =>
      q.includes("email")
        ? { data: { q0: { email: "ada@x.io" } } }
        : { data: { q0: { name: "Ada" } } },
    { staleTime: Infinity },
  );
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await tick();
  pool.watch("user", { id: 42 }, ["name"], () => {}); // covered: no request
  await tick();
  pool.watch("user", { id: 42 }, ["name", "email"], () => {});
  await tick();
  expect(queries).toEqual(["{ q0: user(id: 42) { name } }", "{ q0: user(id: 42) { email } }"]);
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada", email: "ada@x.io" });
});

test("fields already in flight are not requested twice", async () => {
  const d = deferred<Response>();
  const { pool, queries } = setup(() => d.promise);
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await tick();
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await tick();
  d.resolve({ data: { q0: { name: "Ada" } } });
  await settle();
  expect(queries).toHaveLength(1);
});

test("missing fields under a list refetch the whole entry instead of merging by index", async () => {
  // Between the two requests the server list changed order: index merging
  // would glue p2's name onto p1.
  const { pool, queries } = setup(
    (_, n) =>
      n === 1
        ? { data: { q0: { projects: [{ id: "p1" }] } } }
        : {
            data: {
              q0: {
                projects: [
                  { id: "p2", name: "B" },
                  { id: "p1", name: "A" },
                ],
              },
            },
          },
    { staleTime: Infinity },
  );
  pool.watch("user", { id: 42 }, [{ projects: ["id"] }], () => {});
  await tick();
  pool.watch("user", { id: 42 }, [{ projects: ["name"] }], () => {});
  await tick();
  expect(queries[1]).toBe("{ q0: user(id: 42) { projects { id name } } }");
  expect(pool.read("user", { id: 42 }).data).toEqual({
    projects: [
      { id: "p2", name: "B" },
      { id: "p1", name: "A" },
    ],
  });
});

test("scalar root fields (empty selection) are fetched once and count as loaded", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: 7 } }), { staleTime: Infinity });
  pool.watch("count", {}, [], () => {});
  expect(ready(pool.read("count", {}), {})).toBe(false);
  await settle();
  pool.watch("count", {}, [], () => {});
  await settle();
  expect(queries).toEqual(["{ q0: count }"]);
  expect(ready(pool.read("count", {}), {})).toBe(true);
});

// --- arguments ---

test("argument values are escaped and names are validated", async () => {
  const { pool, queries } = setup();
  pool.watch(
    "search",
    { text: 'a" } evil { x', tags: ["a"], f: { b: 1, a: true } },
    ["id"],
    () => {},
  );
  await tick();
  expect(queries[0]).toBe(
    '{ q0: search(f: {a: true, b: 1}, tags: ["a"], text: "a\\" } evil { x") { id } }',
  );
  expect(() => pool.watch("user } x", {}, ["id"], () => {})).toThrow();
  expect(() => pool.watch("user", {}, ["id } x"], () => {})).toThrow();
});

test("argument key order does not split the cache", async () => {
  const { pool, queries } = setup();
  pool.watch("page", { a: 1, b: 2 }, ["x"], () => {});
  pool.watch("page", { b: 2, a: 1 }, ["y"], () => {});
  await tick();
  expect(queries).toEqual(["{ q0: page(a: 1, b: 2) { x y } }"]);
});

test("undefined args are omitted and dates are serialized like JSON", async () => {
  const { pool, queries } = setup();
  pool.watch("events", { after: new Date(0), cursor: undefined }, ["id"], () => {});
  await tick();
  expect(queries[0]).toBe('{ q0: events(after: "1970-01-01T00:00:00.000Z") { id } }');
});

// --- errors ---

test("an error with a path only fails its own entry", async () => {
  const { pool } = setup(() => ({
    data: { q0: null, q1: { revenue: 10 } },
    errors: [{ message: "forbidden", path: ["q0"] }],
  }));
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  expect(pool.read("user", { id: 42 }).error?.message).toBe("forbidden");
  expect(pool.read("stats", {}).data).toEqual({ revenue: 10 });
});

test("a request-level error splits the batch so one bad field cannot fail its siblings", async () => {
  const { pool, queries } = setup((q) =>
    q.includes("nope")
      ? { errors: [{ message: 'Cannot query field "nope"' }] }
      : { data: { q0: { revenue: 10 } } },
  );
  pool.watch("user", { id: 42 }, ["nope"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  expect(queries).toEqual([
    "{ q0: user(id: 42) { nope } q1: stats { revenue } }",
    "{ q0: user(id: 42) { nope } }",
    "{ q0: stats { revenue } }",
  ]);
  expect(pool.read("user", { id: 42 }).error?.message).toBe('Cannot query field "nope"');
  expect(pool.read("stats", {}).data).toEqual({ revenue: 10 });
});

test("failures are retried (batched) and stay loading until retries run out", async () => {
  const { pool, queries } = setup(
    (_, n) => (n < 3 ? Promise.reject(new Error("offline")) : { data: { q0: { name: "Ada" } } }),
    { retry: 2, retryDelay: () => 0 },
  );
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await tick();
  expect(pool.read("user", { id: 42 }).error).toBeUndefined();
  await settle();
  expect(queries).toHaveLength(3);
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

test("after retries run out the error shows, and a remount tries again", async () => {
  let up = false;
  const { pool, queries } = setup(
    () => (up ? { data: { q0: { name: "Ada" } } } : Promise.reject(new Error("offline"))),
    {
      retry: 1,
      retryDelay: () => 0,
    },
  );
  const stop = pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  expect(queries).toHaveLength(2);
  expect(pool.read("user", { id: 42 }).error?.message).toBe("offline");
  stop();
  up = true;
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

// --- streaming ---

test("a streaming transport delivers each field as soon as it resolves", async () => {
  const slow = deferred<void>();
  const pool = createPool(async function* () {
    yield { data: { q1: { revenue: 10 } } };
    await slow.promise;
    yield { data: { q0: { name: "Ada" } } };
  });
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  expect(pool.read("stats", {}).data).toEqual({ revenue: 10 });
  expect(pool.read("user", { id: 42 }).data).toBeUndefined();
  slow.resolve();
  await settle();
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

test("a stream that ends without a field fails that field", async () => {
  const pool = createPool(
    async function* () {
      yield { data: { q1: { revenue: 10 } } };
    },
    { retry: 0 },
  );
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  expect(pool.read("user", { id: 42 }).error).toBeInstanceOf(Error);
  expect(pool.read("stats", {}).data).toEqual({ revenue: 10 });
});

// --- freshness ---

test("stale data is served immediately and revalidated in the background on mount", async () => {
  const { pool, queries } = setup(
    (_, n) => ({ data: { q0: { name: n === 1 ? "Ada" : "Ada L." } } }),
    { staleTime: 0 },
  );
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  await new Promise((r) => setTimeout(r, 2));
  pool.watch("user", { id: 42 }, ["name"], () => {});
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" }); // no loading flash
  await settle();
  expect(queries).toHaveLength(2);
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada L." });
});

test("invalidate refetches every active entry in one request", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada" }, q1: { revenue: 1 } } }), {
    staleTime: Infinity,
  });
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  pool.invalidate();
  await settle();
  expect(queries).toEqual([
    "{ q0: user(id: 42) { name } q1: stats { revenue } }",
    "{ q0: user(id: 42) { name } q1: stats { revenue } }",
  ]);
});

test("a response that started before an invalidation never overwrites newer data", async () => {
  const first = deferred<Response>();
  const { pool } = setup((_, n) => (n === 1 ? first.promise : { data: { q0: { name: "new" } } }), {
    staleTime: Infinity,
  });
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await tick();
  pool.invalidate("user");
  await settle();
  first.resolve({ data: { q0: { name: "old" } } });
  await settle();
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "new" });
});

test("unused entries are garbage collected after gcTime", async () => {
  const { pool } = setup(() => ({ data: { q0: { name: "Ada" } } }), { gcTime: 0 });
  const stop = pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  stop();
  await settle();
  expect(pool.read("user", { id: 42 }).data).toBeUndefined();
});

// --- mutations ---

test("optimistic mutation shows instantly, then invalidations refetch in one request", async () => {
  const done = deferred<string>();
  const { pool, queries } = setup(
    (_, n) => ({ data: { q0: { name: n === 1 ? "Ada" : "Bob" }, q1: { revenue: 1 } } }),
    {
      staleTime: Infinity,
    },
  );
  pool.watch("user", { id: 42 }, ["name"], () => {});
  pool.watch("stats", {}, ["revenue"], () => {});
  await settle();
  const result = pool.mutate(() => done.promise, {
    optimistic: [["user", { id: 42 }, (u) => ({ ...u, name: "Bob" })]],
    invalidate: ["user", "stats"],
  });
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Bob" });
  done.resolve("ok");
  expect(await result).toBe("ok");
  await settle();
  expect(queries).toHaveLength(2);
  expect(queries[1]).toBe("{ q0: user(id: 42) { name } q1: stats { revenue } }");
});

test("a failed mutation rolls the optimistic write back", async () => {
  const { pool } = setup(() => ({ data: { q0: { name: "Ada" } } }), { staleTime: Infinity });
  pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  const result = pool.mutate(() => Promise.reject(new Error("denied")), {
    optimistic: [["user", { id: 42 }, (u) => ({ ...u, name: "Bob" })]],
  });
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Bob" });
  await expect(result).rejects.toThrow("denied");
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

// --- suspense support ---

test("load() batches with watch() in the same turn and resolves once ready", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada" }, q1: { revenue: 1 } } }));
  const loaded = pool.load("user", { id: 42 }, ["name"]);
  expect(pool.load("user", { id: 42 }, ["name"])).toBe(loaded); // stable while pending
  pool.watch("stats", {}, ["revenue"], () => {});
  await loaded;
  expect(queries).toHaveLength(1);
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

test("load() also settles when the fetch fails, so suspense can rethrow the error", async () => {
  const { pool } = setup(() => Promise.reject(new Error("down")));
  await pool.load("user", { id: 42 }, ["name"]);
  expect(pool.read("user", { id: 42 }).error?.message).toBe("down");
});

test("a minimum stale time skips the refetch right after a suspense load", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada" } } }), { staleTime: 0 });
  await pool.load("user", { id: 42 }, ["name"]);
  await new Promise((r) => setTimeout(r, 2));
  pool.watch("user", { id: 42 }, ["name"], () => {}, { minStaleTime: 1000 });
  await settle();
  expect(queries).toHaveLength(1);
});

test("maxBatch splits a large turn for servers that cap aliases per document", async () => {
  const { pool, queries } = setup(() => ({ data: {} }), { maxBatch: 2 });
  for (const root of ["a", "b", "c"]) pool.watch(root, {}, [], () => {});
  await tick();
  expect(queries).toEqual(["{ q0: a q1: b }", "{ q0: c }"]);
});

// --- field arguments ---

test("fields with arguments get stable aliases and each consumer reads its own view", async () => {
  const two = fieldKey("projects", { first: 2 });
  const five = fieldKey("projects", { first: 5 });
  expect(two).toMatch(/^projects_[0-9a-z]+$/);
  expect(two).not.toBe(five);
  const { pool, queries } = setup(() => ({
    data: { q0: { [two]: [{ id: 1 }, { id: 2 }], [five]: [1, 2, 3, 4, 5].map((id) => ({ id })) } },
  }));
  const a: Fields = [{ projects: { args: { first: 2 }, fields: ["id"] } }];
  const b: Fields = [{ projects: { args: { first: 5 }, fields: ["id"] } }];
  pool.watch("user", { id: 42 }, a, () => {});
  pool.watch("user", { id: 42 }, b, () => {});
  await settle();
  expect(queries).toEqual([
    `{ q0: user(id: 42) { ${two}: projects(first: 2) { id } ${five}: projects(first: 5) { id } } }`,
  ]);
  const data = pool.read("user", { id: 42 }).data;
  expect(view(data, a)).toEqual({ projects: [{ id: 1 }, { id: 2 }] });
  expect(view(data, b).projects).toHaveLength(5);
});

test("same field + args under different output names share one selection", async () => {
  const k = fieldKey("projects", { first: 2 });
  const { pool, queries } = setup(() => ({
    data: { q0: { [k]: [{ id: 1, name: "A" }], avatar_x: "" } },
  }));
  pool.watch(
    "user",
    { id: 42 },
    [{ recent: { field: "projects", args: { first: 2 }, fields: ["id"] } }],
    () => {},
  );
  pool.watch(
    "user",
    { id: 42 },
    [
      { projects: { args: { first: 2 }, fields: ["name"] } },
      { pic: { field: "avatar", args: { size: 64 } } },
    ],
    () => {},
  );
  await settle();
  expect(queries[0]).toBe(
    `{ q0: user(id: 42) { ${k}: projects(first: 2) { id name } ${fieldKey("avatar", { size: 64 })}: avatar(size: 64) } }`,
  );
  expect(
    view(pool.read("user", { id: 42 }).data, [
      { recent: { field: "projects", args: { first: 2 }, fields: ["id"] } },
    ]),
  ).toEqual({
    recent: [{ id: 1 }],
  });
});

test("views hide fields other consumers asked for", () => {
  expect(
    view({ name: "Ada", email: "a@x", projects: [{ id: 1, tasks: 3 }] }, [
      "name",
      { projects: ["id"] },
    ]),
  ).toEqual({
    name: "Ada",
    projects: [{ id: 1 }],
  });
  expect(view(7, [])).toBe(7);
  expect(view(null, ["name"])).toBe(null);
});

// --- dependencies between queries ---

const teamOf = ref("user", { id: 1 }, "teamId");
const leadOf = ref("team", { id: teamOf }, "leadId");

test("client refs: the dependent waits for its dependency, then goes out with the literal value", async () => {
  const { pool, queries } = setup((q) =>
    q.includes("teamId") ? { data: { q0: { teamId: "t1" } } } : { data: { q0: { name: "Core" } } },
  );
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  expect(queries).toEqual(["{ q0: user(id: 1) { teamId } }", '{ q0: team(id: "t1") { name } }']);
  expect(pool.read("team", { id: teamOf }).data).toEqual({ name: "Core" });
});

test("server refs: dependency and dependent share one request, the server forwards the value", async () => {
  const { pool, queries } = setup(
    () => ({ data: { q0: { teamId: "t1" }, q1: { name: "Core" } } }),
    { serverRefs: true },
  );
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  expect(queries).toEqual([
    "{ q0: user(id: 1) { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
  ]);
  expect(pool.read("team", { id: teamOf }).data).toEqual({ name: "Core" });
});

test("a three-level chain is one request with server refs", async () => {
  const { pool, queries } = setup(
    () => ({ data: { q0: { teamId: "t1" }, q1: { leadId: "7" }, q2: { name: "Lin" } } }),
    {
      serverRefs: true,
    },
  );
  pool.watch("user", { id: leadOf }, ["name"], () => {});
  await settle();
  expect(queries).toEqual([
    "{ q0: user(id: 1) { teamId } q1: team(id: $_ref__q0__teamId) { leadId } q2: user(id: $_ref__q1__leadId) { name } }",
  ]);
  expect(pool.read("user", { id: leadOf }).data).toEqual({ name: "Lin" });
});

test("when a dependency's value changes, the dependent refetches with the new value", async () => {
  let team = "t1";
  const teamName = (id: string) => (id === "t2" ? "Platform" : "Core");
  const { pool, queries } = setup(
    (q) =>
      // The first request carries both fields; the server forwards the value.
      q.includes("$_ref")
        ? { data: { q0: { teamId: team }, q1: { name: teamName(team) } } }
        : q.includes("teamId")
          ? { data: { q0: { teamId: team } } }
          : { data: { q0: { name: teamName(q.includes("t2") ? "t2" : "t1") } } },
    { staleTime: Infinity, serverRefs: true },
  );
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  queries.length = 0;
  team = "t2";
  pool.invalidate("user");
  await settle();
  expect(queries).toEqual(["{ q0: user(id: 1) { teamId } }", '{ q0: team(id: "t2") { name } }']);
  expect(pool.read("team", { id: teamOf }).data).toEqual({ name: "Platform" });
});

test("an unchanged dependency value does not refetch the dependent", async () => {
  const { pool, queries } = setup(
    (q) =>
      q.includes("teamId")
        ? { data: { q0: { teamId: "t1" } } }
        : { data: { q0: { name: "Core" } } },
    {
      staleTime: Infinity,
    },
  );
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  pool.invalidate("user");
  await settle();
  expect(queries).toHaveLength(3); // user, team, user again; team not refetched
});

test("a failed dependency fails its dependents instead of leaving them loading", async () => {
  const { pool } = setup(() => Promise.reject(new Error("no user")));
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  expect(pool.read("team", { id: teamOf }).error?.message).toBe("no user");
});

test("serverRefs auto: refs resolve on the client until the server identifies itself, then forward", async () => {
  const { pool, queries } = setup((q) => ({
    data:
      q.includes("teamId") && q.includes("team(")
        ? { q0: { teamId: "t2" }, q1: { name: "Platform" } }
        : q.includes("teamId")
          ? { q0: { teamId: "t1" } }
          : { q0: { name: "Core" } },
    extensions: { laguz: 1 },
  }));
  pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  expect(queries).toEqual(["{ q0: user(id: 1) { teamId } }", '{ q0: team(id: "t1") { name } }']);
  const other = ref("user", { id: 2 }, "teamId");
  pool.watch("team", { id: other }, ["name"], () => {});
  await settle();
  expect(queries[2]).toBe(
    "{ q0: user(id: 2) { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
  );
});

// --- enum arguments ---

test("enum values print bare, inside input objects and lists too", async () => {
  const { pool, queries } = setup();
  const args = {
    orderBy: { field: enumValue("CREATED_AT"), direction: enumValue("DESC") },
    states: [enumValue("OPEN"), enumValue("MERGED")],
  };
  pool.watch(
    "issues",
    args,
    ["id", { labels: { args: { order: enumValue("ASC") }, fields: ["name"] } }],
    () => {},
  );
  await tick();
  expect(queries[0]).toBe(
    `{ q0: issues(orderBy: {direction: DESC, field: CREATED_AT}, states: [OPEN, MERGED]) { id ${fieldKey("labels", { order: enumValue("ASC") })}: labels(order: ASC) { name } } }`,
  );
});

test("enum names are validated, and an enum never shares a cache entry with a string", async () => {
  expect(() => enumValue("DESC }")).toThrow();
  const { pool, queries } = setup();
  pool.watch("issues", { state: enumValue("OPEN") }, ["id"], () => {});
  pool.watch("issues", { state: "OPEN" }, ["id"], () => {});
  await tick();
  expect(queries[0]).toBe('{ q0: issues(state: OPEN) { id } q1: issues(state: "OPEN") { id } }');
});

// --- server rendering ---

test("dehydrated data hydrates another pool, refs included, without refetching", async () => {
  const server = setup((q) =>
    q.includes("teamId") ? { data: { q0: { teamId: "t1" } } } : { data: { q0: { name: "Core" } } },
  );
  await server.pool.load("team", { id: teamOf }, ["name"]);
  const state = JSON.parse(JSON.stringify(server.pool.dehydrate()));

  const client = setup(undefined, { staleTime: Infinity });
  client.pool.hydrate(state);
  expect(client.pool.read("team", { id: teamOf }).data).toEqual({ name: "Core" });
  client.pool.watch("team", { id: teamOf }, ["name"], () => {});
  await settle();
  expect(client.queries).toEqual([]);
});

test("hydrate skips failed entries and keeps newer data", async () => {
  const server = setup(() => ({
    data: { q0: { name: "old" }, q1: null },
    errors: [{ message: "nope", path: ["q1"] }],
  }));
  await Promise.all([
    server.pool.load("user", { id: 1 }, ["name"]),
    server.pool.load("user", { id: 2 }, ["name"]),
  ]);
  const state = server.pool.dehydrate();
  expect(state.map((e) => e.args)).toEqual([{ id: 1 }]);

  const client = setup(() => ({ data: { q0: { name: "new" } } }));
  await client.pool.load("user", { id: 1 }, ["name"]);
  client.pool.hydrate(state);
  expect(client.pool.read("user", { id: 1 }).data).toEqual({ name: "new" });
});

test("hydrate notifies consumers after the current task, then fetches what the server did not", async () => {
  let down = true;
  const { pool, queries } = setup(
    () => (down ? { errors: [{ message: "down" }] } : { data: { q0: { email: "a@x" } } }),
    { staleTime: Infinity },
  );
  const seen: unknown[] = [];
  pool.watch("user", { id: 1 }, ["name", "email"], () => seen.push(pool.read("user", { id: 1 })));
  await settle();
  seen.length = 0;
  queries.length = 0;
  down = false;

  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at: 1 },
  ]);
  expect(seen).toEqual([]);
  const warned = await warnings(settle);
  expect(warned).toEqual([
    "laguz: user(id: 1) was rendered on the server without { email }, so the browser fetched it after hydration. Load the same fields on the server.",
  ]);
  expect(seen[0]).toEqual({ data: { name: "Ada" }, has: toTree(["name"]) });
  expect(queries).toEqual(["{ q0: user(id: 1) { email } }"]);
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Ada", email: "a@x" });
});

test("hydrated entries match the browser's arguments after a JSON round trip", async () => {
  const args = {
    order: enumValue("DESC"),
    since: new Date(0),
    filter: { tag: "a", skip: undefined },
  };
  const server = setup(() => ({ data: { q0: [{ id: 1 }] } }));
  await server.pool.load("posts", args, ["id"]);

  const client = setup(undefined, { staleTime: Infinity });
  client.pool.hydrate(JSON.parse(JSON.stringify(server.pool.dehydrate())));
  client.pool.watch("posts", args, ["id"], () => {});
  await settle();
  expect(client.queries).toEqual([]);
  expect(client.pool.read("posts", args).data).toEqual([{ id: 1 }]);
});

test("dehydrate returns plain objects, even for results built on null prototypes", async () => {
  // graphql-js execute() returns data like this when a server pool runs in-process.
  const bare = (o: object) => Object.assign(Object.create(null), o);
  const { pool } = setup(() => ({ data: bare({ q0: bare({ owner: bare({ name: "Ada" }) }) }) }));
  await pool.load("project", { id: 1 }, [{ owner: ["name"] }]);
  const [entry] = pool.dehydrate();
  const owner = (entry!.data as { owner: object }).owner;
  expect(Object.getPrototypeOf(entry!.data)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(owner)).toBe(Object.prototype);
});

test("invalidated entries are not dehydrated", async () => {
  const { pool } = setup(() => ({ data: { q0: { name: "Ada" }, q1: { name: "Bob" } } }));
  await Promise.all([
    pool.load("user", { id: 1 }, ["name"]),
    pool.load("user", { id: 2 }, ["name"]),
  ]);
  pool.invalidate((_, args) => args === "(id: 2)");
  expect(pool.dehydrate().map((e) => e.args)).toEqual([{ id: 1 }]);
});

test("newer server data keeps the fields only the browser loaded", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada", email: "a@x" } } }), {
    staleTime: Infinity,
  });
  pool.watch("user", { id: 1 }, ["name", "email"], () => {});
  await settle();
  queries.length = 0;

  const at = Date.now() + 60_000;
  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada L." }, has: toTree(["name"]), at },
  ]);
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Ada L.", email: "a@x" });
  await settle();
  expect(queries).toEqual([]);
});

test("newer server data missing fields inside a list leaves the browser's entry alone", async () => {
  const posts = [{ id: 1, title: "Hi" }];
  const { pool, queries } = setup(() => ({ data: { q0: posts } }), { staleTime: Infinity });
  pool.watch("posts", {}, ["id", "title"], () => {});
  await settle();
  queries.length = 0;

  const at = Date.now() + 60_000;
  pool.hydrate([{ root: "posts", args: {}, data: [{ id: 2 }], has: toTree(["id"]), at }]);
  expect(pool.read("posts", {}).data).toEqual(posts);
  await settle();
  expect(queries).toEqual([]);
});

test("fresh server data over an entry invalidated while unused is not refetched", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada" } } }), {
    staleTime: Infinity,
  });
  pool.watch("user", { id: 1 }, ["name"], () => {})();
  await settle();
  pool.invalidate("user");
  queries.length = 0;

  const at = Date.now() + 60_000;
  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada L." }, has: toTree(["name"]), at },
  ]);
  pool.watch("user", { id: 1 }, ["name"], () => {});
  await settle();
  expect(queries).toEqual([]);
});

test("hydrated entries nobody reads are garbage collected", async () => {
  const { pool } = setup(undefined, { gcTime: 0 });
  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at: 1 },
  ]);
  await settle();
  expect(pool.read("user", { id: 1 }).data).toBeUndefined();
});

test("hydrating an unused entry again restarts its gcTime", async () => {
  const { pool } = setup(undefined, { gcTime: 200 });
  const state = (at: number) => [
    { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at },
  ];
  pool.hydrate(state(1));
  await new Promise((r) => setTimeout(r, 100));
  pool.hydrate(state(2));
  await new Promise((r) => setTimeout(r, 150));
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Ada" });
});

test("on the server a failure is reported at once; in the browser it is retried", async () => {
  const attempt = async () => {
    let calls = 0;
    const pool = createPool(
      async () => {
        calls++;
        return { errors: [{ message: "down" }] };
      },
      { retryDelay: () => 0 },
    );
    await pool.load("user", { id: 1 }, ["name"]);
    return calls;
  };
  expect(await attempt()).toBe(1);
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  try {
    expect(await attempt()).toBe(4);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("hydrated data older than staleTime is refetched on mount, with a warning", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "Ada" } } }), { staleTime: 50 });
  const at = Date.now() - 1000;
  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at },
  ]);
  const warned = await warnings(async () => {
    pool.watch("user", { id: 1 }, ["name"], () => {});
    await settle();
  });
  expect(queries).toEqual(["{ q0: user(id: 1) { name } }"]);
  expect(warned).toEqual([
    "laguz: user(id: 1) was fetched again right after hydration because it was older than staleTime (50 ms). Set staleTime above the time between the server render and hydration.",
  ]);
});

test("no hydration warning when the server covered the entry, or for consumers added later", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { email: "a@x" } } }), {
    staleTime: Infinity,
  });
  pool.hydrate([
    { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at: 1 },
  ]);
  const warned = await warnings(async () => {
    pool.watch("user", { id: 1 }, ["name"], () => {});
    await settle();
    pool.watch("user", { id: 1 }, ["email"], () => {});
    await settle();
  });
  expect(queries).toEqual(["{ q0: user(id: 1) { email } }"]);
  expect(warned).toEqual([]);
});

test("no hydration warning in production", async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const { pool } = setup(() => ({ data: { q0: { email: "a@x" } } }));
    pool.hydrate([
      { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at: 1 },
    ]);
    const warned = await warnings(async () => {
      pool.watch("user", { id: 1 }, ["name", "email"], () => {});
      await settle();
    });
    expect(warned).toEqual([]);
  } finally {
    process.env.NODE_ENV = env;
  }
});

test("gcTime Infinity keeps unused entries", async () => {
  const { pool } = setup(() => ({ data: { q0: { name: "Ada" } } }), { gcTime: Infinity });
  const stop = pool.watch("user", { id: 42 }, ["name"], () => {});
  await settle();
  stop();
  await new Promise((r) => setTimeout(r, 10));
  expect(pool.read("user", { id: 42 }).data).toEqual({ name: "Ada" });
});

// --- schema mutations ---

test("a mutation goes out on its own, not in the query batch, and resolves to its selection", async () => {
  const avatar = fieldKey("avatar", { size: 2 });
  const { pool, queries } = setup((q) =>
    q.startsWith("mutation")
      ? { data: { rename: { name: "Ada", [avatar]: "a.png" } } }
      : { data: { q0: { name: "Bob" } } },
  );
  pool.watch("user", { id: 1 }, ["name"], () => {});
  const result = pool.mutate("rename", { id: 1, name: "Ada" }, [
    "name",
    { avatar: { args: { size: 2 } } },
  ]);
  await settle();
  // Sent right away, without waiting for the end of the task like queries.
  expect(queries).toEqual([
    `mutation { rename(id: 1, name: "Ada") { name ${avatar}: avatar(size: 2) } }`,
    "{ q0: user(id: 1) { name } }",
  ]);
  expect(await result).toEqual({ name: "Ada", avatar: "a.png" });
});

test("a failed mutation rejects with the server's message, is not retried, and rolls back", async () => {
  const { pool, queries } = setup(
    (q) =>
      q.startsWith("mutation")
        ? { data: null, errors: [{ message: "name taken", path: ["rename"] }] }
        : { data: { q0: { name: "Bob" } } },
    { retry: 3, retryDelay: () => 0, staleTime: Infinity },
  );
  pool.watch("user", { id: 1 }, ["name"], () => {});
  await settle();
  queries.length = 0;
  const result = pool.mutate("rename", { id: 1, name: "Ada" }, ["name"], {
    optimistic: [["user", { id: 1 }, (u) => ({ ...u, name: "Ada" })]],
    invalidate: ["user"],
  });
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Ada" });
  await expect(result).rejects.toThrow("name taken");
  await settle();
  expect(queries.filter((q) => q.startsWith("mutation"))).toHaveLength(1);
  expect(queries).toContain("{ q0: user(id: 1) { name } }"); // invalidated either way
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Bob" });
});

test("a mutation from a streaming fetcher, and refs refused in mutation arguments", async () => {
  const pool = createPool(async function* () {
    yield { data: { rename: { name: "Ada" } }, extensions: { laguz: 1 } };
  });
  expect(await pool.mutate("rename", { id: 1, name: "Ada" }, ["name"])).toEqual({ name: "Ada" });
  const empty = createPool(async () => ({ data: null }));
  await expect(empty.mutate("rename", { id: 1, name: "Ada" }, ["name"])).rejects.toThrow(
    "no data in response",
  );
  await expect(
    pool.mutate("rename", { id: ref("user", { id: 1 }, "id") }, ["name"]),
  ).rejects.toThrow("ref() arguments only work in queries");
});

// --- background refresh ---

test("fetching is on only while shown data refreshes; a first load notifies once", async () => {
  let next = deferred<Response>();
  const { pool } = setup(() => next.promise, { staleTime: Infinity });
  let calls = 0;
  pool.watch("user", { id: 1 }, ["name"], () => calls++);
  await settle();
  next.resolve({ data: { q0: { name: "Ada" } } });
  await settle();
  expect(calls).toBe(1);
  expect(pool.read("user", { id: 1 }).fetching).toBeUndefined();

  next = deferred();
  pool.invalidate("user", { id: 1 });
  await settle();
  expect(pool.read("user", { id: 1 })).toMatchObject({ data: { name: "Ada" }, fetching: true });
  next.resolve({ data: { q0: { name: "Ada L." } } });
  await settle();
  expect(pool.read("user", { id: 1 }).fetching).toBeUndefined();
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Ada L." });
});

test("invalidate(root, args) refetches that one entry", async () => {
  const { pool, queries } = setup(() => ({ data: { q0: { name: "x" }, q1: { name: "y" } } }), {
    staleTime: Infinity,
  });
  pool.watch("user", { id: 1 }, ["name"], () => {});
  pool.watch("user", { id: 2 }, ["name"], () => {});
  await settle();
  queries.length = 0;
  pool.invalidate("user", { id: 2 });
  await settle();
  expect(queries).toEqual(["{ q0: user(id: 2) { name } }"]);
});

test("a dropped refresh turns fetching off: a write during it, or invalidating it unused", async () => {
  let next = deferred<Response>();
  const { pool } = setup(() => next.promise, { staleTime: Infinity });
  const stop = pool.watch("user", { id: 1 }, ["name"], () => {});
  await settle();
  next.resolve({ data: { q0: { name: "Ada" } } });
  await settle();

  next = deferred();
  pool.invalidate("user");
  await settle();
  pool.set("user", { id: 1 }, () => ({ name: "Mine" }));
  expect(pool.read("user", { id: 1 }).fetching).toBeUndefined();
  next.resolve({ data: { q0: { name: "Theirs" } } });
  await settle();
  expect(pool.read("user", { id: 1 }).data).toEqual({ name: "Mine" });

  next = deferred();
  pool.invalidate("user");
  await settle();
  expect(pool.read("user", { id: 1 }).fetching).toBe(true);
  stop();
  pool.invalidate("user");
  expect(pool.read("user", { id: 1 }).fetching).toBeUndefined();
});

test("a refresh being retried stays fetching; when it fails, the error shows with the data", async () => {
  let fail = false;
  const { pool } = setup(
    () => (fail ? { errors: [{ message: "down" }] } : { data: { q0: { name: "Ada" } } }),
    { staleTime: Infinity, retry: 1, retryDelay: () => 20 },
  );
  pool.watch("user", { id: 1 }, ["name"], () => {});
  await settle();
  fail = true;
  pool.invalidate("user");
  await settle();
  expect(pool.read("user", { id: 1 }).fetching).toBe(true);
  expect(pool.read("user", { id: 1 }).error).toBeUndefined();
  await new Promise((r) => setTimeout(r, 40));
  await settle();
  expect(pool.read("user", { id: 1 })).toMatchObject({
    data: { name: "Ada" },
    error: new Error("down"),
  });
  expect(pool.read("user", { id: 1 }).fetching).toBeUndefined();
});
