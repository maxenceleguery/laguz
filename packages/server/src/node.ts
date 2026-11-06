// Mount a fetch-style handler (`createHandler`) on Node's http server, Express or
// Fastify: `app.post("/graphql", toNodeHandler(createHandler({ schema })))`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function toNodeHandler(handler: (request: Request) => Promise<Response>) {
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      // A body parser (express.json()) has read the stream already.
      body: !hasBody
        ? undefined
        : req.body !== undefined
          ? JSON.stringify(req.body)
          : (Readable.toWeb(req) as unknown as ReadableStream),
      duplex: "half",
    } as RequestInit);
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    // The client went away: stop producing results it won't read.
    res.on("close", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      // Written as it comes, so streamed results reach the client one by one.
      res.write(value);
    }
    res.end();
  };
}
