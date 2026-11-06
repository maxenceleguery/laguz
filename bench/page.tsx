// Demo + benchmark page. Same components, different data layers:
//   tanstack       one useQuery per widget (the traditional baseline)
//   pool           laguz, one JSON request per turn
//   pool-stream    laguz, one request per turn, fields streamed as they resolve
//   pool-refs      pool-stream + server-forwarded refs (chain view)
//   pool-prefetch  pool-stream + one page prefetched ahead (feed view)
//   *-suspense     suspense hooks under one shared <Suspense>; *-suspense-each: one boundary per widget
// Views: ?view=dashboard (20 widgets), feed (infinite list), chain (3-level dependency).
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  createPool,
  httpFetcher,
  printField,
  ref,
  view,
  type Fetcher,
  type Fields,
} from "@laguzjs/client";
import { useData, useInfiniteData, useSuspenseData } from "@laguzjs/client/react";

const VIEWS = {
  dashboard: [
    "tanstack",
    "pool",
    "pool-stream",
    "tanstack-suspense",
    "pool-suspense",
    "tanstack-suspense-each",
    "pool-suspense-each",
  ],
  feed: ["tanstack", "pool-stream", "pool-prefetch"],
  chain: ["tanstack", "pool-stream", "pool-refs"],
} as const;
const params = new URLSearchParams(location.search);
const screen = (params.get("view") ?? "dashboard") as keyof typeof VIEWS;
const mode = params.get("mode") ?? "pool-stream";
const tanstack = mode.startsWith("tanstack");
const suspense = mode.includes("suspense");

// Request tracking, identical for every mode
let inflight = 0;
let lastDone = 0;
let waiters: (() => void)[] = [];
const begin = () => void inflight++;
const end = () => {
  lastDone = performance.now();
  if (--inflight === 0)
    setTimeout(() => {
      if (inflight) return;
      waiters.forEach((w) => w());
      waiters = [];
    });
};
// Resolves once nothing is in flight; started requests count, even from a later microtask.
const idle = () => new Promise<void>((r) => setTimeout(() => (inflight ? waiters.push(r) : r())));

async function post(query: string) {
  begin();
  try {
    const res = await fetch("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data;
  } finally {
    end();
  }
}

// The two data layers
const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, refetchOnWindowFocus: false } },
});
const base = httpFetcher("/graphql", { stream: mode !== "pool" });
const tracked: Fetcher = (q) => {
  begin();
  const r = base(q);
  return (async function* () {
    try {
      yield* Symbol.asyncIterator in r ? r : [await r];
    } finally {
      end();
    }
  })();
};
const newPool = () => createPool(tracked, { serverRefs: mode === "pool-refs" });
let pool = newPool();

// Completion marks: the benchmark waits for `expected` of them
let marks: Record<string, number> = {};
let allReady!: () => void;
let ready = new Promise<void>((r) => (allReady = r));
let expected = 1;
function useMark(id: string, done: boolean) {
  const marked = useRef(false);
  useLayoutEffect(() => {
    if (!done || marked.current) return;
    marked.current = true;
    marks[id] = performance.now();
    if (Object.keys(marks).length === expected) allReady();
  }, [done]);
}

// Dashboard
type Spec = { id: string; root: string; args: Record<string, unknown>; fields: Fields };
const queryOf = (s: Spec) => ({
  queryKey: [s.root, s.args, s.fields],
  queryFn: () =>
    post(`{ ${printField(s.root, s.args, s.fields)} }`).then((d) => view(d[s.root], s.fields)),
});
const useWidget = tanstack
  ? suspense
    ? (s: Spec) => useSuspenseQuery(queryOf(s)).data
    : (s: Spec) => useQuery(queryOf(s)).data
  : suspense
    ? (s: Spec) => useSuspenseData(pool, s.root, s.args, s.fields)
    : (s: Spec) => useData(pool, s.root, s.args, s.fields).data;

const NEW_NAME = "Ada (renamed)";
const mutation = `mutation { renameUser(id: 1, name: ${JSON.stringify(NEW_NAME)}) { id } }`;
const touchesUser = (root: string) => root === "user" || root === "project";

