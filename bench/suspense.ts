// Does one turn survive React 19 Suspense? Counts requests and root fields per
// request for a cold in-app navigation, per boundary layout, and when a fast
// widget (header) and the slow one (stats) appear.
//   SLOW_MS=400 bun bench/suspense.ts   (keep the slow query off React's 300 ms reveal window)
import { launch } from "./cdp";
import { counters } from "./schema";
import { start } from "./server";

const MODES = [
  "pool-stream",
  "pool-suspense",
  "pool-suspense-each",
  "tanstack",
  "tanstack-suspense",
  "tanstack-suspense-each",
];
const REPS = 3;
const server = await start({});
const browser = await launch(`${import.meta.dir}/.tmp/chrome-suspense`);
console.log(
  "| mode | requests | root fields per request | fast widget ms | slow widget ms |\n|---|---:|---|---:|---:|",
);
for (const mode of MODES) {
  const rows: { batches: number[]; last: number; byWidget: Record<string, number> }[] = [];
  for (let i = 0; i < REPS; i++) {
    const tab = await browser.tab();
    await tab.s("Page.enable");
    const loaded = tab.once("Page.loadEventFired");
    await tab.s("Page.navigate", { url: `http://localhost:${server.port}/?mode=${mode}` });
    await loaded;
    await tab.evaluate("__ready");
    counters.batches = [];
    const { last, byWidget } = await tab.evaluate("__nav()");
    rows.push({ batches: [...counters.batches], last, byWidget });
    await tab.close();
  }
  const r = rows.sort((a, b) => a.last - b.last)[REPS >> 1]!;
  console.log(
    `| ${mode} | ${r.batches.length} | ${r.batches.length > 4 ? `${r.batches.length} x ${r.batches[0]}` : r.batches.join(" + ")} | ${r.byWidget.header} | ${r.byWidget.stats} |`,
  );
}
browser.close();
server.close();
process.exit(0);
