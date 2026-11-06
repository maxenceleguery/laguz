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
  type Fields,
  type Ref,
  type Tree,
} from "./selection.ts";

export type GqlError = { message: string; path?: (string | number)[] };
export type Response = {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
  extensions?: Record<string, unknown>;
};
/** Sends a query. Returns one response, or a stream of partial responses. */
export type Fetcher = (query: string) => Promise<Response> | AsyncIterable<Response>;
export type Snapshot = { data?: any; error?: Error; has: Tree };
/** A root field name, or a predicate on the root field and its printed arguments. */
export type Match = string | ((root: string, args: string) => boolean);

export type Options = {
  /** Milliseconds before cached data is refetched when a new consumer mounts. Default 0. */
  staleTime?: number;
  /** Milliseconds an entry without consumers stays cached. Default 5 minutes. */
  gcTime?: number;
  /** Retries before an error is reported. Default 3. */
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
  gc?: ReturnType<typeof setTimeout>;
};

type Req = { e: Entry; tree: Tree; full: boolean; epoch: number; args: string; forwarded: boolean };

const EMPTY: Snapshot = Object.freeze({ has: {} });

/** Whether `snap` holds everything `tree` selects. */
export const ready = (snap: Snapshot, tree: Tree): boolean =>
  "data" in snap && !diff(tree, snap.has);

function unref<T>(timer: T): T {
  (timer as { unref?: () => void })?.unref?.();
  return timer;
}

const toError = (err: GqlError | Error) => (err instanceof Error ? err : new Error(err.message));

export function createPool(fetcher: Fetcher, options: Options = {}) {
  const {
    staleTime = 0,
    gcTime = 5 * 60_000,
    retry = 3,
    retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
    maxBatch = Infinity,
    serverRefs = "auto",
  } = options;

  let forward = serverRefs === true;
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
    if (e.subs.size) return;
    e.gc = unref(setTimeout(() => e.subs.size || entries.delete(e.key), gcTime));
  }

  function update(e: Entry, snap: Snapshot) {
    e.snap = snap;
    for (const sub of e.subs) sub.cb();
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
        if (!n) return;
        e.inflight.add(n.tree);
        batch.set(e, reqs.length);
        reqs.push({ e, ...n, epoch: e.epoch, args, forwarded });
      });
    }

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

  /** Mark matching entries stale. Those in use refetch together, in one request. */
  function invalidate(match?: Match) {
    for (const e of entries.values()) {
      const hit = !match || (typeof match === "string" ? e.root === match : match(e.root, e.args));
      if (!hit) continue;
      e.epoch++;
      e.inflight.clear();
      e.stale = true;
      if (e.subs.size) touch(e);
    }
  }

  /**
   * Write to the cache, e.g. an optimistic update. In-flight reads of the entry
   * are dropped so they can't overwrite it. Returns a function that restores
   * the previous value.
   */
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

  /**
   * Subscribe to `fields` of `root(args)`. The fetch goes out at the end of the
   * current task, together with everything else registered in it.
   * Returns the unsubscribe function.
   */
  function watch(
    root: string,
    args: object,
    fields: Fields | Tree,
    cb: () => void,
    minStaleTime = 0,
  ) {
    const e = entry(root, args);
    clearTimeout(e.gc);
    if (e.at && Date.now() - e.at > Math.max(staleTime, minStaleTime)) e.stale = true;
    if (e.snap.error) e.fails = 0;
    const sub = { tree: Array.isArray(fields) ? toTree(fields) : fields, cb };
    e.subs.add(sub);
    touch(e);
    // A ref depends on another field: subscribe to it and recheck this entry when it changes.
    const deps = e.refs.map(({ $ref: [depRoot, depArgs, path] }) =>
      watch(depRoot, depArgs, pathTree(path), () => touch(e)),
    );
    return () => {
      e.subs.delete(sub);
      deps.forEach((off) => off());
      release(e);
    };
  }

  /** The current snapshot of `root(args)`. Stable until the entry changes. */
  const read = (root: string, args: object): Snapshot =>
    entries.get(name(root) + printArgs(args))?.snap ?? EMPTY;

  /**
   * Fetch without staying subscribed (Suspense, prefetching). Joins the current
   * batch. Resolves once the data is ready or the fetch failed.
   */
  function load(root: string, args: object, fields: Fields | Tree): Promise<void> {
    const tree = Array.isArray(fields) ? toTree(fields) : fields;
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

  /**
   * Run a mutation. Optimistic writes apply at once and are rolled back if it
   * throws; the `invalidate` matches refetch afterwards either way.
   */
  async function mutate<T>(
    run: () => Promise<T>,
    o: {
      optimistic?: [root: string, args: object, fn: (data: any) => any][];
      invalidate?: Match[];
    } = {},
  ): Promise<T> {
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

  return { watch, read, load, invalidate, set, mutate };
}

export type Pool = ReturnType<typeof createPool>;
