// Compile-time tests for generated types: `bun run typecheck` fails if the
// generator's output stops type-checking selections the way the client expects.
import { expect, test } from "bun:test";
import { createPool, enumValue } from "@laguzjs/client";
import { useData } from "@laguzjs/client/react";
import type { Role, Schema } from "./schema.generated.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <_T extends true>() => {};

// Never called: only type-checked.
function typed() {
  const pool = createPool<Schema>(async () => ({ data: {} }));

  const users = useData(pool, "users", { role: enumValue("ADMIN") }, [
    "id",
    "role",
    "joinedAt",
    { projects: { args: { state: enumValue("OPEN") }, fields: ["name"] } },
  ]).data;
  expectType<
    Equal<
      typeof users,
      | { id: string; role: Role; joinedAt: string | null; projects: { name: string }[] }[]
      | undefined
    >
  >();

  useData(pool, "projects", { order: { direction: enumValue("DESC") }, ids: [1, "p2"] }, ["id"]);
  // @ts-expect-error enum inside an input object takes enumValue()
  useData(pool, "projects", { order: { direction: "DESC" } }, ["id"]);
  // @ts-expect-error required argument missing
  useData(pool, "search", {}, ["id"]);
}

test("generated types compile", () => {
  expect(typeof typed).toBe("function");
});
