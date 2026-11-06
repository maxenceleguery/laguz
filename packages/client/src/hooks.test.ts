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
function server() {
  const queries: string[] = [];
  const answers: ((res: Response) => void)[] = [];
  const pool = lib.createPool(
    (query) => {
      queries.push(query);
      return new Promise<Response>((resolve) => answers.push(resolve));
    },
    { retry: 0 },
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
