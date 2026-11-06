# Benchmarks

The benchmarks compare laguz with TanStack Query on the same components, the
same server and the same cache settings (`staleTime: 0`, 3 retries), in a real
browser.

- [dashboard.md](dashboard.md): a 20-widget page, across HTTP/1.1 and HTTP/2,
  three compression settings and three networks. Cold load, in-app navigation,
  refresh, and an optimistic mutation.
- [features.md](features.md): an infinite list and a chain of three dependent
  queries.

Both files are generated. Re-run them with:

```sh
bun bench/run.ts        # about 20 minutes
bun bench/features.ts   # about 5 minutes
```

## Setup

- Headless Chromium driven over the DevTools protocol, production React build,
  5 runs per cell after a warm-up run, medians reported.
- The server (`bench/server.ts`) serves the page and `/graphql` over TLS, with
  HTTP/2 and an HTTP/1.1 fallback. Chromium is started with `--disable-http2`
  for the HTTP/1.1 runs.
- The fake database adds 10 ms per call and counts calls. The `stats` widget is
  backed by a 300 ms query. Loaders batch within one HTTP request.
- Bandwidth is throttled through the DevTools protocol. Its latency setting
  only sets a floor on time to first byte and overlaps with server time, so
  round-trip time is added by the server instead: half when the request
  arrives, half on every response write.
- Compression: brotli at quality 5 and gzip at level 6 for dynamic responses,
  as CDNs do on the fly, flushed after every NDJSON line. The JavaScript bundle
  is precompressed at maximum level.

The modes:

- `tanstack`: one `useQuery` per widget.
- `pool`: laguz with plain JSON responses.
- `pool-stream`: laguz with streamed responses from `@laguzjs/server`.
- `pool-prefetch`, `pool-refs`: `pool-stream` with pagination prefetch or
  server-resolved references.

## Results in short

On a slow 4G link over HTTP/2 with brotli:

- The median widget of a 20-widget page appears after 171 ms instead of 278 ms,
  with 1 request instead of 20, 6 database calls instead of 28, and 0.9 KB of
  responses instead of 2.2 KB. The first and last widgets appear at the same
  time in both.
- Refreshing an infinite list with 5 loaded pages takes one request and 171 ms
  instead of 5 sequential requests and 832 ms. With `prefetch: 1`, showing the
  next page takes 1 ms instead of 170 ms.
- A chain of three dependent queries takes 186 ms instead of 498 ms when the
  server resolves the references.

Over HTTP/2 on a fast network the latencies are close, and the difference is
in requests and server work. Without streaming (`pool` mode), every widget
waits for the slowest field.

## Suspense

`SLOW_MS=400 bun bench/suspense.ts` measures how React 19 Suspense affects
batching, on a cold in-app navigation over HTTP/1.1 on localhost:

| Mode                              | Requests | Root fields per request | Fast widget | Slow widget |
| --------------------------------- | -------: | ----------------------- | ----------: | ----------: |
| laguz, `useData`                  |        1 | 19                      |       34 ms |      410 ms |
| laguz, one shared `<Suspense>`    |        2 | 1 + 19                  |      413 ms |      413 ms |
| laguz, `<Suspense>` per widget    |        1 | 19                      |      305 ms |      604 ms |
| TanStack, `useQuery`              |       20 | 1 each                  |       23 ms |      414 ms |
| TanStack, one shared `<Suspense>` |       20 | 1 each                  |      413 ms |      413 ms |
| TanStack, `<Suspense>` per widget |       20 | 1 each                  |      307 ms |      608 ms |

When a component suspends, React stops rendering its siblings in the same
boundary and renders them in a later pass, which splits the batch in two. React
also reveals Suspense content in batches about 300 ms apart, so fast data waits
for the next reveal with either library.

## Limits of the setup

- The network is emulated. TCP and TLS handshakes are not modeled, which favors
  the many-request baseline on HTTP/1.1, where the browser opens up to six
  connections.
- The database is a fake with fixed latency.
- One machine runs both the browser and the server.
