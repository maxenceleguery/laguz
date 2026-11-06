// A panel that shows what a pool sends and holds: `<LaguzDevtools pool={pool} />`.
// Render it in development only; it has no dependencies besides React.
import { useEffect, useReducer, useRef, useState } from "react";
import type { EntryInfo, Pool, PoolEvent } from "./pool.ts";

type Request = {
  id: number;
  query: string;
  start: number;
  end?: number;
  outcome?: "done" | "failed" | "aborted";
  error?: string;
  arrivals: { fields: string[]; errors: string[]; at: number }[];
};

export type DevtoolsProps = {
  pool: Pool;
  /** Open when the page loads. Default false. */
  initialOpen?: boolean;
  /** Corner of the toggle button. Default `"bottom-right"`. */
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Requests kept in the list. Default 50. */
  limit?: number;
};

// Root fields of a request, by alias: `{ q0: user(id: 1) ... }` gives q0 → user.
function rootsOf(query: string): Map<string, string> {
  const roots = new Map<string, string>();
  for (const [, alias, root] of query.matchAll(/(q\d+): (\w+)/g)) roots.set(alias!, root!);
  const mutation = query.match(/^mutation[^{]*\{ (\w+)/);
  if (mutation) roots.set(mutation[1]!, mutation[1]!);
  return roots;
}

function summary(query: string) {
  const counts = new Map<string, number>();
  for (const root of rootsOf(query).values()) counts.set(root, (counts.get(root) ?? 0) + 1);
  const parts = [...counts].map(([root, n]) => (n > 1 ? `${root} ×${n}` : root));
  return (query.startsWith("mutation") ? "mutation " : "") + parts.join(", ");
}

const ago = (at: number, now: number) => {
  const s = Math.round((now - at) / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
};

export function LaguzDevtools({
  pool,
  initialOpen = false,
  position = "bottom-right",
  limit = 50,
}: DevtoolsProps) {
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState<"requests" | "cache">("requests");
  const [expanded, setExpanded] = useState<string | null>(null);
  const requests = useRef<Request[]>([]);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // Browser only, after hydration: the server's pool holds other entries than
  // the browser's, and rendering them would not match.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const stop = pool.observe((event: PoolEvent) => {
      const list = requests.current;
      if (event.type === "request") {
        list.unshift({ id: event.id, query: event.query, start: event.at, arrivals: [] });
        list.length = Math.min(list.length, limit);
      } else {
        const request = list.find((r) => r.id === event.id);
        if (!request) return;
        if (event.type === "result") request.arrivals.push(event);
        else Object.assign(request, { end: event.at, outcome: event.outcome, error: event.error });
      }
      redraw();
    });
    // Ages and cache states move without requests: refresh now and then.
    const timer = setInterval(redraw, 1000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [pool, limit]);

  if (!mounted) return null;
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "right"];
  const corner = { [vertical]: 12, [horizontal]: 12 };
  const now = Date.now();
  const entries = open
    ? pool.inspect().sort((a, b) => (a.root + a.args).localeCompare(b.root + b.args))
    : [];

  return (
    <div className="lz-devtools" style={{ position: "fixed", zIndex: 2147483000, ...corner }}>
      <style>{css}</style>
      {open ? (
        <section className="lz-panel" aria-label="laguz devtools">
          <header>
            <span className="lz-rune" aria-hidden>
              ᛚ
            </span>
            <div role="tablist">
              <button
                role="tab"
                aria-selected={tab === "requests"}
                onClick={() => setTab("requests")}
              >
                Requests {requests.current.length}
              </button>
              <button role="tab" aria-selected={tab === "cache"} onClick={() => setTab("cache")}>
                Cache {entries.length}
              </button>
            </div>
            {tab === "cache" && (
              <button className="lz-quiet" onClick={() => pool.invalidate()}>
                Invalidate all
              </button>
            )}
            <button
              className="lz-quiet"
              aria-label="Close laguz devtools"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <ol className="lz-list">
            {tab === "requests"
              ? requests.current.map((r) => (
                  <RequestRow
                    key={r.id}
                    request={r}
                    now={now}
                    open={expanded === `r${r.id}`}
                    toggle={() => setExpanded(expanded === `r${r.id}` ? null : `r${r.id}`)}
                  />
                ))
              : entries.map((e) => (
                  <EntryRow
                    key={e.root + e.args}
                    entry={e}
                    now={now}
                    open={expanded === e.root + e.args}
                    toggle={() =>
                      setExpanded(expanded === e.root + e.args ? null : e.root + e.args)
                    }
                    refetch={() =>
                      pool.invalidate((root, args) => root === e.root && args === e.args)
                    }
                  />
                ))}
          </ol>
          {(tab === "requests" ? requests.current.length : entries.length) === 0 && (
            <p className="lz-empty">
              {tab === "requests" ? "No request since the panel opened." : "The cache is empty."}
            </p>
          )}
        </section>
      ) : (
        <button
          className="lz-toggle"
          aria-label="Open laguz devtools"
          onClick={() => setOpen(true)}
        >
          ᛚ
        </button>
      )}
    </div>
  );
}

