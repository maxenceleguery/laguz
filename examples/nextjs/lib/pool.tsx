"use client";
import { createPool, httpFetcher, type Fetcher } from "@laguzjs/client";
import { createPoolContext } from "@laguzjs/client/react";
import { useServerInsertedHTML } from "next/navigation";
import { useSyncExternalStore } from "react";
import type { Schema } from "./schema.generated";

// Every query the browser sends, for the request panel.
let sent: readonly string[] = [];
const listeners = new Set<() => void>();
const none: readonly string[] = [];
export const useSentQueries = () =>
  useSyncExternalStore(
    (notify) => (listeners.add(notify), () => void listeners.delete(notify)),
    () => sent,
    () => none,
  );

// The server renders client components too, and needs an absolute URL there.
const server = typeof window === "undefined";
const http = httpFetcher(
  server ? `${process.env.SITE_URL ?? "http://localhost:3020"}/graphql` : "/graphql",
  {
    stream: true,
  },
);
// A wrapper passes `options` on: they carry the signal that cancels requests.
const fetcher: Fetcher = (query, options) => {
  if (!server) {
    sent = [...sent, query];
    listeners.forEach((notify) => notify());
  }
  return http(query, options);
};

export const { PoolProvider, Hydrate, useData, useSuspenseData, useInfiniteData, useMutation } =
  createPoolContext(
    () => createPool<Schema>(fetcher, { staleTime: 30_000, serverRefs: true }),
    // What useSuspenseData loads during the server render streams with the HTML.
    { useServerInsertedHTML },
  );
