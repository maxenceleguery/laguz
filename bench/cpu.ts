// CPU cost of one turn (register, compose, dispatch) and minified+gzip size vs TanStack Query.
//   bun bench/cpu.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createPool, type Fields } from "@laguzjs/client";

const ENTRIES = 200;
const SUBS = 5; // consumers per entry, each with a different field subset
const row = { a: 1, b: 2, c: 3, d: 4, e: 5, nested: { x: 1, y: 2 } };
const response = {
  data: Object.fromEntries(Array.from({ length: ENTRIES }, (_, i) => [`q${i}`, row])),
};
const fieldsFor = (j: number): Fields => [
  "a",
  ["b", "c", "d", "e"][j % 4]!,
  ...(j === 0 ? [{ nested: ["x", "y"] }] : []),
];

async function turn() {
  let composed = 0;
  let dispatched = 0;
  let notified = 0;
  let t = performance.now();
  const pool = createPool(async () => {
    composed = performance.now() - t;
    t = performance.now();
    return response;
  });
  for (let i = 0; i < ENTRIES; i++)
    for (let j = 0; j < SUBS; j++)
      pool.watch("item", { id: i }, fieldsFor(j), () => {
        if (++notified === ENTRIES * SUBS) dispatched = performance.now() - t;
      });
  while (notified < ENTRIES * SUBS) await Promise.resolve();
  return { composed, dispatched };
}

for (let i = 0; i < 50; i++) await turn(); // warm the JIT
const runs = [];
for (let i = 0; i < 200; i++) runs.push(await turn());
const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
const c = med(runs.map((r) => r.composed));
const d = med(runs.map((r) => r.dispatched));
console.log(
  `one turn, ${ENTRIES * SUBS} consumers over ${ENTRIES} entries: register+compose ${c.toFixed(2)} ms, dispatch ${d.toFixed(2)} ms`,
);

// Bundle size (react external, minified, gzip)
const tmp = `${import.meta.dir}/.tmp`;
mkdirSync(tmp, { recursive: true });
const entries = {
  "@laguzjs/client": `export { createPool, httpFetcher } from "@laguzjs/client"; export { useData } from "@laguzjs/client/react";`,
  "@tanstack/react-query": `export { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";`,
};
for (const [name, src] of Object.entries(entries)) {
  const file = `${tmp}/size-${name.replace(/\W/g, "")}.ts`;
  writeFileSync(file, src);
  const out = await Bun.build({
    entrypoints: [file],
    minify: true,
    external: ["react", "react-dom"],
  });
  const code = await out.outputs[0]!.text();
  console.log(
    `${name}: ${(code.length / 1024).toFixed(1)} KB min, ${(Bun.gzipSync(code).length / 1024).toFixed(1)} KB gzip`,
  );
}
