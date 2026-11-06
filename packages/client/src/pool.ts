import {
  collectRefs,
  diff,
  getPath,
  merge,
  mergeData,
  name,
  pathTree,
  printArgs,
  printTree,
  printValue,
  toTree,
  touchesList,
  view,
  type Fields,
  type Ref,
  type Tree,
} from "./selection.ts";
import type { Query, RootArgs, RootName, RootResult, RootSelection, SchemaShape } from "./types.ts";

export type GqlError = { message: string; path?: (string | number)[] };
export type Response = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: Record<string, unknown>;
};
/** Sends a query. Returns one response, or a stream of partial responses. */
export type Fetcher = (query: string) => Promise<Response> | AsyncIterable<Response>;
export type Snapshot = {
  data?: any;
  error?: Error;
  has: Tree;
  /** A request is in flight for data already shown: a background refresh. */
  fetching?: true;
};
/** A root field name, or a predicate on the root field and its printed arguments. */
export type Match = string | ((root: string, args: string) => boolean);

/** Cached data from `pool.dehydrate()`, JSON-safe. */
export type Dehydrated = {
  root: string;
  args: object;
  data: unknown;
  has: Tree;
  at: number;
  sent?: string;
}[];

export type Options = {
  /** Milliseconds before cached data is refetched when a new consumer mounts. Default 0. */
  staleTime?: number;
  /**
   * Milliseconds an entry without consumers stays cached. Default 5 minutes,
   * and `Infinity` on the server, where a pool lives for one request.
   */
  gcTime?: number;
  /** Retries before an error is reported. Default 3, and 0 on the server. */
  retry?: number;
  /** Delay before retry `attempt` (0-based). Default exponential, capped at 30 s. */
  retryDelay?: (attempt: number) => number;
  /** Maximum root fields per request, for servers that limit aliases. Default unlimited. */
  maxBatch?: number;
  /**
   * Whether the server resolves refs itself (see @laguzjs/server), so dependent
   * queries can share a request. `"auto"` (default) starts resolving refs on
   * the client and switches once a response carries `extensions.laguz`.
   */
  serverRefs?: boolean | "auto";
  /**
   * When the tab becomes visible again, refetch the entries in use that are
   * older than `staleTime`, and retry those that failed, in one request.
   * Default true, in browsers.
   */
  refetchOnFocus?: boolean;
  /** The same when the network comes back. Default true, in browsers. */
  refetchOnReconnect?: boolean;
};

export type WatchOptions = {
  /** Treat data as fresh for at least this long, whatever the pool's `staleTime`. */
  minStaleTime?: number;
  /**
   * Refetch every this many milliseconds while subscribed, except when the tab
   * is hidden. Entries polled at the same interval share one request.
   */
  refetchInterval?: number;
};

type Sub = { tree: Tree; cb: () => void };

type Entry = {
  key: string;
  root: string;
  /** Printed arguments, refs in their readable key form. */
  args: string;
  argv: object;
  refs: Ref[];
  /** Arguments, refs resolved, that the cached data was fetched with. */
  sent?: string;
  snap: Snapshot;
  subs: Set<Sub>;
  inflight: Set<Tree>;
  /** Incremented by invalidate and set; responses from an older epoch are ignored. */
  epoch: number;
  /** The next flush refetches the whole selection. */
  stale: boolean;
  /** Time of the last successful response, 0 if none. */
  at: number;
  fails: number;
  /** Hydrated and not fetched since: the next fetch may reveal a server/client mismatch. */
  hydrated?: boolean;
  gc?: ReturnType<typeof setTimeout>;
};

type Req = { e: Entry; tree: Tree; full: boolean; epoch: number; args: string; forwarded: boolean };

// The client doesn't depend on Node types; this is all it reads from `process`.
declare const process: { env: { NODE_ENV?: string } };

const EMPTY: Snapshot = Object.freeze({ has: {} });

/** Whether `snap` holds everything `tree` selects. */
export const ready = (snap: Snapshot, tree: Tree): boolean =>
  "data" in snap && !diff(tree, snap.has);

