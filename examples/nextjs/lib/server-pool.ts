import { createPool, type Fetcher } from "@laguzjs/client";
import { splitExecute } from "@laguzjs/server";
import { context, rootValue, schema } from "./schema";
import type { Schema } from "./schema.generated";

/** A pool for one server render. It runs queries in-process instead of over HTTP. */
export function serverPool() {
  const contextValue = context();
  const fetcher = ((source) =>
    splitExecute({ schema, rootValue, source, contextValue })) as Fetcher;
  return createPool<Schema>(fetcher, { serverRefs: true });
}
