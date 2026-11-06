// The hooks in a browser-like DOM. happy-dom is registered for this file only:
// a global `window` would turn every other test's pool into a browser pool.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import type { Pool, Response } from "./index.ts";

let React: typeof import("react");
let client: typeof import("react-dom/client");
let lib: typeof import("./index.ts");
let hooks: typeof import("./react.ts");

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // react-dom checks for a DOM when it loads.
  React = await import("react");
  client = await import("react-dom/client");
  lib = await import("./index.ts");
  hooks = await import("./react.ts");
});
afterAll(() => GlobalRegistrator.unregister());

// Every query waits until the test answers it.
function server(options: Parameters<typeof lib.createPool>[1] = {}) {
  const queries: string[] = [];
  const answers: ((res: Response) => void)[] = [];
  const pool = lib.createPool(
    (query) => {
      queries.push(query);
      return new Promise<Response>((resolve) => answers.push(resolve));
    },
    { retry: 0, ...options },
  );
  const answer = (res: Response) => React.act(async () => answers.shift()!(res));
  return { pool, queries, answer };
}

async function mount(ui: ReactElement) {
  const root = client.createRoot(document.createElement("div"));
  await React.act(async () => root.render(ui));
  return {
    rerender: (next: ReactElement) => React.act(async () => root.render(next)),
    unmount: () => React.act(async () => root.unmount()),
  };
}

test("everything one commit renders goes out as one request", async () => {
  const { pool, queries } = server();
  const Field = ({ root }: { root: string }) => (hooks.useData(pool, root, {}, ["id"]), null);
  const { unmount } = await mount(
    React.createElement(
      React.Fragment,
      null,
      ["user", "stats", "feed"].map((root) => React.createElement(Field, { root, key: root })),
    ),
  );
  expect(queries).toEqual(["{ q0: user { id } q1: stats { id } q2: feed { id } }"]);
  await unmount();
});

type Seen = { data?: unknown; previous: boolean; loading: boolean; error?: Error };

function user(pool: Pool, seen: Record<string, Seen>) {
  return function User({ id, keep }: { id: number | null; keep: boolean }) {
    const r = hooks.useData(pool, "user", id === null ? null : { id }, ["name"], {
      keepPrevious: keep,
    });
    seen[String(keep)] = r;
    return null;
  };
}

test("keepPrevious shows the previous arguments' data until the new data arrives", async () => {
  const { pool, answer } = server();
  const seen: Record<string, Seen> = {};
  const User = user(pool, seen);
  const both = (id: number) =>
    React.createElement(React.Fragment, null, [
      React.createElement(User, { id, keep: true, key: "a" }),
      React.createElement(User, { id, keep: false, key: "b" }),
    ]);
  const { rerender, unmount } = await mount(both(1));
  await answer({ data: { q0: { name: "Ada" } } });
  // A refetch under the same arguments updates what "previous" means.
  await React.act(async () => pool.invalidate("user"));
  await answer({ data: { q0: { name: "Ada L." } } });

  await rerender(both(2));
  expect(seen.true).toMatchObject({ data: { name: "Ada L." }, previous: true, loading: true });
  expect(seen.false).toMatchObject({ data: undefined, previous: false, loading: true });

  await answer({ data: { q0: { name: "Bob" } } });
  expect(seen.true).toMatchObject({ data: { name: "Bob" }, previous: false, loading: false });
  await unmount();
});

test("keepPrevious keeps data while arguments are null, but an error replaces it", async () => {
  const { pool, answer } = server();
  const seen: Record<string, Seen> = {};
  const User = user(pool, seen);
  const { rerender, unmount } = await mount(React.createElement(User, { id: 1, keep: true }));
  await answer({ data: { q0: { name: "Ada" } } });

  await rerender(React.createElement(User, { id: null, keep: true }));
  expect(seen.true).toMatchObject({ data: { name: "Ada" }, previous: true, loading: false });

  await rerender(React.createElement(User, { id: 3, keep: true }));
  await answer({ errors: [{ message: "nope", path: ["q0"] }] });
  expect(seen.true).toMatchObject({ data: undefined, previous: false, loading: false });
  expect(seen.true!.error?.message).toBe("nope");
  await unmount();
});

