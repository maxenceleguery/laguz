import { readFileSync } from "node:fs";
import { join } from "node:path";
import { batchLoader } from "@laguzjs/server";
import { buildSchema } from "graphql";
import { db, delay, type Issue, type Status } from "./db";

export const schema = buildSchema(readFileSync(join(process.cwd(), "lib/schema.graphql"), "utf8"));

type Context = ReturnType<typeof context>;

/** One per request: users requested by any field of the request load in one call. */
export function context() {
  return {
    users: batchLoader(async (ids: string[]) => {
      await delay(40);
      return ids.map((id) => db.users.find((u) => u.id === id)!);
    }),
  };
}

// buildSchema resolves a field by calling the method of the same name.
const issue = (i: Issue) => ({
  ...i,
  assignee: (_: unknown, ctx: Context) => ctx.users(i.assigneeId),
});

export const rootValue = {
  viewer: (_: unknown, ctx: Context) => ctx.users("u1"),
  stats: async () => {
    await delay(400);
    const done = db.issues.filter((i) => i.status === "DONE").length;
    return { open: db.issues.length - done, done };
  },
  issues: async (args: { status?: Status; assignee?: string; first: number; after?: string }) => {
    await delay(60);
    const all = db.issues.filter(
      (i) =>
        (!args.status || i.status === args.status) &&
        (!args.assignee || i.assigneeId === args.assignee),
    );
    const start = args.after ? all.findIndex((i) => i.id === args.after) + 1 : 0;
    const items = all.slice(start, start + args.first);
    const more = start + args.first < all.length;
    return { items: items.map(issue), next: more ? items.at(-1)!.id : null };
  },
  setStatus: async ({ id, status }: { id: string; status: Status }) => {
    await delay(300);
    const found = db.issues.find((i) => i.id === id);
    if (!found) throw new Error(`no issue ${id}`);
    found.status = status;
    return issue(found);
  },
  issue: async ({ id }: { id: string }) => {
    await delay(30);
    const found = db.issues.find((i) => i.id === id);
    return found && issue(found);
  },
};
