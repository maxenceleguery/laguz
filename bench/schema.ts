// Dashboard backend for the demo and the benchmark: fake DB with per-call
// latency and a call counter, DataLoader-style batching per HTTP request.
import { buildSchema } from "graphql";
import { batchLoader } from "@laguzjs/server";

export const schema = buildSchema(`
  type User { id: ID! name: String! email: String! avatar(size: Int = 32): String! teamId: ID! }
  type Team { id: ID! name: String! leadId: ID! }
  type FeedItem { id: ID! text: String! }
  type FeedEdge { cursor: String! node: FeedItem! }
  type PageInfo { endCursor: String hasNextPage: Boolean! }
  type FeedConnection { edges: [FeedEdge!]! pageInfo: PageInfo! }
  type Project { id: ID! name: String! tasks: Int! owner: User! }
  type Event { id: ID! text: String! at: String! }
  type Notification { id: ID! message: String! }
  type Stats { activeUsers: Int! revenue: Float! }
  type Query {
    user(id: ID!): User
    project(id: ID!): Project
    activity(projectId: ID!): [Event!]!
    notifications: [Notification!]!
    stats: Stats!
    team(id: ID!): Team
    feed(first: Int!, after: String): FeedConnection!
  }
  type Mutation { renameUser(id: ID!, name: String!): User! }
`);

const NAMES = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra"];
const fresh = () => ({
  users: Object.fromEntries(
    NAMES.map((name, i) => [
      String(i + 1),
      { id: String(i + 1), name, email: `user${i + 1}@example.com`, teamId: i < 2 ? "t1" : "t2" },
    ]),
  ) as Record<string, { id: string; name: string; email: string; teamId: string }>,
  projects: Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `p${i}`,
      { id: `p${i}`, name: `Project ${i}`, tasks: 3 + i, ownerId: String((i % 4) + 1) },
    ]),
  ) as Record<string, { id: string; name: string; tasks: number; ownerId: string }>,
});
let state = fresh();
export const reset = () => void (state = fresh());

export const DB_MS = 10; // one round trip to the database
export const SLOW_MS = Number(process.env.SLOW_MS ?? 300); // the analytics query behind `stats`
export const counters = { dbCalls: 0, requests: 0, batches: [] as number[] }; // batches: root fields per request

const db = async <T>(value: () => T, ms = DB_MS): Promise<T> => {
  counters.dbCalls++;
  await new Promise((r) => setTimeout(r, ms));
  return value();
};

export const context = () => ({
  users: batchLoader((ids: string[]) => db(() => ids.map((id) => user(state.users[id]!)))),
  teams: batchLoader((ids: string[]) => db(() => ids.map((id) => TEAMS[id]!))),
  projects: batchLoader((ids: string[]) => db(() => ids.map((id) => state.projects[id]!))),
  activity: batchLoader((ids: string[]) =>
    db(() =>
      ids.map((pid) =>
        Array.from({ length: 5 }, (_, i) => ({
          id: `${pid}e${i}`,
          text: `Event ${i} on ${pid}`,
          at: `2026-11-0${i + 1}`,
        })),
      ),
    ),
  ),
});
type Ctx = ReturnType<typeof context>;

const TEAMS: Record<string, { id: string; name: string; leadId: string }> = {
  t1: { id: "t1", name: "Core", leadId: "3" },
  t2: { id: "t2", name: "Platform", leadId: "4" },
};
const FEED = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `Feed item ${i}` }));
const user = (u: (typeof state.users)[string]) => ({
  ...u,
  avatar: ({ size }: { size: number }) => `/a/${u.id}.png?s=${size}`,
});

const project = (p: (typeof state.projects)[string]) => ({
  ...p,
  owner: (_: unknown, c: Ctx) => c.users(p.ownerId),
});

export const rootValue = {
  user: ({ id }: { id: string }, c: Ctx) => c.users(id),
  project: ({ id }: { id: string }, c: Ctx) => c.projects(id).then((p) => p && project(p)),
  activity: ({ projectId }: { projectId: string }, c: Ctx) => c.activity(projectId),
  notifications: () =>
    db(() => [1, 2, 3].map((i) => ({ id: `n${i}`, message: `Notification ${i}` }))),
  stats: () => db(() => ({ activeUsers: 1284, revenue: 48210.5 }), SLOW_MS),
  team: ({ id }: { id: string }, c: Ctx) => c.teams(id),
  feed: ({ first, after }: { first: number; after?: string }) =>
    db(() => {
      const start = after ? Number(after) + 1 : 0;
      const items = FEED.slice(start, start + first);
      return {
        edges: items.map((node, i) => ({ cursor: String(start + i), node })),
        pageInfo: {
          endCursor: String(start + items.length - 1),
          hasNextPage: start + first < FEED.length,
        },
      };
    }),
  renameUser: ({ id, name }: { id: string; name: string }) =>
    db(() => user(Object.assign(state.users[id]!, { name }))),
};
