// Real-browser benchmark: TanStack Query vs laguz on the same dashboard,
// over HTTP/1.1 and HTTP/2, with emulated networks. Writes docs/benchmarks/dashboard.md
// and the raw runs to bench/results.json.
//   bun bench/run.ts            (REPS=5 by default)
import { writeFileSync } from "node:fs";
import { launch } from "./cdp";
import { counters, DB_MS, reset, SLOW_MS } from "./schema";
import { link, startTls, type Encoding } from "./server";

const DIR = import.meta.dir;
const REPS = Number(process.env.REPS ?? 5);
const MODES = ["tanstack", "pool", "pool-stream"] as const;
const NETWORKS = {
  localhost: null,
  "4g": { rtt: 50, down: 10e6, up: 5e6 }, // bits/s
  "slow-4g": { rtt: 150, down: 1.6e6, up: 0.75e6 },
} as const;
const PROTOCOLS = { "http/1.1": ["--disable-http2"], h2: [] } as const;
const ENCODINGS = (process.env.ENCODINGS ?? "identity,gzip,br").split(",") as Encoding[];

const server = await startTls();

type Phase = "cold" | "nav" | "refresh" | "mutate";
type Net = { requests: number; up: number; down: number; db: number };
type Spread = { first: number; median: number; last: number };
type Run = {
  encoding: string;
  protocol: string;
  network: string;
  mode: string;
  negotiated: string[];
  widgets: Spread;
  nav: Spread;
  net: Record<Phase, Net>;
  refreshMs: number;
  optimisticMs: number;
  mutateSettledMs: number;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function runOnce(
  browser: Awaited<ReturnType<typeof launch>>,
  protocol: string,
  encoding: Encoding,
  network: keyof typeof NETWORKS,
  mode: string,
): Promise<Run> {
  link.encoding = encoding;
  const tab = await browser.tab();
  await tab.s("Page.enable");
  await tab.s("Network.enable");
  await tab.s("Network.setCacheDisabled", { cacheDisabled: true });
  const n = NETWORKS[network];
  // Bandwidth via CDP. Its `latency` is only a floor on time-to-headers (it overlaps server
  // time), so RTT is added server-side instead, on the request and on every response write.
  if (n)
    await tab.s("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: n.down / 8,
      uploadThroughput: n.up / 8,
    });
  link.rttMs = n?.rtt ?? 0;

  let phase: Phase = "cold";
  const net = {
    cold: { requests: 0, up: 0, down: 0, db: 0 },
    nav: { requests: 0, up: 0, down: 0, db: 0 },
    refresh: { requests: 0, up: 0, down: 0, db: 0 },
    mutate: { requests: 0, up: 0, down: 0, db: 0 },
  };
  const owner = new Map<string, Phase>();
  const negotiated = new Set<string>();
  const off = browser.on((m) => {
    if (m.sessionId !== tab.sessionId) return;
    const p = m.params;
    if (m.method === "Network.requestWillBeSent" && p.request.url.endsWith("/graphql")) {
      owner.set(p.requestId, phase);
      net[phase].requests++;
      net[phase].up += p.request.postData?.length ?? 0;
    } else if (m.method === "Network.responseReceived" && owner.has(p.requestId))
      negotiated.add(p.response.protocol);
    else if (m.method === "Network.loadingFinished" && owner.has(p.requestId))
      net[owner.get(p.requestId)!].down += p.encodedDataLength;
  });

  reset();
  counters.dbCalls = 0;
  const loaded = tab.once("Page.loadEventFired");
  await tab.s("Page.navigate", { url: `https://localhost:${server.port}/?mode=${mode}` });
  await loaded;
  const marks: number[] = Object.values(await tab.evaluate("__ready"));
  net.cold.db = counters.dbCalls;

  phase = "nav";
  counters.dbCalls = 0;
  const nav: Spread = await tab.evaluate("__nav()");
  net.nav.db = counters.dbCalls;

  phase = "refresh";
  counters.dbCalls = 0;
  const { settledMs: refreshMs } = await tab.evaluate("__refresh()");
  net.refresh.db = counters.dbCalls;

  phase = "mutate";
  counters.dbCalls = 0;
  const { optimisticMs, settledMs: mutateSettledMs } = await tab.evaluate("__mutate()");
  await Bun.sleep(50); // let loadingFinished events land
  net.mutate.db = counters.dbCalls;

  off();
  await tab.close();
  return {
    protocol,
    encoding,
    network,
    mode,
    negotiated: [...negotiated],
    widgets: { first: Math.min(...marks), median: median(marks), last: Math.max(...marks) },
    nav,
    net,
    refreshMs,
    optimisticMs,
    mutateSettledMs,
  };
}

