#!/usr/bin/env node
// laguz-types: generate the Schema type for createPool<Schema>().
//   laguz-types <schema.graphql | introspection.json | https://endpoint> [-o out.ts] [--scalar Name=Type]... [--watch]
import { watch } from "node:fs";
import { dirname } from "node:path";
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
  "usage: laguz-types <schema.graphql | introspection.json | https://endpoint> [-o out.ts] [--scalar Name=Type]... [--watch]";

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
  let watching = false;
  const scalars: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o" || arg === "--out") out = argv[++i];
    else if (arg === "--scalar") {
      const [name, type] = (argv[++i] ?? "").split("=");
      if (!name || !type) throw new Error(`--scalar expects Name=Type\n${usage}`);
      scalars[name] = type;
    } else if (arg === "-w" || arg === "--watch") watching = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage);
      return;
    } else source = arg;
  }
  if (!source) throw new Error(usage);
  if (!watching) {
    const types = generateTypes(await load(source), { scalars });
    if (out) await writeFile(out, types);
    else process.stdout.write(types);
    return;
  }
  if (!out || /^https?:\/\//.test(source))
    throw new Error(`--watch needs a schema file and -o\n${usage}`);

  const file = source;
  const target = out;
  let last = await readFile(target, "utf8").catch(() => "");
  let schema: string | undefined;
  const run = async () => {
    // Mid-save, the file can be briefly missing; the next event brings it back.
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined || text === schema) return;
    schema = text;
    try {
      const types = generateTypes(await load(file), { scalars });
      // Unchanged output stays untouched, so editors don't recheck for nothing.
      if (types === last) return;
      await writeFile(target, types);
      last = types;
      console.log(`laguz-types: wrote ${target}`);
    } catch (err) {
      // A schema saved halfway through an edit; the next save fixes it.
      console.error(`laguz-types: ${(err as Error).message}`);
    }
  };
  await run();
  // The directory, not the file: editors often save by renaming a new file over
  // the old one, which ends a watch on the file. Event file names aren't
  // reliable either (macOS can report the temporary file), so any change in
  // the directory rereads the schema, and only a new text regenerates. Saves
  // come in several writes: wait for them to settle.
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(dirname(file), () => {
    clearTimeout(timer);
    timer = setTimeout(run, 50);
  });
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