function unref<T>(timer: T): T {
  (timer as { unref?: () => void })?.unref?.();
  return timer;
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

const toError = (err: GqlError | Error) => (err instanceof Error ? err : new Error(err.message));

// Array.isArray doesn't narrow a readonly array out of a union.
const isFields = (fields: Fields | Tree): fields is Fields => Array.isArray(fields);

/**
 * A typed factory of query descriptors. Define a query once and pass it to
 * `pool.load` on the server and `useData` in the browser, so both build the
 * same entry: `const query = queries<Schema>(); query("user", { id }, ["name"])`.
 */
export const queries =
  <S extends SchemaShape = any>() =>
  <R extends RootName<S>, const F extends RootSelection<S, R>>(
    root: R,
    args: RootArgs<S, R>,
    fields: F,
  ): Query<S, R, F> => ({ root, args, fields });

/**
 * Create a pool. Pass the schema type generated by `laguz-types`
 * (`createPool<Schema>(fetcher)`) to type-check selections and results.
 */
export function createPool<S extends SchemaShape = any>(
  fetcher: Fetcher,
  options: Options = {},
): Pool<S> {
  // The interface is the typed view of the same functions: schema selections
  // are a stricter form of `Fields`.
  return pool(fetcher, options) as unknown as Pool<S>;
}

function pool(fetcher: Fetcher, options: Options) {
  const server = typeof window === "undefined";
  const {
    staleTime = 0,
    gcTime = server ? Infinity : 5 * 60_000,
    retry = server ? 0 : 3,
    retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
    maxBatch = Infinity,
    serverRefs = "auto",
    refetchOnFocus = true,
    refetchOnReconnect = true,
  } = options;

  let forward = serverRefs === true;
  // Bundlers replace `process.env.NODE_ENV`; without one, `process` may not exist.
  let dev = false;
  try {
    dev = process.env.NODE_ENV !== "production";
  } catch {}
  let scheduled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const entries = new Map<string, Entry>();
  const dirty = new Set<Entry>();
  const retrying = new Set<Entry>();
  const loads = new Map<string, Promise<void>>();

  function entry(root: string, args: object): Entry {
    const printed = printArgs(args);
    const key = name(root) + printed;
    let e = entries.get(key);
    if (!e) {
      e = {
        key,
        root,
        args: printed,
        argv: args,
        refs: collectRefs(args),
        snap: EMPTY,
        subs: new Set(),
        inflight: new Set(),
        epoch: 0,
        stale: false,
        at: 0,
        fails: 0,
      };
      entries.set(key, e);
    }
    return e;
  }

  // Everything touched before the current task ends is fetched together.
  function touch(e: Entry) {
    dirty.add(e);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function release(e: Entry) {
    if (e.subs.size || gcTime === Infinity) return;
    clearTimeout(e.gc);
    e.gc = unref(setTimeout(() => e.subs.size || entries.delete(e.key), gcTime));
  }

  // Refreshing data already shown. A first load is `loading`, not `fetching`.
  const busy = (e: Entry) => e.at > 0 && e.inflight.size > 0;

  // Every snapshot change goes through here, so `fetching` always matches `busy`.
  function update(e: Entry, snap: Snapshot) {
    const { fetching: _, ...rest } = snap;
    e.snap = busy(e) ? { ...rest, fetching: true } : rest;
    for (const sub of e.subs) sub.cb();
  }

  // After the requests in flight changed without new data: notify if `fetching` flips.
  function sync(e: Entry) {
    if (!!e.snap.fetching !== busy(e)) update(e, e.snap);
  }

  /** What `e` still has to fetch, or null. `full` replaces the cached data. */
  function need(e: Entry): { tree: Tree; full: boolean } | null {
    const want = [...e.subs].reduce((tree, sub) => merge(tree, sub.tree), {} as Tree);
    // A refetch already in flight will call touch() again when it lands.
    if (e.stale) return e.inflight.size ? null : { tree: want, full: true };
    const covered = [...e.inflight].reduce(merge, e.snap.has);
    let tree = diff(want, covered);
    // A scalar root field selects nothing but still needs one fetch.
    if (!tree && !e.at && !e.inflight.size) tree = want;
    if (!tree) return null;
    return touchesList(tree, e.snap.data) ? { tree: want, full: true } : { tree, full: false };
  }

  /**
   * The printed arguments of `e` with its refs replaced by their values. A ref
   * whose dependency is part of `batch` becomes a placeholder the server fills
   * in. Returns null while a value is unknown.
   */
  function resolve(e: Entry, batch?: Map<Entry, number>): string | null {
    let known = true;
    const printed = printArgs(e.argv, ({ $ref: [root, args, path] }) => {
      const dep = entry(root, args);
      if (ready(dep.snap, pathTree(path))) return printValue(getPath(dep.snap.data, path));
      const index = batch?.get(dep);
      if (index !== undefined) return `$_ref__q${index}__${path.replaceAll(".", "__")}`;
      known = false;
      return "null";
    });
    return known ? printed : null;
  }

  function dependencyError(e: Entry): Error | undefined {
    for (const {
      $ref: [root, args, path],
    } of e.refs) {
      const snap = entry(root, args).snap;
      if (snap.error && !ready(snap, pathTree(path))) return snap.error;
    }
  }

  function flush() {
    scheduled = false;
    const todo: (Entry | undefined)[] = [...dirty].filter((e) => e.subs.size);
    dirty.clear();
    const reqs: Req[] = [];
    const batch = new Map<Entry, number>();

    // Loop until nothing changes: an entry whose ref points into this batch
    // can only join after its dependency, so dependencies get lower aliases.
    let progress = true;
    while (progress) {
      progress = false;
      todo.forEach((e, i) => {
        if (!e) return;
        let args = e.args;
        let forwarded = false;

        if (e.refs.length) {
          const known = resolve(e);
          if (known !== null) {
            if (e.at && known !== e.sent) {
              // A dependency's value changed since the last fetch.
              e.epoch++;
              e.inflight.clear();
              e.stale = true;
            }
            args = known;
          } else {
            const err = dependencyError(e);
            if (err) {
              todo[i] = undefined;
              if (e.snap.error !== err) update(e, { ...e.snap, error: err });
              return;
            }
            const placeholder = forward ? resolve(e, batch) : null;
            // Otherwise wait: the dependency's watcher touches this entry when it lands.
            if (placeholder === null) return;
            args = placeholder;
            forwarded = true;
          }
        }

        todo[i] = undefined;
        progress = true;
        const n = need(e);
        if (e.hydrated) {
          e.hydrated = false;
          if (n && dev) warnHydrated(e, n.tree);
        }
        if (!n) return;
        e.inflight.add(n.tree);
        batch.set(e, reqs.length);
        reqs.push({ e, ...n, epoch: e.epoch, args, forwarded });
      });
    }

    reqs.forEach((r) => sync(r.e));
    // Placeholders name aliases across the whole batch, so it can't be split.
    const step = reqs.some((r) => r.forwarded) ? Infinity : maxBatch;
    for (let i = 0; i < reqs.length; i += step) send(reqs.slice(i, i + step));
  }

  async function send(reqs: Req[]) {
    const query = `{ ${reqs.map((r, i) => `q${i}: ${r.e.root}${r.args}${printTree(r.tree)}`).join(" ")} }`;
    const pending = new Map(reqs.map((r, i) => [`q${i}`, r]));
    try {
      const res = fetcher(query);
      for await (const chunk of Symbol.asyncIterator in res ? res : [await res]) {
        if (serverRefs === "auto" && Number(chunk.extensions?.laguz) >= 1) forward = true;

        const fatal = !chunk.data && chunk.errors?.find((err) => !err.path);
        if (fatal) {
          if (pending.size === 1) {
            for (const r of pending.values()) settle(r, undefined, fatal);
            return;
          }
          // A single invalid field fails validation for the whole document.
          // Resend each field alone so only that one reports the error.
          for (const r of pending.values()) {
            if (!r.forwarded) {
              send([r]);
              continue;
            }
            // Alone, a forwarded field has no dependency to read from: it
            // waits and resolves on the client instead.
            r.e.inflight.delete(r.tree);
            touch(r.e);
          }
          return;
        }

        for (const [alias, r] of pending) {
          const err = chunk.errors?.find((e) => e.path?.[0] === alias);
          if (err || (chunk.data && alias in chunk.data)) {
            pending.delete(alias);
            settle(r, chunk.data?.[alias], err);
          }
        }
      }
      for (const r of pending.values()) settle(r, undefined, { message: "no data in response" });
    } catch (err) {
      for (const r of pending.values()) settle(r, undefined, err as Error);
    }
  }

  function settle(r: Req, data: unknown, err?: GqlError | Error) {
    const e = r.e;
    e.inflight.delete(r.tree);
    if (r.epoch !== e.epoch) return;

    if (err) {
      // A refresh being retried is still a refresh: `fetching` stays on.
      if (e.fails++ < retry) {
        // One timer for every entry that failed in this window keeps the
        // retries batched. They all wait for the first entry's delay.
        retrying.add(e);
        retryTimer ??= setTimeout(
          () => {
            retryTimer = undefined;
            retrying.forEach(touch);
            retrying.clear();
          },
          retryDelay(e.fails - 1),
        );
        return;
      }
      update(e, { ...e.snap, error: toError(err) });
      return;
    }

    e.fails = 0;
    e.at = Date.now();
    // For a forwarded request the dependency arrived first, so the value is known now.
    e.sent = r.forwarded ? (resolve(e) ?? r.args) : r.args;
    if (r.full) e.stale = false;
    update(
      e,
      r.full
        ? { data, has: r.tree }
        : { data: mergeData(e.snap.data, data), has: merge(e.snap.has, r.tree) },
    );
    // Consumers that subscribed while this was in flight may want more.
    if (e.subs.size) touch(e);
  }

  // In development: the first fetch after hydration means the server render
  // didn't cover what the components read, and the browser paid a request.
  function warnHydrated(e: Entry, tree: Tree) {
    const missing = diff(tree, e.snap.has);
    const what = `${e.root}${e.args}`;
    console.warn(
      missing
        ? `laguz: ${what} was rendered on the server without${printTree(missing)}, so the browser fetched it after hydration. Load the same fields on the server.`
        : `laguz: ${what} was fetched again right after hydration because it was older than staleTime (${staleTime} ms). Set staleTime above the time between the server render and hydration.`,
    );
  }

  function invalidate(match?: Match, args?: object) {
    const printed = args && printArgs(args);
    for (const e of entries.values()) {
      const hit = !match || (typeof match === "string" ? e.root === match : match(e.root, e.args));
      if (!hit || (printed !== undefined && e.args !== printed)) continue;
      e.epoch++;
      e.inflight.clear();
      e.stale = true;
      // In use, the refetch goes out at once and keeps `fetching` on.
      if (e.subs.size) touch(e);
      else sync(e);
    }
  }

  function set(root: string, args: object, fn: (data: any) => any) {
    const e = entry(root, args);
    const prev = e.snap;
    e.epoch++;
    e.inflight.clear();
    e.stale = false;
    update(e, { ...prev, data: fn(prev.data) });
    if (e.subs.size) touch(e);
    else release(e);
    return () => update(e, prev);
  }

  function watch(
    root: string,
    args: object,
    fields: Fields | Tree,
    cb: () => void,
    { minStaleTime = 0, refetchInterval }: WatchOptions = {},
  ) {
    const e = entry(root, args);
    clearTimeout(e.gc);
    if (e.at && Date.now() - e.at > Math.max(staleTime, minStaleTime)) e.stale = true;
    const stopPolling = refetchInterval ? poll(e, refetchInterval) : undefined;
    if (e.snap.error) e.fails = 0;
    const sub = { tree: isFields(fields) ? toTree(fields) : fields, cb };
    e.subs.add(sub);
    touch(e);
    // A ref depends on another field: subscribe to it and recheck this entry when it changes.
    const deps = e.refs.map(({ $ref: [depRoot, depArgs, path] }) =>
      watch(depRoot, depArgs, pathTree(path), () => touch(e)),
    );
    return () => {
      e.subs.delete(sub);
      deps.forEach((off) => off());
      stopPolling?.();
      release(e);
    };
  }

  // One timer per interval, so the entries polled at that interval share a request.
  const polls = new Map<number, { timer: ReturnType<typeof setInterval>; entries: Entry[] }>();
  function poll(e: Entry, interval: number) {
    let group = polls.get(interval);
    if (!group) {
      const entries: Entry[] = [];
      const timer = unref(
        setInterval(() => {
          if (hidden()) return;
          new Set(entries).forEach((polled) => {
            polled.stale = true;
            touch(polled);
          });
        }, interval),
      );
      polls.set(interval, (group = { timer, entries }));
    }
    group.entries.push(e);
    return () => {
      group.entries.splice(group.entries.indexOf(e), 1);
      if (group.entries.length) return;
      clearInterval(group.timer);
      polls.delete(interval);
    };
  }

  // Back on the tab or online: what's in use and due refetches, together.
  function revalidate() {
    // Entries nobody uses are skipped by the flush; they revalidate when mounted.
    for (const e of entries.values()) {
      const due = e.at && Date.now() - e.at > staleTime;
      if (!due && !e.snap.error) continue;
      e.stale = !!e.at;
      e.fails = 0;
      touch(e);
    }
  }
  if (typeof document !== "undefined" && typeof window?.addEventListener === "function") {
    if (refetchOnFocus) {
      document.addEventListener("visibilitychange", () => hidden() || revalidate());
    }
    if (refetchOnReconnect) window.addEventListener("online", revalidate);
  }

  const read = (root: string, args: object): Snapshot =>
    entries.get(name(root) + printArgs(args))?.snap ?? EMPTY;

  function load(target: string | Query, args?: object, fields?: Fields | Tree): Promise<void> {
    if (typeof target !== "string") return load(target.root, target.args, target.fields);
    const root = target;
    args = args!;
    fields = fields!;
    const tree = isFields(fields) ? toTree(fields) : fields;
    if (ready(read(root, args), tree)) return Promise.resolve();
    const key = name(root) + printArgs(args) + JSON.stringify(tree);
    const existing = loads.get(key);
    if (existing) return existing;
    const before = read(root, args);
    const promise = new Promise<void>((resolve) => {
      const stop = watch(root, args, tree, () => {
        const snap = read(root, args);
        const failed = snap.error && snap !== before;
        if (!ready(snap, tree) && !failed) return;
        stop();
        loads.delete(key);
        resolve();
      });
    });
    loads.set(key, promise);
    return promise;
  }

  async function apply<T>(run: () => Promise<T>, o: MutateOptions = {}): Promise<T> {
    const undo = (o.optimistic ?? []).map(([root, args, fn]) => set(root, args, fn));
    try {
      return await run();
    } catch (err) {
      undo.reverse().forEach((restore) => restore());
      throw err;
    } finally {
      o.invalidate?.forEach((m) => invalidate(m));
    }
  }

  // A mutation goes out alone: never merged into a query batch, never retried.
  async function mutation(root: string, args: object, fields: Fields) {
    if (collectRefs(args).length) throw new Error("ref() arguments only work in queries");
    const res = fetcher(`mutation { ${name(root)}${printArgs(args)}${printTree(toTree(fields))} }`);
    let data: Record<string, unknown> = {};
    const errors: GqlError[] = [];
    for await (const chunk of Symbol.asyncIterator in res ? res : [await res]) {
      data = { ...data, ...chunk.data };
      errors.push(...(chunk.errors ?? []));
    }
    if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"), { cause: errors });
    if (!(root in data)) throw new Error("no data in response");
    return view(data[root], fields);
  }

  const mutate = (...a: any[]): Promise<any> =>
    typeof a[0] === "function" ? apply(a[0], a[1]) : apply(() => mutation(a[0], a[1], a[2]), a[3]);

  const dehydrate = (): Dehydrated =>
    // Copied through JSON: frameworks only pass plain objects to the browser,
    // and graphql-js builds results on null prototypes.
    JSON.parse(
      JSON.stringify(
        [...entries.values()]
          .filter((e) => e.at && !e.stale)
          .map((e) => ({
            root: e.root,
            args: e.argv,
            data: e.snap.data,
            has: e.snap.has,
            at: e.at,
            sent: e.sent,
          })),
      ),
    );

  function hydrate(state: Dehydrated) {
    const changed: Entry[] = [];
    for (const { root, args, data, has, at, sent } of state) {
      const e = entry(root, args);
      if (e.at >= at) continue;
      // Keep fields the pool has and the server didn't load. Inside a list
      // they can't be merged by index, so the older, complete entry stays.
      const extra = diff(e.snap.has, has);
      if (extra && touchesList(extra, e.snap.data)) continue;
      e.snap = extra
        ? { data: mergeData(e.snap.data, data), has: merge(e.snap.has, has) }
        : { data, has };
      e.at = at;
      e.sent = sent;
      e.stale = false;
      e.hydrated = true;
      changed.push(e);
      release(e);
    }
    queueMicrotask(() =>
      changed.forEach((e) => {
        e.subs.forEach((sub) => sub.cb());
        // Consumers may select more than the server fetched.
        if (e.subs.size) touch(e);
      }),
    );
  }

  return { watch, read, load, invalidate, set, mutate, dehydrate, hydrate };
}

export type MutateOptions = {
  /** Cache writes `[root, args, fn]`, applied at once and rolled back if the mutation fails. */
  optimistic?: [root: string, args: object, fn: (data: any) => any][];
  /** Entries to refetch afterwards, whether the mutation succeeded or not. */
  invalidate?: Match[];
};

/**
 * A pool. `S` is the schema type it was created with (see `laguz-types`), which
 * types root fields, arguments, selections and results.
 */
export interface Pool<S extends SchemaShape = any> {
  readonly __schema?: S;
  /**
   * Subscribe to `fields` of `root(args)`. The fetch goes out at the end of the
   * current task, together with everything else registered in it. Returns the
   * unsubscribe function.
   */
  watch(
    root: string,
    args: object,
    fields: Fields | Tree,
    callback: () => void,
    options?: WatchOptions,
  ): () => void;
  /** The current snapshot of `root(args)`. Stable until the entry changes. */
  read(root: string, args: object): Snapshot;
  /**
   * Fetch without staying subscribed (Suspense, prefetching, server rendering).
   * Joins the current batch. Resolves once the data is ready or the fetch failed.
   */
  load<R extends RootName<S>, const F extends RootSelection<S, R>>(
    root: R,
    args: RootArgs<S, R>,
    fields: F | Tree,
  ): Promise<void>;
  /** The same, for a query from `queries<Schema>()`. */
  load<R extends RootName<S>, F>(query: Query<S, R, F>): Promise<void>;
  /**
   * Mark matching entries stale: all of them, those of a root field, those a
   * predicate accepts, or with `args` the one entry `root(args)`. Those in use
   * refetch together, in one request.
   */
  invalidate(match?: Match, args?: object): void;
  /**
   * Write to the cache, e.g. an optimistic update. In-flight reads of the entry
   * are dropped so they can't overwrite it. Returns a function that restores
   * the previous value.
   */
  set(root: string, args: object, fn: (data: any) => any): () => void;
  /**
   * Run a mutation of the schema, `mutation { root(args) { fields } }`, and
   * resolve to the selected data. It is sent on its own and never retried; a
   * GraphQL error rejects with the server's message.
   */
  mutate<R extends RootName<S, "Mutation">, const F extends RootSelection<S, R, "Mutation">>(
    root: R,
    args: RootArgs<S, R, "Mutation">,
    fields: F,
    options?: MutateOptions,
  ): Promise<RootResult<S, R, F, "Mutation">>;
  /** Run any async function as a mutation, e.g. a server action or a REST call. */
  mutate<T>(run: () => Promise<T>, options?: MutateOptions): Promise<T>;
  /**
   * The cached data, to pass to `hydrate` in another pool: from a server render
   * to the browser, for example. Entries that never loaded, failed ones
   * included, and invalidated entries are left out.
   */
  dehydrate(): Dehydrated;
  /**
   * Add data from `dehydrate`. Entries this pool has newer data for are kept.
   * The data is readable at once and consumers are notified in a microtask, so
   * it is safe to call while rendering.
   */
  hydrate(state: Dehydrated): void;
}
