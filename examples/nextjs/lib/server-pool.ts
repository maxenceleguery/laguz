import { createPool } from "@laguzjs/client";
import { localFetcher } from "@laguzjs/server";
import { context, rootValue, schema } from "./schema";
import type { Schema } from "./schema.generated";

/** A pool for one server render. It runs queries in-process instead of over HTTP. */
export const serverPool = () =>
  createPool<Schema>(localFetcher({ schema, rootValue, context }), { serverRefs: true });