type FeedPage = { items: string[]; next: string | null };
type Feed = ReturnType<typeof hooks.useInfiniteData<FeedPage>>;

function feed(pool: Pool, out: { list?: Feed }) {
  return function List({ tag, keep }: { tag: string; keep?: boolean }) {
    out.list = hooks.useInfiniteData<FeedPage>(
      pool,
      (prev, i) =>
        i === 0 || prev?.next
          ? { root: "feed", args: { tag, after: prev?.next ?? null }, fields: ["items", "next"] }
          : null,
      { keepPrevious: keep },
    );
    return null;
  };
}

test("an infinite list starts over at one page when the first page's arguments change", async () => {
  const { pool, queries, answer } = server();
  const out: { list?: Feed } = {};
  const List = feed(pool, out);
  const { rerender, unmount } = await mount(React.createElement(List, { tag: "a" }));
  await answer({ data: { q0: { items: ["a1"], next: "c1" } } });
  await React.act(async () => out.list!.loadMore());
  await answer({ data: { q0: { items: ["a2"], next: "c2" } } });
  expect(out.list!.pages.flatMap((p) => p.items)).toEqual(["a1", "a2"]);

  queries.length = 0;
  await rerender(React.createElement(List, { tag: "b" }));
  await answer({ data: { q0: { items: ["b1"], next: "c3" } } });
  expect(queries).toEqual(['{ q0: feed(after: null, tag: "b") { items next } }']);
  expect(out.list!.pages.flatMap((p) => p.items)).toEqual(["b1"]);
  expect(out.list!.hasMore).toBe(true);

  // "Show more" still works on the new list.
  await React.act(async () => out.list!.loadMore());
  await answer({ data: { q0: { items: ["b2"], next: null } } });
  expect(out.list!.pages.flatMap((p) => p.items)).toEqual(["b1", "b2"]);
  await unmount();
});

test("keepPrevious shows the previous list until the new first page arrives", async () => {
  const { pool, answer } = server();
  const out: { list?: Feed } = {};
  const List = feed(pool, out);
  const { rerender, unmount } = await mount(React.createElement(List, { tag: "a", keep: true }));
  await answer({ data: { q0: { items: ["a1"], next: "c1" } } });

  await rerender(React.createElement(List, { tag: "b", keep: true }));
  expect(out.list).toMatchObject({ previous: true, loading: true, hasMore: false });
  expect(out.list!.pages.flatMap((p) => p.items)).toEqual(["a1"]);

  await answer({ data: { q0: { items: ["b1"], next: null } } });
  expect(out.list).toMatchObject({ previous: false, loading: false, hasMore: false });
  expect(out.list!.pages.flatMap((p) => p.items)).toEqual(["b1"]);

  await rerender(React.createElement(List, { tag: "c", keep: true }));
  await answer({ errors: [{ message: "nope", path: ["q0"] }] });
  expect(out.list).toMatchObject({ previous: false, loading: false, pages: [] });
  expect(out.list!.error?.message).toBe("nope");
  await unmount();
});

type MutationSeen = ReturnType<typeof hooks.useMutation<unknown, unknown>>;

test("useMutation: pending then data, optimistic writes built from the variables", async () => {
  const { pool, queries, answer } = server();
  const out: { m?: MutationSeen; name?: unknown } = {};
  function Rename() {
    out.m = hooks.useMutation(pool, "rename", ["name"], (vars: { id: number; name: string }) => ({
      optimistic: [["user", { id: vars.id }, (u: object) => ({ ...u, name: vars.name })]],
    })) as MutationSeen;
    out.name = hooks.useData(pool, "user", { id: 1 }, ["name"]).data?.name;
    return null;
  }
  const { unmount } = await mount(React.createElement(Rename));
  await answer({ data: { q0: { name: "Bob" } } });

  let done!: Promise<unknown>;
  await React.act(async () => void (done = out.m!.mutate({ id: 1, name: "Ada" })));
  expect(queries.at(-1)).toBe('mutation { rename(id: 1, name: "Ada") { name } }');
  expect(out.m).toMatchObject({ pending: true, data: undefined });
  expect(out.name).toBe("Ada");

  await answer({ data: { rename: { name: "Ada" } } });
  expect(await done).toEqual({ name: "Ada" });
  expect(out.m).toMatchObject({ pending: false, data: { name: "Ada" }, error: undefined });
  await unmount();
});