async function rename() {
  if (!tanstack)
    return pool.mutate(() => post(mutation), {
      optimistic: [["user", { id: 1 }, (u) => u && { ...u, name: NEW_NAME }]],
      invalidate: [(root) => touchesUser(root)],
    });
  // TanStack's documented optimistic recipe: cancel, snapshot, write, rollback on error, invalidate.
  await qc.cancelQueries({ queryKey: ["user"] });
  const prev = qc.getQueriesData({ queryKey: ["user"] });
  qc.setQueriesData({ queryKey: ["user"] }, (u: any) => u && { ...u, name: NEW_NAME });
  try {
    return await post(mutation);
  } catch (e) {
    prev.forEach(([k, d]) => qc.setQueryData(k, d));
    throw e;
  } finally {
    qc.invalidateQueries({ predicate: (q) => touchesUser(q.queryKey[0] as string) });
  }
}

const specs: Spec[] = [
  // Two avatar sizes on one user: field arguments, aliased and merged into one entry.
  {
    id: "header",
    root: "user",
    args: { id: 1 },
    fields: ["name", { avatar: { args: { size: 32 } } }],
  },
  {
    id: "card",
    root: "user",
    args: { id: 1 },
    fields: ["name", "email", { avatar: { args: { size: 128 } } }],
  },
  { id: "notifications", root: "notifications", args: {}, fields: ["id", "message"] },
  { id: "stats", root: "stats", args: {}, fields: ["activeUsers", "revenue"] },
  ...Array.from({ length: 8 }, (_, i): Spec => ({
    id: `project${i}`,
    root: "project",
    args: { id: `p${i}` },
    fields: ["name", "tasks", { owner: ["name"] }],
  })),
  ...Array.from({ length: 8 }, (_, i): Spec => ({
    id: `activity${i}`,
    root: "activity",
    args: { projectId: `p${i}` },
    fields: ["id", "text", "at"],
  })),
];

function Widget({ spec }: { spec: Spec }) {
  const data = useWidget(spec);
  useMark(spec.id, data !== undefined);
  let body: ReactNode = "loading";
  if (data !== undefined)
    body =
      spec.id === "header" ? <b id="username">{data.name}</b> : <pre>{JSON.stringify(data)}</pre>;
  return (
    <section>
      <h3>{spec.id}</h3>
      {body}
    </section>
  );
}

const each = mode.endsWith("-each");
const widgets = specs.map((s) =>
  each ? (
    <Suspense
      key={s.id}
      fallback={
        <section>
          <h3>{s.id}</h3>loading
        </section>
      }
    >
      <Widget spec={s} />
    </Suspense>
  ) : (
    <Widget key={s.id} spec={s} />
  ),
);
const Dashboard = () => (
  <main>{suspense && !each ? <Suspense fallback="loading">{widgets}</Suspense> : widgets}</main>
);

// Feed: cursor pagination
type FeedPage = {
  edges: { cursor: string; node: { id: string; text: string } }[];
  pageInfo: { endCursor: string; hasNextPage: boolean };
};
const feedFields: Fields = [
  { edges: ["cursor", { node: ["id", "text"] }] },
  { pageInfo: ["endCursor", "hasNextPage"] },
];
const feedArgs = (after?: string | null) => (after ? { first: 10, after } : { first: 10 });
const feedCtl = { pages: 0, loadMore: () => {}, waiters: [] as (() => void)[] };

function useFeed() {
  if (tanstack) {
    const q = useInfiniteQuery({
      queryKey: ["feed"],
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) =>
        post(`{ ${printField("feed", feedArgs(pageParam), feedFields)} }`).then(
          (d) => view(d.feed, feedFields) as FeedPage,
        ),
      getNextPageParam: (last) => (last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined),
    });
    return {
      pages: q.data?.pages ?? [],
      loadMore: () => void q.fetchNextPage(),
      hasMore: q.hasNextPage,
    };
  }
  return useInfiniteData<FeedPage>(
    pool,
    (prev, i) =>
      i === 0 || prev?.pageInfo.hasNextPage
        ? { root: "feed", args: feedArgs(prev?.pageInfo.endCursor), fields: feedFields }
        : null,
    { prefetch: mode === "pool-prefetch" ? 1 : 0 },
  );
}

function Feed() {
  const { pages, loadMore, hasMore } = useFeed();
  useMark("feed", pages.length > 0);
  feedCtl.loadMore = loadMore;
  useLayoutEffect(() => {
    feedCtl.pages = pages.length;
    feedCtl.waiters.forEach((w) => w());
    feedCtl.waiters = [];
  }, [pages.length]);
  return (
    <main style={{ display: "block" }}>
      <ol>{pages.flatMap((p) => p.edges.map((e) => <li key={e.node.id}>{e.node.text}</li>))}</ol>
      {hasMore && <button onClick={loadMore}>Load more</button>}
    </main>
  );
}

