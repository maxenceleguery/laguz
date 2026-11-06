import { afterAll, expect, test } from "bun:test";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "laguz-types-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const schema = join(dir, "schema.graphql");
const out = join(dir, "schema.generated.ts");

// Saves the way many editors do: a new file renamed over the old one.
const save = (sdl: string) => {
  writeFileSync(`${schema}.tmp`, sdl);
  renameSync(`${schema}.tmp`, schema);
};
const read = () => {
  try {
    return readFileSync(out, "utf8");
  } catch {
    return "";
  }
};
async function until(condition: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("--watch regenerates on every save and survives a schema saved halfway", async () => {
  save("type Query { a: Int! }");
  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), schema, "-o", out, "--watch"], {
    stderr: "pipe",
    stdout: "ignore",
  });
  try {
    await until(() => read().includes("a: number;"));
    save("type Query { a: Int! b: String }");
    await until(() => read().includes("b: string | null;"));

    // Same types, other spacing: the output isn't rewritten, so editors don't recheck.
    const written = statSync(out).mtimeMs;
    save("type Query {\n  a: Int!\n  b: String\n}");
    await Bun.sleep(300);
    expect(statSync(out).mtimeMs).toBe(written);

    save("type Query { a: Int! b: "); // invalid: the output stays as it was
    await Bun.sleep(300);
    expect(read()).toContain("b: string | null;");
    // Another file of the directory changes: the same error isn't printed again.
    writeFileSync(join(dir, "other.txt"), "x");
    await Bun.sleep(300);

    save("type Query { c: Boolean! }");
    await until(() => read().includes("c: boolean;"));
    expect(read()).not.toContain("a: number;");

    // A change reported under another file name, as macOS can for a rename
    // over the schema: written here through a hard link.
    const alias = join(dir, "alias.graphql");
    linkSync(schema, alias);
    writeFileSync(alias, "type Query { d: ID! }");
    await until(() => read().includes("d: string;"));
  } finally {
    cli.kill();
  }
  const errors = (await new Response(cli.stderr).text()).match(/Syntax Error/g) ?? [];
  expect(errors).toHaveLength(1);
  // Spawns a process and waits on the file system: more than the default 5 s under load.
}, 20_000);

test("--watch needs a schema file and an output", async () => {
  const cli = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), schema, "--watch"], {
    stderr: "pipe",
  });
  expect(await cli.exited).toBe(1);
  expect(await new Response(cli.stderr).text()).toContain("--watch needs a schema file and -o");
});
