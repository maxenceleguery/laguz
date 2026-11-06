"use client";
import { viewer } from "../lib/queries";
import { useData, useSentQueries } from "../lib/pool";

export function Viewer() {
  const { data } = useData(viewer);
  return <span>{data?.name}</span>;
}

export function Requests() {
  const sent = useSentQueries();
  return (
    <aside aria-live="polite">
      <h2>
        {sent.length === 0
          ? "The browser has sent no request yet"
          : `The browser has sent ${sent.length} request${sent.length > 1 ? "s" : ""}`}
      </h2>
      <ol start={Math.max(1, sent.length - 4)}>
        {sent.slice(-5).map((query, i) => (
          <li key={sent.length - Math.min(5, sent.length) + i}>
            <code>{query}</code>
          </li>
        ))}
      </ol>
    </aside>
  );
}
