// Serves the dashboard page and /graphql. Plain HTTP for the demo, TLS with
// HTTP/2 + HTTP/1.1 fallback for the benchmark (browsers only speak h2 over TLS).
import { graphql } from "graphql";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecureServer } from "node:http2";
import {
  brotliCompressSync,
  constants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from "node:zlib";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { splitExecute } from "@laguzjs/server";
import { context, counters, rootValue, schema } from "./schema";

const page = async () => {
  const out = await Bun.build({
    entrypoints: [`${import.meta.dir}/page.tsx`],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!out.success) throw new AggregateError(out.logs, "bundle failed");
  return out.outputs[0]!.text();
};

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>laguz dashboard</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:1rem auto;max-width:1100px;padding:0 16px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
section{border:1px solid #ccc;border-radius:6px;padding:6px 10px;min-height:60px}
section h3{margin:0 0 4px;font-size:12px;color:#666}pre{margin:0;white-space:pre-wrap;font-size:11px}
nav a{margin-right:1rem}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;

/** Emulated network: every request and every response write is delayed by half the RTT. */
export const link = { rttMs: 0, encoding: "identity" as Encoding };
const later = (f: () => void) => (link.rttMs ? void setTimeout(f, link.rttMs / 2) : f());

// Dynamic responses at the levels CDNs use on the fly (br 5, gzip 6); static assets precompressed at max.
export type Encoding = "identity" | "gzip" | "br";
const BR = constants.BROTLI_PARAM_QUALITY;
const compress = (body: string, enc: Encoding, maxLevel = false): string | Buffer =>
  enc === "br"
    ? brotliCompressSync(body, { params: { [BR]: maxLevel ? 11 : 5 } })
    : enc === "gzip"
      ? gzipSync(body, { level: maxLevel ? 9 : 6 })
      : body;
const negotiate = (req: IncomingMessage): Encoding =>
  link.encoding !== "identity" &&
  String(req.headers["accept-encoding"] ?? "").includes(link.encoding)
    ? link.encoding
    : "identity";
const encHeader = (enc: Encoding) =>
  enc === "identity" ? {} : { "content-encoding": enc, vary: "accept-encoding" };

/** TLS server with a cached self-signed cert (browsers only speak h2 over TLS). */
export async function startTls() {
  const dir = `${import.meta.dir}/.cert`;
  if (!existsSync(`${dir}/key.pem`)) {
    mkdirSync(dir, { recursive: true });
    Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=localhost",
        "-days",
        "365",
        "-keyout",
        `${dir}/key.pem`,
        "-out",
        `${dir}/cert.pem`,
      ],
      { stderr: "ignore" },
    );
  }
  return start({
    tls: {
      key: readFileSync(`${dir}/key.pem`, "utf8"),
      cert: readFileSync(`${dir}/cert.pem`, "utf8"),
    },
  });
}

export async function start({
  port = 0,
  tls,
}: {
  port?: number;
  tls?: { key: string; cert: string };
}) {
  const js = await page();
  const jsBy = Object.fromEntries(
    (["identity", "gzip", "br"] as const).map((e) => [e, compress(js, e, true)]),
  );
  // Typed with node:http; the http2 compatibility API has the same shape.
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    await new Promise((r) => later(() => r(null))); // request travels to the server
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/graphql" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { query } = JSON.parse(body) as { query: string };
      counters.requests++;
      counters.batches.push(query.match(/\bq\d+:/g)?.length ?? 1);
      const contextValue = context();
      const enc = negotiate(req);
      if (req.headers.accept?.includes("ndjson")) {
        later(() =>
          res.writeHead(200, { "content-type": "application/x-ndjson", ...encHeader(enc) }),
        );
        // A compressor buffers until it has enough input: flush after every line
        // or per-field streaming silently turns back into one late response.
        const z =
          enc === "br"
            ? createBrotliCompress({ params: { [BR]: 5 } })
            : enc === "gzip"
              ? createGzip()
              : null;
        z?.on("data", (chunk: Buffer) => later(() => res.write(chunk)));
        const ended = z ? new Promise((r) => z.on("end", r)) : Promise.resolve();
        for await (const r of splitExecute({ schema, source: query, rootValue, contextValue })) {
          const line = JSON.stringify(r) + "\n";
          if (z) {
            z.write(line);
            z.flush();
          } else {
            later(() => res.write(line));
          }
        }
        z?.end();
        await ended;
        return later(() => res.end());
      }
      const result = await graphql({ schema, source: query, rootValue, contextValue });
      const out = compress(JSON.stringify(result), enc);
      return later(() =>
        res.writeHead(200, { "content-type": "application/json", ...encHeader(enc) }).end(out),
      );
    }
    const enc = negotiate(req);
    const [type, body] =
      path === "/app.js"
        ? ["text/javascript", jsBy[enc]!]
        : ["text/html", compress(HTML, enc, true)];
    later(() => res.writeHead(200, { "content-type": type, ...encHeader(enc) }).end(body));
  };
  const server = tls
    ? createSecureServer({ ...tls, allowHTTP1: true }, handler as any)
    : createServer(handler);
  await new Promise<void>((r) => server.listen(port, r));
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

if (import.meta.main) {
  const { port } = await start({ port: Number(process.env.PORT ?? 3020) });
  console.log(`laguz dashboard on http://localhost:${port}/?mode=pool-stream`);
}