test("useMutation: an error lands in state, rolls back, and an unawaited call doesn't throw", async () => {
  const { pool, answer } = server();
  const out: { m?: MutationSeen; name?: unknown } = {};
  function Rename() {
    out.m = hooks.useMutation(pool, "rename", ["name"], {
      optimistic: [["user", { id: 1 }, (u: object) => ({ ...u, name: "Ada" })]],
    }) as MutationSeen;
    out.name = hooks.useData(pool, "user", { id: 1 }, ["name"]).data?.name;
    return null;
  }
  const { unmount } = await mount(React.createElement(Rename));
  await answer({ data: { q0: { name: "Bob" } } });

  // Not awaited and not caught, like an onClick handler: no unhandled rejection.
  await React.act(async () => void out.m!.mutate({ id: 1, name: "Ada" }));
  await answer({ errors: [{ message: "name taken" }] });
  expect(out.m!.error?.message).toBe("name taken");
  expect(out.m).toMatchObject({ pending: false, data: undefined });
  expect(out.name).toBe("Bob");
  await unmount();
});

test("useMutation: only the latest call updates the state, and reset forgets a running one", async () => {
  const { pool } = server();
  const calls: ((v: string) => void)[] = [];
  const out: { m?: MutationSeen } = {};
  function Save() {
    // Any async function works, e.g. a server action.
    out.m = hooks.useMutation(
      pool,
      () => new Promise<string>((resolve) => calls.push(resolve)),
    ) as MutationSeen;
    return null;
  }
  const { unmount } = await mount(React.createElement(Save));
  await React.act(async () => void out.m!.mutate(1));
  await React.act(async () => void out.m!.mutate(2));
  await React.act(async () => calls[1]!("second"));
  await React.act(async () => calls[0]!("first"));
  expect(out.m).toMatchObject({ data: "second", pending: false });

  await React.act(async () => void out.m!.mutate(3));
  await React.act(async () => out.m!.reset());
  await React.act(async () => calls[2]!("third"));
  expect(out.m).toMatchObject({ data: undefined, pending: false, error: undefined });
  await unmount();
});

test("useMutation: a call uses the options of the latest render", async () => {
  const { pool, queries, answer } = server();
  const out: { m?: MutationSeen } = {};
  function Save({ refresh }: { refresh: string }) {
    hooks.useData(pool, "user", { id: 1 }, ["name"]);
    out.m = hooks.useMutation(pool, async () => "ok", { invalidate: [refresh] }) as MutationSeen;
    return null;
  }
  const { rerender, unmount } = await mount(React.createElement(Save, { refresh: "nothing" }));
  await answer({ data: { q0: { name: "Bob" } } });
  await rerender(React.createElement(Save, { refresh: "user" }));
  queries.length = 0;
  await React.act(async () => void (await out.m!.mutate(undefined)));
  expect(queries).toEqual(["{ q0: user(id: 1) { name } }"]);
  await answer({ data: { q0: { name: "Bob" } } });
  await unmount();
});