function RequestRow({
  request: r,
  now,
  open,
  toggle,
}: {
  request: Request;
  now: number;
  open: boolean;
  toggle: () => void;
}) {
  const duration = (r.end ?? now) - r.start;
  const roots = rootsOf(r.query);
  const state = r.outcome ?? "streaming";
  return (
    <li>
      <button className="lz-row" aria-expanded={open} onClick={toggle}>
        <span className={`lz-dot lz-${state}`} aria-hidden />
        <span className="lz-main">{summary(r.query)}</span>
        <span className="lz-meta">
          {state === "done" ? `${duration} ms` : state === "streaming" ? `${duration} ms…` : state}
        </span>
      </button>
      {open && (
        <div className="lz-detail">
          <pre>{r.query}</pre>
          {r.error && <p className="lz-error">{r.error}</p>}
          {/* When each field arrived: where streaming shows. */}
          <ul className="lz-timeline">
            {r.arrivals.flatMap((a) =>
              a.fields.map((alias) => (
                <li key={alias}>
                  <span>{roots.get(alias) ?? alias}</span>
                  <span className="lz-bar">
                    <span
                      style={{ width: `${duration ? ((a.at - r.start) / duration) * 100 : 100}%` }}
                    />
                  </span>
                  <span className="lz-meta">
                    {a.at - r.start} ms{a.errors.length ? `, ${a.errors.join("; ")}` : ""}
                  </span>
                </li>
              )),
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

function EntryRow({
  entry: e,
  now,
  open,
  toggle,
  refetch,
}: {
  entry: EntryInfo;
  now: number;
  open: boolean;
  toggle: () => void;
  refetch: () => void;
}) {
  const state = e.status === "ready" && e.stale ? "stale" : e.status;
  return (
    <li>
      <button className="lz-row" aria-expanded={open} onClick={toggle}>
        <span className={`lz-dot lz-${state}`} aria-hidden />
        <span className="lz-main">
          {e.root}
          <span className="lz-args">{e.args}</span>
        </span>
        <span className="lz-meta">
          {state}, {e.subscribers} {e.subscribers === 1 ? "reader" : "readers"}
          {e.at ? `, ${ago(e.at, now)}` : ""}
        </span>
      </button>
      {open && (
        <div className="lz-detail">
          {e.error && <p className="lz-error">{e.error}</p>}
          <pre>{JSON.stringify(e.data, null, 2)?.slice(0, 4000) ?? "no data"}</pre>
          <button className="lz-quiet" onClick={refetch}>
            Refetch
          </button>
        </div>
      )}
    </li>
  );
}

const css = `
.lz-devtools { --lz-bg: #12171b; --lz-line: #2a333a; --lz-text: #dfe5e9; --lz-muted: #8a979f;
  --lz-lake: #5fb3d9; --lz-amber: #e0a85a; --lz-red: #e06c6c; --lz-green: #7cc79a;
  font: 13px/1.4 system-ui, sans-serif; color: var(--lz-text); }
.lz-devtools button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.lz-devtools button:focus-visible { outline: 2px solid var(--lz-lake); outline-offset: 1px; }
.lz-toggle { width: 36px; height: 36px; border-radius: 50%; background: var(--lz-bg) !important;
  border: 1px solid var(--lz-line) !important; font-size: 18px !important; color: var(--lz-lake) !important; }
.lz-panel { width: min(560px, calc(100vw - 24px)); max-height: min(70vh, 640px); display: flex;
  flex-direction: column; background: var(--lz-bg); border: 1px solid var(--lz-line); border-radius: 8px;
  box-shadow: 0 8px 30px rgb(0 0 0 / 0.35); }
.lz-panel header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--lz-line); }
.lz-rune { color: var(--lz-lake); font-size: 16px; padding: 0 4px; }
.lz-panel [role="tablist"] { display: flex; gap: 2px; flex: 1; }
.lz-panel [role="tab"] { padding: 4px 8px; border-radius: 4px; color: var(--lz-muted); }
.lz-panel [role="tab"][aria-selected="true"] { color: var(--lz-text); background: var(--lz-line); }
.lz-quiet { color: var(--lz-muted) !important; padding: 4px 6px; }
.lz-quiet:hover { color: var(--lz-text) !important; }
.lz-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.lz-list > li { border-bottom: 1px solid var(--lz-line); }
.lz-row { width: 100%; display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; text-align: left; }
.lz-row:hover { background: rgb(255 255 255 / 0.03); }
.lz-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lz-args, .lz-detail pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.lz-args { color: var(--lz-muted); }
.lz-meta { color: var(--lz-muted); font-size: 12px; white-space: nowrap; }
.lz-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; background: var(--lz-muted); }
.lz-done, .lz-ready { background: var(--lz-green); }
.lz-streaming, .lz-loading, .lz-fetching { background: var(--lz-lake); }
.lz-stale, .lz-aborted { background: var(--lz-amber); }
.lz-failed, .lz-error { background: var(--lz-red); }
.lz-detail { padding: 0 10px 10px 25px; }
.lz-detail pre { margin: 0 0 8px; padding: 8px; background: rgb(0 0 0 / 0.25); border-radius: 4px;
  white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
p.lz-error { background: none; color: var(--lz-red); margin: 0 0 8px; }
.lz-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.lz-timeline li { display: grid; grid-template-columns: minmax(0, 9em) 1fr auto; gap: 8px; align-items: center; }
.lz-bar { height: 4px; background: var(--lz-line); border-radius: 2px; overflow: hidden; }
.lz-bar span { display: block; height: 100%; background: var(--lz-lake); }
.lz-empty { margin: 0; padding: 12px 10px; color: var(--lz-muted); }
`;
