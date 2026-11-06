import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ready, type Dehydrated, type MutateOptions, type Pool, type Snapshot } from "./pool.ts";
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
  return { snap, tree, data, key };
}

/** Options of {@link useData} and {@link useInfiniteData}. */
export type KeepOptions = {
  /**
   * While new arguments load (or are `null`), keep returning the data of the
   * previous ones, with `previous: true`. An error replaces it.
   */
  keepPrevious?: boolean;
};

// The last result that was ready, for `keepPrevious`. Stored as state during
// render, the way React suggests for values derived from earlier renders.
function useLast<T>(enabled: boolean, key: string, ready: boolean, value: T, version: unknown) {
  // Only set with `enabled`, so the feature costs nothing when it's off.
  const [last, setLast] = useState<{ key: string; value: T; version: unknown } | null>(null);
  if (enabled && ready && (last?.key !== key || last.version !== version)) {
    setLast({ key, value, version });
  }
  return last;
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
  { keepPrevious = false }: KeepOptions = {},
): {
  data: RootResult<S, R, F> | undefined;
  error: Error | undefined;
  loading: boolean;
  /** `data` belongs to earlier arguments, see `keepPrevious`. */
  previous: boolean;
  /** A background refresh is in flight for the data shown. */
  fetching: boolean;
  /** Refetch this entry. The data stays on screen meanwhile, with `fetching`. */
  refetch: () => void;
} {
  const { snap, tree, data, key } = useEntry(pool, root, args, fields as unknown as Fields);
  const isReady = !!args && ready(snap, tree);
  const last = useLast(keepPrevious, key, isReady, data, snap.data);
  const previous = !isReady && !snap.error && !!last;
  const refetch = useCallback(() => void (args && pool.invalidate(root, args)), [pool, key]);
  return {
    data: previous ? last!.value : data,
    error: snap.error,
    loading: !!args && !snap.error && !isReady,
    previous,
    fetching: !!snap.fetching,
    refetch,
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
  { prefetch = 0, keepPrevious = false }: { prefetch?: number } & KeepOptions = {},
) {
  // Other arguments for the first page (a new filter) make another list,
  // which starts over at one page.
  const first = JSON.stringify(page(undefined, 0));
  const [list, setList] = useState({ first, shown: 1 });
  const shown = list.first === first ? list.shown : 1;

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
  const snaps = useSyncExternalStore(subscribe, read, read);

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
  const error = snaps.map((s) => s.error).find(Boolean);
  const visible = views.slice(0, shown);
  const last = useLast(keepPrevious, first, views.length > 0, visible, snaps);
  const previous = views.length === 0 && !error && !!last;
  return {
    pages: previous ? last!.value : visible,
    hasMore,
    loading: views.length === 0 && !error,
    loadingMore: views.length > 0 && views.length < shown && !error,
    error,
    /** `pages` belong to earlier arguments, see `keepPrevious`. */
    previous,
    /** A background refresh is in flight for a page shown. */
    fetching: snaps.some((s) => s.fetching),
    /** Refetch every loaded page, in one request. */
    refetch: () => pages.forEach((p) => pool.invalidate(p.root, p.args)),
    loadMore: () => {
      if (hasMore) setList({ first, shown: loaded + 1 });
    },
  };
}

export type Mutation<V, T> = {
  /**
   * Run the mutation. The promise rejects on failure, but the error is also
   * in `error`, so it can be called without handling it.
   */
  mutate: (vars: V) => Promise<T>;
  /** The result of the latest call. */
  data: T | undefined;
  error: Error | undefined;
  pending: boolean;
  /** Back to the initial state. A call still running no longer updates it. */
  reset: () => void;
};

type MutationOptions<V> = MutateOptions | ((vars: V) => MutateOptions);

/**
 * A mutation and its state. Pass a mutation of the schema and the fields to
 * select, or any async function (a server action, a REST call). `options`
 * (optimistic writes, invalidations) can depend on the variables.
 */
export function useMutation<
  S extends SchemaShape,
  R extends RootName<S, "Mutation">,
  const F extends RootSelection<S, R, "Mutation">,
>(
  pool: Pool<S>,
  root: R,
  fields: F,
  options?: MutationOptions<RootArgs<S, R, "Mutation">>,
): Mutation<RootArgs<S, R, "Mutation">, RootResult<S, R, F, "Mutation">>;
export function useMutation<V, T>(
  pool: Pool,
  run: (vars: V) => Promise<T>,
  options?: MutationOptions<V>,
): Mutation<V, T>;
export function useMutation(
  pool: Pool,
  target: string | ((vars: any) => Promise<unknown>),
  fieldsOrOptions?: Fields | MutationOptions<any>,
  maybeOptions?: MutationOptions<any>,
): Mutation<any, unknown> {
  const [state, setState] =
    useState<Omit<Mutation<any, unknown>, "mutate" | "reset">>(IDLE_MUTATION);
  // Only the latest call updates the state.
  const latest = useRef(0);
  // `mutate` keeps its identity; the arguments of the last render are read when it runs.
  const current = useRef({ pool, target, fieldsOrOptions, maybeOptions });
  useEffect(() => {
    current.current = { pool, target, fieldsOrOptions, maybeOptions };
  });

  const mutate = useCallback((vars: any) => {
    const { pool, target, fieldsOrOptions, maybeOptions } = current.current;
    const id = ++latest.current;
    setState((s) => ({ ...s, error: undefined, pending: true }));
    const raw = typeof target === "function" ? fieldsOrOptions : maybeOptions;
    const options = typeof raw === "function" ? raw(vars) : (raw as MutateOptions | undefined);
    const promise =
      typeof target === "function"
        ? pool.mutate(() => target(vars), options)
        : pool.mutate(target, vars, fieldsOrOptions as Fields, options);
    promise.then(
      (data) => id === latest.current && setState({ data, error: undefined, pending: false }),
      (error) => id === latest.current && setState({ data: undefined, error, pending: false }),
    );
    return promise;
  }, []);
  const reset = useCallback(() => {
    latest.current++;
    setState(IDLE_MUTATION);
  }, []);
  return { ...state, mutate, reset };
}

const IDLE_MUTATION = { data: undefined, error: undefined, pending: false };
