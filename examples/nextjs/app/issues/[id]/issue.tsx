"use client";
import { useData } from "@laguzjs/client/react";
import Link from "next/link";
import { issue as issueQuery, moreFrom } from "../../../lib/queries";
import { usePool } from "../../../lib/pool";

// A fixed locale and time zone, so the server and the browser print the same date.
const day = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

export function IssueDetail({ id }: { id: string }) {
  const pool = usePool();
  const { data: issue, loading, error } = useData(pool, issueQuery(id));
  const { data: more } = useData(pool, moreFrom(id));

  if (error)
    return (
      <p role="alert">
        Couldn't load issue {id}: {error.message}
      </p>
    );
  if (loading) return <p>Loading issue…</p>;
  if (!issue) return <p>There is no issue {id}.</p>;
  const others = more?.items.filter((item) => item.id !== id) ?? [];
  return (
    <article>
      <h1>{issue.title}</h1>
      <p>
        {issue.status === "DONE" ? "Done" : "Open"}, opened {day.format(new Date(issue.createdAt))}.
        Assigned to {issue.assignee.name} ({issue.assignee.email}).
      </p>
      <h2>Also assigned to {issue.assignee.name.split(" ")[0]}</h2>
      {others.length ? (
        <ul>
          {others.map((item) => (
            <li key={item.id}>
              <Link href={`/issues/${item.id}`}>{item.title}</Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>Nothing else.</p>
      )}
    </article>
  );
}
