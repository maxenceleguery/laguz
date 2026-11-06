// Compile-time tests: `bun run typecheck` fails if inference changes. The test
// below only keeps bun's runner happy; the assertions are the types.
import { expect, test } from "bun:test";
import { createPool, enumValue, queries, ref, type EnumValue } from "./index.ts";
import {
  createPoolContext,
  useData,
  useInfiniteData,
  useMutation,
  useSuspenseData,
} from "./react.ts";

// What `laguz-types` generates for a small schema.
type Role = "ADMIN" | "MEMBER";
interface Project {
  id: string;
  name: string;
  owner: User;
}
interface User {
  id: string;
  name: string;
  role: Role;
  manager: User | null;
  avatar(args?: { size?: number | null }): string;
  projects(args?: { first?: number | null }): Project[];
}
interface Query {
  user(args: { id: string | number }): User | null;
  users(args?: { role?: EnumValue<Role> | null }): User[];
  count: number;
}
interface Mutation {
  rename(args: { id: string | number; name: string }): User;
}
interface Schema {
  Query: Query;
  Mutation: Mutation;
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <_T extends true>() => {};
const fetcher = async () => ({ data: {} });

// Never called: only type-checked.
function typed() {
  const pool = createPool<Schema>(fetcher);

  const user = useData(pool, "user", { id: 1 }, [
    "name",
    { avatar: { args: { size: 32 } } },
    { projects: ["id", { owner: ["name"] }] },
    { recent: { field: "projects", args: { first: 2 }, fields: ["name"] } },
    { manager: ["id"] },
  ]).data;
  expectType<
    Equal<
      typeof user,
      | {
          name: string;
          avatar: string;
          projects: { id: string; owner: { name: string } }[];
          recent: { name: string }[];
          manager: { id: string } | null;
        }
      | null
      | undefined
    >
  >();

  const users = useData(pool, "users", { role: enumValue("ADMIN") }, ["id", "role"]).data;
  expectType<Equal<typeof users, { id: string; role: Role }[] | undefined>>();

  const count = useData(pool, "count", {}, []).data;
  expectType<Equal<typeof count, number | undefined>>();

  // Arguments may come from another query, or be skipped with null.
  useData(pool, "user", { id: ref("user", { id: 1 }, "manager.id") }, ["name"]);
  useData(pool, "user", null, ["name"]);

  // @ts-expect-error unknown field
  useData(pool, "user", { id: 1 }, ["nope"]);
  // @ts-expect-error object fields need a selection
  useData(pool, "user", { id: 1 }, ["projects"]);
  // @ts-expect-error unknown nested field
  useData(pool, "user", { id: 1 }, [{ projects: ["nope"] }]);
  // @ts-expect-error unknown root field
  useData(pool, "nope", {}, ["id"]);
  // @ts-expect-error wrong argument type
  useData(pool, "user", { id: true }, ["name"]);
  // @ts-expect-error wrong field argument type
  useData(pool, "user", { id: 1 }, [{ avatar: { args: { size: "big" } } }]);
  // @ts-expect-error enum arguments take enumValue(), not strings
  useData(pool, "users", { role: "ADMIN" }, ["id"]);
  // @ts-expect-error not a member of the enum
  useData(pool, "users", { role: enumValue("ROOT") }, ["id"]);
}

function operations() {
  const pool = createPool<Schema>(fetcher);
  pool.load("user", { id: 1 }, ["name", { projects: ["id"] }]);
  // @ts-expect-error unknown root field
  pool.load("nope", {}, ["id"]);
  // @ts-expect-error unknown field
  pool.load("user", { id: 1 }, ["nope"]);

  const renamed = pool.mutate("rename", { id: 1, name: "Ada" }, ["id", { manager: ["name"] }]);
  expectType<Equal<typeof renamed, Promise<{ id: string; manager: { name: string } | null }>>>();
  // @ts-expect-error refs only work in queries
  pool.mutate("rename", { id: ref("user", { id: 1 }, "id"), name: "Ada" }, ["id"]);
  // @ts-expect-error a query is not a mutation
  pool.mutate("user", { id: 1 }, ["id"]);
  // @ts-expect-error a schema without mutations has none
  createPool<{ Query: Query }>(fetcher).mutate("rename", { id: 1, name: "Ada" }, ["id"]);

  const rename = useMutation(pool, "rename", ["name"], (vars) => ({
    optimistic: [["user", { id: vars.id }, (u) => ({ ...u, name: vars.name })]],
  }));
  expectType<Equal<typeof rename.data, { name: string } | undefined>>();
  // @ts-expect-error missing argument
  rename.mutate({ id: 1 });

  const save = useMutation(pool, async (n: number) => `saved ${n}`);
  expectType<Equal<typeof save.data, string | undefined>>();
  // @ts-expect-error variables of the function
  save.mutate("1");
}

function described() {
  const pool = createPool<Schema>(fetcher);
  const query = queries<Schema>();
  const user = (id: number) => query("user", { id }, ["name", { manager: ["id"] }]);

  pool.load(user(1));
  const data = useData(pool, user(1), { keepPrevious: true }).data;
  expectType<
    Equal<typeof data, { name: string; manager: { id: string } | null } | null | undefined>
  >();
  const skipped = useData(pool, Math.random() ? user(1) : null).data;
  expectType<Equal<typeof skipped, typeof data>>();
  const suspended = useSuspenseData(pool, user(1));
  expectType<Equal<typeof suspended, { name: string; manager: { id: string } | null } | null>>();
  useInfiniteData(pool, (_, i) => (i === 0 ? query("users", {}, ["id"]) : null));

  // @ts-expect-error unknown field, caught where the query is defined
  query("user", { id: 1 }, ["nope"]);
  // @ts-expect-error wrong argument type
  query("user", { id: true }, ["name"]);
  const other = queries<{ Query: { other: number } }>()("other", {}, []);
  // @ts-expect-error a query of another schema
  useData(pool, other);
  // @ts-expect-error a query of another schema
  pool.load(other);
}

function bound() {
  const ctx = createPoolContext(() => createPool<Schema>(fetcher));
  const query = queries<Schema>();
  const data = ctx.useData(query("user", { id: 1 }, ["name"])).data;
  expectType<Equal<typeof data, { name: string } | null | undefined>>();
  const rename = ctx.useMutation("rename", ["id"]);
  expectType<Equal<typeof rename.data, { id: string } | undefined>>();
  expectType<Equal<ReturnType<typeof ctx.usePool>, ReturnType<typeof createPool<Schema>>>>();
  // @ts-expect-error a query of another schema
  ctx.useData(queries<{ Query: { other: number } }>()("other", {}, []));
  // @ts-expect-error unknown mutation
  ctx.useMutation("nope", []);
}

// Without a schema everything stays loose, as before.
function untyped() {
  const pool = createPool(fetcher);
  const data = useData(pool, "anything", { x: 1 }, ["a", { b: ["c"] }]).data;
  expectType<Equal<typeof data, any>>();
}

test("type tests compile", () => {
  expect([typed, operations, described, bound, untyped].length).toBe(5);
});
