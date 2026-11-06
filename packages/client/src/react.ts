import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ready,
  type Dehydrated,
  type MutateOptions,
  type Pool,
  type Snapshot,
  type WatchOptions,
} from "./pool.ts";
import { toTree, view, type Fields } from "./selection.ts";
import type { Query, RootArgs, RootName, RootResult, RootSelection, SchemaShape } from "./types.ts";

const IDLE: Snapshot = Object.freeze({ has: {} });
const unsubscribed = () => () => {};

// React runs the subscribe step of every useSyncExternalStore in a commit in
// one synchronous pass, so everything a commit renders lands in one batch.
// Subscribing happens after paint. Registering during render would start the
// request a little earlier, but leaks when React discards a concurrent render.
function useEntry(
  pool: Pool,
  root: string,
  args: object | null,
  fields: Fields,
  { minStaleTime, refetchInterval }: WatchOptions = {},
) {
  const key = JSON.stringify([root, args, fields]);
  const tree = useMemo(() => toTree(fields), [key]);
  const subscribe = useCallback(
    (cb: () => void) =>
      args ? pool.watch(root, args, tree, cb, { minStaleTime, refetchInterval }) : unsubscribed(),
    [pool, key, refetchInterval],
  );
  const read = () => (args ? pool.read(root, args) : IDLE);
  const snap = useSyncExternalStore(subscribe, read, read);
  const data = useMemo(() => view(snap.data, fields), [snap.data, key]);
  return { snap, tree, data, key };
}

/** Options of {@link useData} and {@link useInfiniteData}. */
export type DataOptions = {
  /**
   * While new arguments load (or are `null`), keep returning the data of the
   * previous ones, with `previous: true`. An error replaces it.
   */
  keepPrevious?: boolean;
  /**
   * Refetch every this many milliseconds while mounted, except when the tab is
   * hidden. Everything polled at the same interval shares one request.
   */
  refetchInterval?: number;
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
export type DataResult<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** `data` belongs to earlier arguments, see `keepPrevious`. */
  previous: boolean;
  /** A background refresh is in flight for the data shown. */
  fetching: boolean;
  /** Refetch this entry. The data stays on screen meanwhile, with `fetching`. */
  refetch: () => void;
};

export function useData<
  S extends SchemaShape,
  R extends RootName<S>,
  const F extends RootSelection<S, R>,