test("refetch keeps the data on screen with fetching, for one entry or every page of a list", async () => {
  const { pool, queries, answer } = server();
  const out: { user?: ReturnType<typeof hooks.useData>; list?: Feed } = {};
  const List = feed(pool, out);
  function Page() {
    out.user = hooks.useData(pool, "user", { id: 1 }, ["name"]);
    hooks.useData(pool, "user", { id: 2 }, ["name"]);
    return React.createElement(List, { tag: "a" });
  }
  const { unmount } = await mount(React.createElement(Page));
  // Children subscribe first: the list is q0.
  await answer({
    data: { q0: { items: ["a1"], next: "c1" }, q1: { name: "Ada" }, q2: { name: "Bob" } },
  });
  await React.act(async () => out.list!.loadMore());
  await answer({ data: { q0: { items: ["a2"], next: null } } });

  queries.length = 0;
  await React.act(async () => out.user!.refetch());
  expect(queries).toEqual(["{ q0: user(id: 1) { name } }"]);
  expect(out.user).toMatchObject({ data: { name: "Ada" }, fetching: true, loading: false });
  await answer({ data: { q0: { name: "Ada L." } } });
  expect(out.user).toMatchObject({ data: { name: "Ada L." }, fetching: false });

  queries.length = 0;
  await React.act(async () => out.list!.refetch());
  expect(queries).toEqual([
    '{ q0: feed(after: null, tag: "a") { items next } q1: feed(after: "c1", tag: "a") { items next } }',
  ]);
  expect(out.list).toMatchObject({ fetching: true, loading: false });
  await answer({ data: { q0: { items: ["a1"], next: "c1" }, q1: { items: ["a2"], next: null } } });
  expect(out.list!.fetching).toBe(false);
  await unmount();
});

// --- refetch on focus, reconnect, interval ---

// Answers every root field of a batch with its alias, so tests can see what was asked.
function echo(options: Parameters<typeof lib.createPool>[1] = {}) {
  const queries: string[] = [];
  let failing = false;
  const pool = lib.createPool(
    async (query) => {
      queries.push(query);
      if (failing) return { errors: [{ message: "offline" }] };
      const data = Object.fromEntries((query.match(/q\d+/g) ?? []).map((a) => [a, { name: a }]));
      return { data };
    },
    { retry: 0, ...options },
  );
  return { pool, queries, fail: (on: boolean) => (failing = on) };
}

// Generous: the conditions come true by themselves, a loaded machine just takes longer.
async function until(condition: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let visibility: DocumentVisibilityState = "visible";
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("back on the tab, entries in use older than staleTime refetch together", async () => {
  const { pool, queries } = echo({ staleTime: 30 });
  pool.watch("user", { id: 1 }, ["name"], () => {});
  pool.watch("user", { id: 2 }, ["name"], () => {});
  await pool.load("user", { id: 3 }, ["name"]); // loaded, then nobody uses it
  await until(() => !!pool.read("user", { id: 2 }).data);
  queries.length = 0;

  setVisibility("visible"); // still fresh
  await wait(50);
  setVisibility("hidden"); // stale, but the tab is hidden
  await wait(10);
  expect(queries).toEqual([]);

  setVisibility("visible");
  await until(() => queries.length > 0);
  expect(queries).toEqual(["{ q0: user(id: 1) { name } q1: user(id: 2) { name } }"]);
});

test("when the network comes back, failed entries in use are retried, retries included", async () => {
  const { pool, queries, fail } = echo({ staleTime: Infinity, retry: 1, retryDelay: () => 5 });
  fail(true);
  pool.watch("user", { id: 1 }, ["name"], () => {});
  await until(() => !!pool.read("user", { id: 1 }).error);
  expect(queries).toHaveLength(2);
  window.dispatchEvent(new Event("online")); // still offline: a fresh retry budget
  await until(() => queries.length === 4);
  fail(false);
  queries.length = 0;
  window.dispatchEvent(new Event("online"));
  await until(() => !!pool.read("user", { id: 1 }).data);
  expect(queries).toEqual(["{ q0: user(id: 1) { name } }"]);
  expect(pool.read("user", { id: 1 }).error).toBeUndefined();
});

test("refetchOnFocus and refetchOnReconnect can be turned off", async () => {
  const { pool, queries, fail } = echo({
    staleTime: 0,
    refetchOnFocus: false,
    refetchOnReconnect: false,
  });
  fail(true);
  pool.watch("user", { id: 1 }, ["name"], () => {});
  await until(() => !!pool.read("user", { id: 1 }).error);
  queries.length = 0;
  setVisibility("visible");
  window.dispatchEvent(new Event("online"));
  await wait(30);
  expect(queries).toEqual([]);
});

test("entries polled at the same interval share each request, until their last consumer leaves", async () => {
  // Count the pool's live timers: a leaked one would poll forever.
  const live = new Set<unknown>();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const id = set(fn, ms);
    live.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    live.delete(id);
    clear(id);
  }) as typeof clearInterval;
  try {
    await polling();
  } finally {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  }
  expect(live.size).toBe(0);
});

