"use client";
import { createPool, httpFetcher } from "@laguzjs/client";
import { createPoolContext } from "@laguzjs/client/react";
import { useServerInsertedHTML } from "next/navigation";
import type { Schema } from "./schema.generated";

// The server renders client components too, and needs an absolute URL there.
const server = typeof window === "undefined";
const http = httpFetcher(
  server ? `${process.env.SITE_URL ?? "http://localhost:3020"}/graphql` : "/graphql",
  {
    stream: true,
  },
);

export const {
  PoolProvider,
  Hydrate,
  usePool,
  useData,
  useSuspenseData,
  useInfiniteData,
  useMutation,
} = createPoolContext(
  () => createPool<Schema>(http, { staleTime: 30_000, serverRefs: true }),
  // What useSuspenseData loads during the server render streams with the HTML.
  { useServerInsertedHTML },
);
