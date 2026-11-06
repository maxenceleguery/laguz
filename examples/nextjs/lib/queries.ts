// Every query of the app, defined once. Server components load them and client
// components read them: built by the same functions, both reach the same entry.
import { enumValue, queries, ref } from "@laguzjs/client";
import type { Status } from "./db";
import type { Schema } from "./schema.generated";

const query = queries<Schema>();

export const viewer = query("viewer", {}, ["name"]);
export const stats = query("stats", {}, ["open", "done"]);

/** One page of the board, after the cursor `after`. */
export const issuePage = (after: string | null, status: Status | null) =>
  query("issues", { status: status && enumValue(status), first: 8, after }, [
    { items: ["id", "title", "status", { assignee: ["name"] }] },
    "next",
  ]);

export const issue = (id: string) =>
  query("issue", { id }, ["id", "title", "status", "createdAt", { assignee: ["name", "email"] }]);

/** Other issues of the same assignee: the assignee comes from the issue itself. */
export const moreFrom = (id: string) =>
  query("issues", { assignee: ref("issue", { id }, "assigneeId"), first: 6 }, [
    { items: ["id", "title"] },
  ]);
