"use client";
import { enumValue } from "@laguzjs/client";
import Link from "next/link";
import { useState } from "react";
import type { Status } from "../lib/db";
import { issuePage, stats } from "../lib/queries";
import { useData, useInfiniteData, useMutation } from "../lib/pool";

type Row = { id: string; title: string; status: Status; assignee: { name: string } };
type Page = { items: Row[]; next: string | null };

const FILTERS: [label: string, status: Status | null][] = [
  ["All", null],
  ["Open", "OPEN"],
  ["Done", "DONE"],
];

function Stats() {
  const { data } = useData(stats);
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
  const pageOf = (prev: Page | undefined) => issuePage(prev?.next ?? null, status);
  // While another filter loads, the current list stays on screen, dimmed.
  const { pages, hasMore, loading, loadingMore, error, previous, loadMore } = useInfiniteData<Page>(
    (prev, i) => (i === 0 || prev?.next ? pageOf(prev) : null),
    { keepPrevious: true },
  );

  // The checkbox flips at once; the list and the counts refetch in one request after.
  const setStatus = useMutation("setStatus", ["id", "status"], ({ id, status }) => {
    const page = pages.findIndex((p) => p.items.some((item) => item.id === id));
    const mark = (p: Page) => ({
      ...p,
      items: p.items.map((item) => (item.id === id ? { ...item, status: status.$enum } : item)),
    });
    return {
      optimistic: [["issues", pageOf(pages[page - 1]).args, mark]],
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
