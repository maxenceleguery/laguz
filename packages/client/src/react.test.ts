// Server rendering. Effects and subscriptions never run in renderToString, so
// these check what the first HTML contains, which the browser must reproduce.
import { expect, test } from "bun:test";
import { createElement as h, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { createPool, toTree, type Dehydrated, type Pool } from "./index.ts";
import { useData, useHydrate, useInfiniteData, useSuspenseData } from "./react.ts";

const never = () => new Promise<never>(() => {});
const user: Dehydrated = [
  { root: "user", args: { id: 1 }, data: { name: "Ada" }, has: toTree(["name"]), at: 1 },
];

function Field({ pool, field }: { pool: Pool; field: string }) {
  const { data, loading } = useData(pool, "user", { id: 1 }, [field]);
  return h("p", null, loading ? "loading" : data?.[field]);
}

test("useHydrate fills the pool before the components below render; the rest renders loading", () => {
  const pool = createPool(never);
  function Page() {
    useHydrate(pool, user);
    return [h(Field, { pool, field: "name", key: 1 }), h(Field, { pool, field: "email", key: 2 })];
  }
  expect(renderToString(h(Page))).toBe("<p>Ada</p><p>loading</p>");
});

test("useSuspenseData renders hydrated data instead of the fallback", () => {
  const pool = createPool(never);
  pool.hydrate(user);
  function Name() {
    return h("p", null, useSuspenseData(pool, "user", { id: 1 }, ["name"]).name);
  }
  const html = renderToString(h(Suspense, { fallback: "wait" }, h(Name)));
  expect(html).toContain("<p>Ada</p>");
  expect(html).not.toContain("wait");
});

test("useInfiniteData walks hydrated pages by cursor on the server", () => {
  const pool = createPool(never);
  const page = (after: string | null, items: string[], next: string | null) => ({
    root: "feed",
    args: { after },
    data: { items, next },
    has: toTree(["items", "next"]),
    at: 1,
  });
  pool.hydrate([page(null, ["a", "b"], "c1"), page("c1", ["c"], null)]);
  function Feed() {
    const { pages, hasMore } = useInfiniteData<{ items: string[]; next: string | null }>(
      pool,
      (prev, i) =>
        i === 0 || prev?.next
          ? { root: "feed", args: { after: prev?.next ?? null }, fields: ["items", "next"] }
          : null,
      { prefetch: 1 },
    );
    return h("p", null, `${pages.flatMap((p) => p.items).join()} more:${hasMore}`);
  }
  expect(renderToString(h(Feed))).toBe("<p>a,b more:true</p>");
});