// Chain: user -> team -> lead
const leadRef = ref("team", { id: ref("user", { id: 1 }, "teamId") }, "leadId");
function useLead(): string | undefined {
  if (tanstack) {
    // TanStack's dependent-query recipe: `enabled` waits for the previous query.
    const u = useQuery({
      queryKey: ["user", 1, "teamId"],
      queryFn: () => post(`{ user(id: 1) { teamId } }`).then((d) => d.user),
    });
    const teamId = u.data?.teamId;
    const t = useQuery({
      queryKey: ["team", teamId],
      enabled: !!teamId,
      queryFn: () =>
        post(`{ ${printField("team", { id: teamId }, ["leadId"])} }`).then((d) => d.team),
    });
    const leadId = t.data?.leadId;
    const l = useQuery({
      queryKey: ["user", leadId, "name"],
      enabled: !!leadId,
      queryFn: () =>
        post(`{ ${printField("user", { id: leadId }, ["name"])} }`).then((d) => d.user),
    });
    return l.data?.name;
  }
  return useData(pool, "user", { id: leadRef }, ["name"]).data?.name;
}
function Chain() {
  const name = useLead();
  useMark("lead", name !== undefined);
  return (
    <main>
      <section>
        <h3>team lead of user 1</h3>
        {name ?? "loading"}
      </section>
    </main>
  );
}

// App
expected = screen === "dashboard" ? specs.length : 1;
let show: (on: boolean) => void = () => {};
function App() {
  const [on, setOn] = useState(true);
  show = setOn;
  const Screen = { dashboard: Dashboard, feed: Feed, chain: Chain }[screen];
  return (
    <>
      <nav>
        {Object.entries(VIEWS).map(([v, modes]) => (
          <span key={v}>
            <b>{v}:</b>{" "}
            {modes.map((m) => (
              <a
                key={m}
                href={`?view=${v}&mode=${m}`}
                style={{ fontWeight: v === screen && m === mode ? "bold" : undefined }}
              >
                {m}
              </a>
            ))}{" "}
          </span>
        ))}
        <button onClick={() => (tanstack ? qc.invalidateQueries() : pool.invalidate())}>
          Refresh all
        </button>{" "}
        {screen === "dashboard" && <button onClick={rename}>Rename user (optimistic)</button>}
      </nav>
      {on && <Screen />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  tanstack ? (
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  ) : (
    <App />
  ),
);

// Benchmark hooks (driven over CDP by bench/run.ts and bench/features.ts)
const settledSince = async (t0: number) => {
  await idle();
  return lastDone - t0;
};
Object.assign(window, {
  __ready: ready.then(() => ({ ...marks })),
  /** Unmount, drop every cache, remount: a cold in-app navigation without bundle download. */
  async __nav() {
    show(false);
    await new Promise((r) => setTimeout(r, 100));
    if (tanstack) qc.clear();
    else pool = newPool();
    marks = {};
    ready = new Promise<void>((r) => (allReady = r));
    const t0 = performance.now();
    show(true);
    await ready;
    const byWidget = Object.fromEntries(
      Object.entries(marks).map(([k, x]) => [k, Math.round(x - t0)]),
    );
    const xs = Object.values(byWidget).sort((a, b) => a - b);
    return {
      first: xs[0],
      median: (xs[(xs.length - 1) >> 1]! + xs[xs.length >> 1]!) / 2,
      last: xs[xs.length - 1],
      byWidget,
    };
  },
  async __refresh() {
    const t0 = performance.now();
    if (tanstack) qc.invalidateQueries();
    else pool.invalidate();
    return { settledMs: await settledSince(t0) };
  },
  /** Feed: ask for one more page, resolve when it is on screen. */
  async __loadMore() {
    const before = feedCtl.pages;
    const t0 = performance.now();
    const shown = new Promise<void>((r) => {
      const check = () => (feedCtl.pages > before ? r() : feedCtl.waiters.push(check));
      feedCtl.waiters.push(check);
    });
    feedCtl.loadMore();
    await shown;
    return performance.now() - t0;
  },
  async __mutate() {
    const el = document.getElementById("username")!;
    const t0 = performance.now();
    let optimisticMs = -1;
    const seen = new Promise<void>((r) =>
      new MutationObserver((_, o) => {
        if (el.textContent !== NEW_NAME) return;
        optimisticMs = performance.now() - t0;
        o.disconnect();
        r();
      }).observe(el, { childList: true, characterData: true, subtree: true }),
    );
    await rename();
    await seen;
    return { optimisticMs, settledMs: await settledSince(t0) };
  },
});
