import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ready, type Dehydrated, type Pool, type Snapshot } from "./pool.ts";
import { toTree, view, type Fields } from "./selection.ts";
import type { RootArgs, RootName, RootResult, RootSelection, SchemaShape } from "./types.ts";

const IDLE: Snapshot = Object.freeze({ has: {} });
const unsubscribed = () => () => {};

// React runs the subscribe step of every useSyncExternalStore in a commit in
// one synchronous pass, so everything a commit renders lands in one batch.
// Subscribing happens after paint. Registering during render would start the
// request a little earlier, but leaks when React discards a concurrent render.
function useEntry(pool: Pool, root: string, args: object | null, fields: Fields, minStaleTime = 0) {
  const key = JSON.stringify([root, args, fields]);
  const tree = useMemo(() => toTree(fields), [key]);
  const subscribe = useCallback(
    (cb: () => void) => (args ? pool.watch(root, args, tree, cb, minStaleTime) : unsubscribed()),
    [pool, key],
  );
  const read = () => (args ? pool.read(root, args) : IDLE);
  const snap = useSyncExternalStore(subscribe, read, read);
  const data = useMemo(() => view(snap.data, fields), [snap.data, key]);
  return { snap, tree, data };
}

/**
 * Read `fields` of `root(args)`. Pass `args: null` to skip the query, for
 * example until the value it depends on has loaded. With a pool created from a
 * schema, the root, the arguments and the selection are type-checked and
 * `data` has the selected shape.
 */
export function useData<
  S extends SchemaShape,
  R extends RootName<S>,
  const F extends RootSelection<S, R>,
>(
  pool: Pool<S>,
  root: R,
  args: RootArgs<S, R> | null,
  fields: F,
): { data: RootResult<S, R, F> | undefined; error: Error | undefined; loading: boolean } {
  const { snap, tree, data } = useEntry(pool, root, args, fields as unknown as Fields);
  return {
    data,
    error: snap.error,
    loading: !!args && !snap.error && !ready(snap, tree),
  };
}

/**
 * Like {@link useData}, but suspends until the data is ready and throws errors
 * to the nearest error boundary. Call `pool.invalidate(root)` when the boundary
 * resets to retry.
 *
 * Give each component its own `<Suspense>` boundary. React stops rendering the
 * siblings of a component that suspends, so components sharing a boundary are
 * fetched in two requests instead of one.
 */
export function useSuspenseData<
  S extends SchemaShape,
  R extends RootName<S>,
  const F extends RootSelection<S, R>,
>(pool: Pool<S>, root: R, args: RootArgs<S, R>, fields: F): RootResult<S, R, F> {
  // Data that just resolved shouldn't be refetched when the component commits.
  const { snap, tree, data } = useEntry(pool, root, args, fields as unknown as Fields, 1000);
  if (snap.error) throw snap.error;
  if (!ready(snap, tree)) throw pool.load(root, args, tree);
  return data;
}

/**
 * Add data rendered on the server (`pool.dehydrate()`) to `pool`, before the
 * components below this one read it. Call it in every page that receives
 * server data: entries the pool already has newer data for are kept.
 */
export function useHydrate(pool: Pool, state: Dehydrated | null | undefined) {
  useMemo(() => state && pool.hydrate(state), [pool, state]);
}

export type Page = { root: string; args: object; fields: Fields };

/**
 * An infinite list. `page(prev, index)` describes page `index` from the data of
 * the previous page (its cursor), or returns null after the last page.
 *
 * Every page is a regular cache entry: refreshing refetches all loaded pages in
 * one request, and pages whose cursor moved are fetched right after.
 * `prefetch` keeps that many pages loaded ahead, so `loadMore` shows them at once.
 */
export function useInfiniteData<T = any>(
  pool: Pool,
  page: (prev: T | undefined, index: number) => Page | null,
  { prefetch = 0 } = {},
) {
  const [shown, setShown] = useState(1);

  // Page n needs page n-1's data for its cursor, so walk the cache in order.
  const pages: Page[] = [];
  const views: T[] = [];
  let end = false;
  for (let i = 0; i < shown + prefetch; i++) {
    const p = page(views[i - 1], i);
    if (!p) {
      end = true;
      break;
    }
    pages.push(p);
    const snap = pool.read(p.root, p.args);
    if (!ready(snap, toTree(p.fields))) break;
    views.push(view(snap.data, p.fields));
  }

  // Re-render when any page changes; the walk above then reads the new data.
  const notify = useRef(() => {});
  const subscribe = useCallback((cb: () => void) => {
    notify.current = cb;
    return () => {
      notify.current = () => {};
    };
  }, []);
  const lastSnaps = useRef<Snapshot[]>([]);
  const read = () => {
    const snaps = pages.map((p) => pool.read(p.root, p.args));
    const prev = lastSnaps.current;
    if (snaps.length === prev.length && snaps.every((s, i) => s === prev[i])) return prev;
    lastSnaps.current = snaps;
    return snaps;
  };
  useSyncExternalStore(subscribe, read, read);

  // Keep one subscription per page for as long as the page is in the list.
  // Resubscribing every page when the list grows would count as a new mount
  // for each of them and refetch them all.
  const watches = useRef(new Map<string, () => void>());
  const key = JSON.stringify(pages);
  useEffect(() => {
    const next = new Map<string, () => void>();
    for (const p of pages) {
      const k = JSON.stringify(p);
      next.set(
        k,
        watches.current.get(k) ?? pool.watch(p.root, p.args, p.fields, () => notify.current()),
      );
      watches.current.delete(k);
    }
    // Whatever is left belongs to pages that dropped out, e.g. after a cursor moved.
    watches.current.forEach((unwatch) => unwatch());
    watches.current = next;
  }, [pool, key]);
  useEffect(
    () => () => {
      watches.current.forEach((unwatch) => unwatch());
      watches.current = new Map();
    },
    [pool],
  );

  const loaded = Math.min(views.length, shown);
  const hasMore =
    loaded === shown &&
    (views.length > shown || (!end && page(views[loaded - 1], loaded) !== null));
  const error = pages.map((p) => pool.read(p.root, p.args).error).find(Boolean);
  return {
    pages: views.slice(0, shown),
    hasMore,
    loading: views.length === 0 && !error,
    loadingMore: views.length > 0 && views.length < shown && !error,
    error,
    loadMore: () => {
      if (hasMore) setShown(loaded + 1);
    },
  };
}
