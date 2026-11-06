// Selections and arguments shared by server components (which load) and client
// components (which read). An entry is found by its root field and printed
// arguments, so both sides must build them the same way.
import { enumValue, ref } from "@laguzjs/client";
import type { Status } from "./db";

export const VIEWER = ["name"] as const;
export const STATS = ["open", "done"] as const;

export const PAGE = [{ items: ["id", "title", "status", { assignee: ["name"] }] }, "next"] as const;
export const boardPage = (after: string | null, status: Status | null) => ({
  status: status && enumValue(status),
  first: 8,
  after,
});

export const ISSUE = [
  "id",
  "title",
  "status",
  "createdAt",
  { assignee: ["name", "email"] },
] as const;
export const MORE = [{ items: ["id", "title"] }] as const;
/** Other issues of the same assignee: the assignee comes from the issue itself. */
export const moreFrom = (id: string) => ({
  assignee: ref("issue", { id }, "assigneeId"),
  first: 6,
});
