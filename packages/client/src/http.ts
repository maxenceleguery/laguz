import type { Fetcher, Response as GqlResponse } from "./pool.ts";

export type HttpOptions = {
  /** Ask for one NDJSON line per root field. Falls back to JSON if the server doesn't stream. */
  stream?: boolean;
  /** Sent with every request. A function runs before each request, e.g. to read a fresh token. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Other `fetch` options, e.g. `{ credentials: "include" }`. */
  init?: Omit<RequestInit, "method" | "headers" | "body">;
  /** Replaces the global `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
};

/** A fetcher that POSTs `{ query }` to `url`. */
export function httpFetcher(url: string, options: HttpOptions = {}): Fetcher {
  const send = async (query: string, signal?: AbortSignal) => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: options.stream ? "application/x-ndjson, application/json" : "application/json",
    });
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    const own = options.init?.signal;
    const res = await (options.fetch ?? fetch)(url, {
      ...options.init,
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      signal: own && signal ? AbortSignal.any([own, signal]) : (own ?? signal),
    });
    // A GraphQL error comes back as JSON whatever the status. Anything else,
    // like a proxy's HTML error page, would only fail to parse.
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return res;
  };
  return (query, { signal } = {}) =>
    options.stream
      ? lines(send(query, signal))
      : send(query, signal).then((res) => res.json() as Promise<GqlResponse>);
}

async function* lines(pending: Promise<Response>): AsyncGenerator<GqlResponse> {
  const res = await pending;
  if (!res.headers.get("content-type")?.includes("ndjson")) {
    yield await res.json();
    return;
  }
  let buffer = "";
  for await (const text of res.body!.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
