"use client";
import { createPool, httpFetcher, type Dehydrated, type Fetcher, type Pool } from "@laguzjs/client";
import { useHydrate } from "@laguzjs/client/react";
import { createContext, use, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Schema } from "./schema.generated";

// Every query the browser sends, for the request panel.
let sent: readonly string[] = [];
const listeners = new Set<() => void>();
const http = httpFetcher("/graphql", { stream: true });
// A wrapper passes `options` on: they carry the signal that cancels requests.
const fetcher: Fetcher = (query, options) => {
  sent = [...sent, query];
  listeners.forEach((notify) => notify());
  return http(query, options);
};

const none: readonly string[] = [];
export const useSentQueries = () =>
  useSyncExternalStore(
    (notify) => (listeners.add(notify), () => void listeners.delete(notify)),
    () => sent,
    () => none,
  );

const PoolContext = createContext<Pool<Schema> | null>(null);
export const usePool = () => use(PoolContext)!;

export function PoolProvider({ children }: { children: ReactNode }) {
  // One pool per request on the server, one per page load in the browser.
  const [pool] = useState(() => createPool<Schema>(fetcher, { staleTime: 30_000 }));
  return <PoolContext value={pool}>{children}</PoolContext>;
}

export function Hydrate({ state, children }: { state: Dehydrated; children: ReactNode }) {
  useHydrate(usePool(), state);
  return children;
}