async function polling() {
  const { pool, queries } = echo({ staleTime: Infinity });
  function User() {
    hooks.useData(pool, "user", { id: 1 }, ["name"], { refetchInterval: 40 });
    return null;
  }
  const { unmount } = await mount(React.createElement(User));
  await until(() => !!pool.read("user", { id: 1 }).data);
  const stop = pool.watch("user", { id: 2 }, ["name"], () => {}, { refetchInterval: 40 });
  await until(() => !!pool.read("user", { id: 2 }).data);
  queries.length = 0;

  await until(() => queries.length > 0);
  expect(queries).toEqual(["{ q0: user(id: 1) { name } q1: user(id: 2) { name } }"]);

  setVisibility("hidden");
  queries.length = 0;
  await wait(100);
  expect(queries).toEqual([]);
  setVisibility("visible");

  await unmount();
  stop();
  await wait(100);
  // No longer polled, so still fresh: mounting again doesn't refetch.
  queries.length = 0;
  pool.watch("user", { id: 1 }, ["name"], () => {})();
  await wait(10);
  expect(queries).toEqual([]);
}

test("a query described once loads on the server and renders hydrated in the browser", async () => {
  const query = lib.queries();
  const user = (id: number) => query("user", { id }, ["name"]);
  const backend = lib.createPool(async () => ({ data: { q0: { name: "Ada" } } }));
  await backend.load(user(1));

  const { pool, queries } = server({ staleTime: 60_000 });
  pool.hydrate(JSON.parse(JSON.stringify(backend.dehydrate())));
  const seen: { result?: Seen } = {};
  function Profile({ id }: { id: number | null }) {
    seen.result = hooks.useData(pool, id === null ? null : user(id), { keepPrevious: true });
    return null;
  }
  const { rerender, unmount } = await mount(React.createElement(Profile, { id: 1 }));
  expect(seen.result).toMatchObject({ data: { name: "Ada" }, previous: false });
  // Skipped with null; the options still apply.
  await rerender(React.createElement(Profile, { id: null }));
  expect(seen.result).toMatchObject({ data: { name: "Ada" }, previous: true, loading: false });
  expect(queries).toEqual([]);
  await unmount();
});

test("unmounting aborts a request nobody else waits for; StrictMode's remount keeps it", async () => {
  const signals: AbortSignal[] = [];
  const answers: ((res: Response) => void)[] = [];
  const pool = lib.createPool(
    (_, o) => (signals.push(o!.signal!), new Promise<Response>((resolve) => answers.push(resolve))),
    { retry: 0 },
  );
  const seen: { data?: unknown } = {};
  function User() {
    seen.data = hooks.useData(pool, "user", { id: 1 }, ["name"]).data;
    return null;
  }
  const strict = await mount(
    React.createElement(React.StrictMode, null, React.createElement(User)),
  );
  await React.act(async () => answers[0]!({ data: { q0: { name: "Ada" } } }));
  expect(signals[0]!.aborted).toBe(false);
  expect(seen.data).toEqual({ name: "Ada" });
  await strict.unmount();

  const other = await mount(
    React.createElement(() => (hooks.useData(pool, "user", { id: 2 }, ["name"]), null)),
  );
  await other.unmount();
  expect(signals.at(-1)!.aborted).toBe(true);
});