const runs: Run[] = [];
for (const [protocol, flags] of Object.entries(PROTOCOLS)) {
  const browser = await launch(`${DIR}/.tmp/chrome-${protocol.replace("/", "")}`, [
    "--ignore-certificate-errors",
    ...flags,
  ]);
  for (const encoding of ENCODINGS)
    for (const network of Object.keys(NETWORKS) as (keyof typeof NETWORKS)[]) {
      for (const mode of MODES) await runOnce(browser, protocol, encoding, network, mode); // warm-up, discarded
      for (let rep = 0; rep < REPS; rep++)
        for (const mode of MODES) {
          const r = await runOnce(browser, protocol, encoding, network, mode);
          runs.push(r);
          console.log(
            protocol,
            encoding,
            network,
            mode,
            rep,
            `last=${r.widgets.last.toFixed(0)}ms req=${r.net.cold.requests} down=${r.net.cold.down}`,
            r.negotiated.join(","),
          );
        }
    }
  browser.close();
}
server.close();
writeFileSync(`${DIR}/results.json`, JSON.stringify(runs, null, 1));

// Report
const groups = Map.groupBy(runs, (r) => `${r.protocol}|${r.encoding}|${r.network}|${r.mode}`);
const ms = (x: number) => `${Math.round(x)}`;
const kb = (x: number) => (x / 1024).toFixed(1);
const row = (k: string, f: (rs: Run[]) => string[]) =>
  `| ${k.split("|").join(" | ")} | ${f(groups.get(k)!).join(" | ")} |`;
const m = (rs: Run[], f: (r: Run) => number) => median(rs.map(f));

const keys = [...groups.keys()];
const out = `# Benchmark: laguz vs TanStack Query

Generated by \`bun bench/run.ts\` on ${new Date().toISOString().slice(0, 10)}. Headless Chromium, production React build,
${REPS} runs per cell (median, after one warm-up). Same 20-widget dashboard, same server, same cache semantics
(staleTime 0, 3 retries). DB round trip ${DB_MS} ms, \`stats\` is a slow ${SLOW_MS} ms analytics query.
Bandwidth emulated via CDP; RTT added server-side (half on the request, half on every response write),
so it stacks with server time like a real network. Encodings: dynamic responses at on-the-fly CDN levels
(brotli 5, gzip 6, NDJSON flushed per line), the bundle precompressed at max. TCP/TLS handshakes are not modeled, which favors the
many-request baseline on HTTP/1.1 (it opens up to 6 connections). Bytes are uncompressed bodies, up = request bodies,
down = encoded response size.

Negotiated protocols seen: ${[...new Set(runs.flatMap((r) => r.negotiated))].join(", ")}.

## Cold load (time to data, ms since navigation start)

| protocol | encoding | network | mode | first widget | median widget | last widget | requests | KB up | KB down | DB calls |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${keys.map((k) => row(k, (rs) => [ms(m(rs, (r) => r.widgets.first)), ms(m(rs, (r) => r.widgets.median)), ms(m(rs, (r) => r.widgets.last)), ms(m(rs, (r) => r.net.cold.requests)), kb(m(rs, (r) => r.net.cold.up)), kb(m(rs, (r) => r.net.cold.down)), ms(m(rs, (r) => r.net.cold.db))])).join("\n")}

## In-app navigation (cache cleared, 20 widgets remount; ms since remount)

Isolates the data layer from bundle download.

| protocol | encoding | network | mode | first widget | median widget | last widget | requests | KB up | KB down | DB calls |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${keys.map((k) => row(k, (rs) => [ms(m(rs, (r) => r.nav.first)), ms(m(rs, (r) => r.nav.median)), ms(m(rs, (r) => r.nav.last)), ms(m(rs, (r) => r.net.nav.requests)), kb(m(rs, (r) => r.net.nav.up)), kb(m(rs, (r) => r.net.nav.down)), ms(m(rs, (r) => r.net.nav.db))])).join("\n")}

## Refresh all (refetch-on-focus equivalent) and optimistic rename + invalidate

| protocol | encoding | network | mode | refresh ms | refresh requests | refresh DB | optimistic paint ms | mutation settled ms | mutation requests | mutation DB |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${keys.map((k) => row(k, (rs) => [ms(m(rs, (r) => r.refreshMs)), ms(m(rs, (r) => r.net.refresh.requests)), ms(m(rs, (r) => r.net.refresh.db)), m(rs, (r) => r.optimisticMs).toFixed(1), ms(m(rs, (r) => r.mutateSettledMs)), ms(m(rs, (r) => r.net.mutate.requests)), ms(m(rs, (r) => r.net.mutate.db))])).join("\n")}
`;
writeFileSync(`${DIR}/../docs/benchmarks/dashboard.md`, out);
console.log(out);
process.exit(0);
