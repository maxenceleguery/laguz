#!/usr/bin/env node
// laguz-types: generate the Schema type for createPool<Schema>().
//   laguz-types <schema.graphql | introspection.json | https://endpoint> [-o out.ts] [--scalar Name=Type]...
import { readFile, writeFile } from "node:fs/promises";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { generateTypes } from "./codegen.ts";

const usage =
  "usage: laguz-types <schema.graphql | introspection.json | https://endpoint> [-o out.ts] [--scalar Name=Type]...";

async function load(source: string): Promise<GraphQLSchema> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    const json = (await res.json()) as {
      data?: IntrospectionQuery;
      errors?: { message: string }[];
    };
    if (!json.data)
      throw new Error(json.errors?.[0]?.message ?? `introspection failed (HTTP ${res.status})`);
    return buildClientSchema(json.data);
  }
  const text = await readFile(source, "utf8");
  if (source.endsWith(".json")) {
    const json = JSON.parse(text);
    return buildClientSchema(json.data ?? json);
  }
  return buildSchema(text);
}

async function main(argv: string[]) {
  let source: string | undefined;
  let out: string | undefined;
  const scalars: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o" || arg === "--out") out = argv[++i];
    else if (arg === "--scalar") {
      const [name, type] = (argv[++i] ?? "").split("=");
      if (!name || !type) throw new Error(`--scalar expects Name=Type\n${usage}`);
      scalars[name] = type;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      return;
    } else source = arg;
  }
  if (!source) throw new Error(usage);
  const types = generateTypes(await load(source), { scalars });
  if (out) await writeFile(out, types);
  else process.stdout.write(types);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
