"use client";
import { enumValue } from "@laguzjs/client";
import { useData, useInfiniteData, useMutation } from "@laguzjs/client/react";
import Link from "next/link";
import { useState } from "react";
import type { Status } from "../lib/db";
import { boardPage, PAGE, STATS } from "../lib/fields";
import { usePool } from "../lib/pool";

type Row = { id: string; title: string; status: Status; assignee: { name: string } };
type Page = { items: Row[]; next: string | null };

const FILTERS: [label: string, status: Status | null][] = [
  ["All", null],
  ["Open", "OPEN"],
  ["Done", "DONE"],
];

function Stats() {
  const { data } = useData(usePool(), "stats", {}, STATS);
  return <p>{data ? `${data.open} open, ${data.done} done` : "Counting issues…"}</p>;
}

export function Board() {
  const [status, setFilter] = useState<Status | null>(null);
  return (
    <section>
      <div className="toolbar">
        <Stats />
        <div role="group" aria-label="Filter by status">
          {FILTERS.map(([label, value]) => (
            <button key={label} aria-pressed={status === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <Issues status={status} />
    </section>
  );
}

function Issues({ status }: { status: Status | null }) {
  const pool = usePool();
  const pageArgs = (prev: Page | undefined) => boardPage(prev?.next ?? null, status);
  // While another filter loads, the current list stays on screen, dimmed.
  const { pages, hasMore, loading, loadingMore, error, previous, loadMore } = useInfiniteData<Page>(
    pool,
    (prev, i) =>
      i === 0 || prev?.next ? { root: "issues", args: pageArgs(prev), fields: PAGE } : null,
    { keepPrevious: true },
  );

  // The checkbox flips at once; the list and the counts refetch in one request after.
  const setStatus = useMutation(pool, "setStatus", ["id", "status"], ({ id, status }) => {
    const page = pages.findIndex((p) => p.items.some((item) => item.id === id));
    const mark = (p: Page) => ({
      ...p,
      items: p.items.map((item) => (item.id === id ? { ...item, status: status.$enum } : item)),
    });
    return {
      optimistic: [["issues", pageArgs(pages[page - 1]), mark]],
      invalidate: ["issues", "issue", "stats"],
    };
  });
  const toggle = (row: Row) =>
    setStatus.mutate({ id: row.id, status: enumValue(row.status === "DONE" ? "OPEN" : "DONE") });

  return (
    <>
      {error && <p role="alert">Couldn't load issues: {error.message}</p>}
      {setStatus.error && <p role="alert">Couldn't update the issue: {setStatus.error.message}</p>}
      {loading && !previous ? (
        <p>Loading issues…</p>
      ) : (
        <ul className="issues" aria-busy={previous}>
          {pages.map((page) =>
            page.items.map((row) => (
              <li key={row.id}>
                <input
                  type="checkbox"
                  checked={row.status === "DONE"}
                  onChange={() => toggle(row)}
                  aria-label={`Done: ${row.title}`}
                />
                <Link href={`/issues/${row.id}`}>{row.title}</Link>
                <span>{row.assignee.name}</span>
              </li>
            )),
          )}
        </ul>
      )}
      {hasMore && (
        <button onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
    </>
  );
}