>(
  pool: Pool<S>,
  root: R,
  args: RootArgs<S, R> | null,
  fields: F,
  options?: DataOptions,
): DataResult<RootResult<S, R, F>>;
/** The same, for a query from `queries<Schema>()`. Pass `null` to skip it. */
export function useData<S extends SchemaShape, R extends RootName<S>, F>(
  pool: Pool<S>,
  query: Query<S, R, F> | null,
  options?: DataOptions,
): DataResult<RootResult<S, R, F>>;
export function useData(pool: Pool, ...rest: any[]): DataResult<unknown> {
  const [root, args, fields, { keepPrevious = false, refetchInterval }]: [
    string,
    object | null,
    Fields,
    DataOptions,
  ] = fromQuery(rest);
  const { snap, tree, data, key } = useEntry(pool, root, args, fields, { refetchInterval });
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
>(pool: Pool<S>, root: R, args: RootArgs<S, R>, fields: F): RootResult<S, R, F>;
/** The same, for a query from `queries<Schema>()`. */
export function useSuspenseData<S extends SchemaShape, R extends RootName<S>, F>(
  pool: Pool<S>,
  query: Query<S, R, F>,
): RootResult<S, R, F>;
export function useSuspenseData(pool: Pool, ...rest: any[]): unknown {
  const [root, args, fields] = fromQuery(rest);
  // Data that just resolved shouldn't be refetched when the component commits.
  const { snap, tree, data } = useEntry(pool, root, args, fields, { minStaleTime: 1000 });
  if (snap.error) throw snap.error;
  if (!ready(snap, tree)) throw pool.load(root, args!, tree);
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

// `(root, args, fields, options)`, or `(query | null, options)`.
function fromQuery(rest: any[]): [string, object | null, Fields, DataOptions] {
  if (typeof rest[0] === "string") return [rest[0], rest[1], rest[2], rest[3] ?? {}];
  const query: Query | null = rest[0];
  return query
    ? [query.root, query.args, query.fields, rest[1] ?? {}]
    : ["", null, [], rest[1] ?? {}];
}

/** A page of {@link useInfiniteData}: `{ root, args, fields }`, or a query from `queries<Schema>()`. */
export type Page = Query;

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
  { prefetch = 0, keepPrevious = false, refetchInterval }: { prefetch?: number } & DataOptions = {},
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
        watches.current.get(k) ??
          pool.watch(p.root, p.args, p.fields, () => notify.current(), { refetchInterval }),
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

export type PoolContext<S extends SchemaShape> = {
  /**
   * Creates the pool and provides it below. One pool per mount: per request on
   * the server, per page load in the browser. `state` hydrates it.
   */
  PoolProvider: (props: { children?: ReactNode; state?: Dehydrated | null }) => ReactNode;
  /** Hydrates the provided pool with server data, for pages under a shared provider. */
  Hydrate: (props: { state: Dehydrated | null | undefined; children?: ReactNode }) => ReactNode;
  /** The provided pool. Throws outside a `PoolProvider`. */
  usePool: () => Pool<S>;
  /** {@link useData} on the provided pool, for a query from `queries<Schema>()`. */
  useData: <R extends RootName<S>, F>(
    query: Query<S, R, F> | null,
    options?: DataOptions,
  ) => DataResult<RootResult<S, R, F>>;
  /** {@link useSuspenseData} on the provided pool. */
  useSuspenseData: <R extends RootName<S>, F>(query: Query<S, R, F>) => RootResult<S, R, F>;
  /** {@link useInfiniteData} on the provided pool. */
  useInfiniteData: <T = any>(
    page: (prev: T | undefined, index: number) => Page | null,
    options?: { prefetch?: number } & DataOptions,
  ) => ReturnType<typeof useInfiniteData<T>>;
  /** {@link useMutation} on the provided pool. */
  useMutation: {
    <R extends RootName<S, "Mutation">, const F extends RootSelection<S, R, "Mutation">>(
      root: R,
      fields: F,
      options?: MutationOptions<RootArgs<S, R, "Mutation">>,
    ): Mutation<RootArgs<S, R, "Mutation">, RootResult<S, R, F, "Mutation">>;
    <V, T>(run: (vars: V) => Promise<T>, options?: MutationOptions<V>): Mutation<V, T>;
  };
};

export type PoolContextOptions = {
  /**
   * `useServerInsertedHTML` from `next/navigation`, or a framework's
   * equivalent. Data that `useSuspenseData` fetches during the server render
   * then streams to the browser with the HTML, so pages need no prefetch.
   */
  useServerInsertedHTML?: (callback: () => ReactNode) => void;
};

type Box = Record<string, Dehydrated[] | { push: (state: Dehydrated) => void }>;
const box = () => ((globalThis as { __laguz?: Box }).__laguz ??= {});

// Entries the browser received before its provider existed, queued by the scripts.
function drain(pool: Pool, id: string) {
  const queued = box()[id];
  if (Array.isArray(queued)) queued.splice(0).forEach((state) => pool.hydrate(state));
}

/**
 * A React context for a pool, with hooks bound to it:
 * `export const { PoolProvider, useData } = createPoolContext(() => createPool<Schema>(fetcher))`.
 * In Next.js, call it in a `"use client"` module.
 */
export function createPoolContext<S extends SchemaShape = any>(
  create: () => Pool<S>,
  { useServerInsertedHTML: useInserted = () => {} }: PoolContextOptions = {},
): PoolContext<S> {
  const Context = createContext<Pool<S> | null>(null);
  const usePool = () => {
    const pool = useContext(Context);
    if (!pool) throw new Error("laguz: usePool() needs a <PoolProvider> above it");
    return pool;
  };
  return {
    PoolProvider({ children, state }) {
      const id = useId();
      const [pool] = useState(() => {
        const created = create();
        // In the browser: what the server streamed before this script ran.
        if (typeof window !== "undefined") drain(created, id);
        return created;
      });
      useHydrate(pool, state);
      // From now on, streamed entries go straight into the pool, before React
      // hydrates the boundary that follows them in the HTML.
      useLayoutEffect(() => {
        drain(pool, id);
        box()[id] = { push: (streamed: Dehydrated) => pool.hydrate(streamed) };
        return () => void delete box()[id];
      }, [pool, id]);
      // On the server: every flush of HTML carries the entries settled since the last one.
      const sent = useRef(new Map<string, number>()).current;
      useInserted(() => {
        const fresh = pool.dehydrate().filter((e) => {
          const key = JSON.stringify([e.root, e.args]);
          if (sent.get(key) === e.at) return false;
          sent.set(key, e.at);
          return true;
        });
        if (!fresh.length) return null;
        const json = JSON.stringify(fresh).replace(/</g, "\\u003c");
        const target = JSON.stringify(id);
        return createElement("script", {
          dangerouslySetInnerHTML: {
            __html: `((l)=>(l[${target}]=l[${target}]||[]).push(${json}))(globalThis.__laguz=globalThis.__laguz||{})`,
          },
        });
      });
      return createElement(Context.Provider, { value: pool }, children);
    },
    Hydrate({ state, children }) {
      useHydrate(usePool(), state);
      return children;
    },
    usePool,
    useData: (query, options) => useData(usePool(), query, options),
    useSuspenseData: (query) => useSuspenseData(usePool(), query),
    useInfiniteData: (page, options) => useInfiniteData(usePool(), page, options),
    useMutation: ((target: any, fields?: any, options?: any) =>
      useMutation(usePool(), target, fields, options)) as PoolContext<S>["useMutation"],
  };
}
