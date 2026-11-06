import { expect, test } from "bun:test";
import { buildSchema } from "graphql";
import { generateTypes } from "./codegen.ts";

const fixture = new URL("./fixtures/", import.meta.url);
const read = (name: string) => Bun.file(new URL(name, fixture)).text();

test("the committed fixture matches the generator (run `bun run fixtures` to update)", async () => {
  const schema = buildSchema(await read("schema.graphql"));
  const generated = generateTypes(schema, { scalars: { DateTime: "string" } });
  expect(generated).toBe(await read("schema.generated.ts"));
});

const types = (sdl: string, options = {}) => generateTypes(buildSchema(sdl), options);

test("outputs: scalars, nullability, lists, enums as string unions", () => {
  const out = types(
    `enum Role { A B } type Query { a: ID! b: String c: [Int!]! d: [Float] e: Boolean! r: Role! }`,
  );
  expect(out).toContain("a: string;");
  expect(out).toContain("b: string | null;");
  expect(out).toContain("c: number[];");
  expect(out).toContain("d: (number | null)[] | null;");
  expect(out).toContain("e: boolean;");
  expect(out).toContain('export type Role = "A" | "B";');
});

test("fields with arguments become methods, optional when every argument is", () => {
  const out = types(
    `enum Role { A } type Query { u(id: ID!): Int! v(n: Int, m: Int = 2): Int! w(r: Role): Int! }`,
  );
  expect(out).toContain("u(args: { id: string | number }): number;");
  expect(out).toContain("v(args?: { n?: number | null; m?: number | null }): number;");
  expect(out).toContain("w(args?: { r?: EnumValue<Role> | null }): number;");
  expect(out).toContain('import type { EnumValue } from "@laguzjs/client";');
});

test("custom scalars default to unknown and can be mapped", () => {
  expect(types(`scalar JSON type Query { j: JSON! }`)).toContain("j: unknown;");
  expect(
    types(`scalar JSON type Query { j: JSON! }`, { scalars: { JSON: "Record<string, unknown>" } }),
  ).toContain("j: Record<string, unknown>;");
});

test("a custom query root name still maps to Schema.Query", () => {
  const out = types(`schema { query: Root } type Root { a: Int! }`);
  expect(out).toContain("export interface Schema {\n  Query: Root;\n}");
});
