"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useSuspenseData } from "../../../lib/pool";
import { issue as issueQuery, moreFrom } from "../../../lib/queries";

// A fixed locale and time zone, so the server and the browser print the same date.
const day = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });

export function IssueDetail({ id }: { id: string }) {
  // Siblings suspend in the same pass, so both queries go out in one request.
  return (
    <article>
      <Suspense fallback={<p>Loading issue…</p>}>
        <Issue id={id} />
      </Suspense>
      <Suspense fallback={<p>Loading related issues…</p>}>
        <More id={id} />
      </Suspense>
    </article>
  );
}

function Issue({ id }: { id: string }) {
  const issue = useSuspenseData(issueQuery(id));
  if (!issue) return <p>There is no issue {id}.</p>;
  return (
    <>
      <h1>{issue.title}</h1>
      <p>
        {issue.status === "DONE" ? "Done" : "Open"}, opened {day.format(new Date(issue.createdAt))}.
        Assigned to {issue.assignee.name} ({issue.assignee.email}).
      </p>
    </>
  );
}

// Reads only its own query: a component suspends on the first query it lacks,
// so reading the issue here too would fetch the two one after the other.
function More({ id }: { id: string }) {
  const more = useSuspenseData(moreFrom(id));
  const assignee = more.items[0]?.assignee.name.split(" ")[0];
  const others = more.items.filter((item) => item.id !== id);
  return (
    <>
      <h2>Also assigned to {assignee}</h2>
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
    </>
  );
}
