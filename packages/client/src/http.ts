import type { Fetcher, Response as GqlResponse } from "./pool.ts";

export type HttpOptions = {
  /** Ask for one NDJSON line per root field. Falls back to JSON if the server doesn't stream. */
  stream?: boolean;
  headers?: Record<string, string>;
};

/** A fetcher that POSTs `{ query }` to `url`. */
export function httpFetcher(url: string, options: HttpOptions = {}): Fetcher {
  return (query) => {
    const res = fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: options.stream ? "application/x-ndjson, application/json" : "application/json",
        ...options.headers,
      },
      body: JSON.stringify({ query }),
    });
    return options.stream ? lines(res) : res.then((r) => r.json());
  };
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
