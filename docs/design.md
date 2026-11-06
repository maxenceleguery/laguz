# Design notes

## The batch boundary is the commit

Request batching usually means waiting a few milliseconds and sending whatever
arrived in that window. The window is a guess: too short and requests leak into
separate batches, too long and every request pays for it.

React already knows when a set of components belongs together: the commit.
`useSyncExternalStore` subscribes every store of a commit in one synchronous
pass, after the commit is complete. The pool schedules its flush with
`queueMicrotask`, which runs once that pass returns, so one commit becomes one
request without any timer. A component that mounts later, for example because
its parent just received data, lands in the next commit and the next request.
That second round trip is inherent to the data dependency; the way around it is
described under "Dependent queries" below.

Registration happens after paint. Registering during render would start the
request a few milliseconds earlier, but React may discard a concurrent render,
and a registration made there would leak.

## Streaming is what makes batching free

A batched response is only as fast as its slowest field. On the dashboard used
by the benchmarks, one analytics query takes 300 ms while every other widget
needs about 20 ms of server time. Sent as one plain JSON response, every widget
waits 300 ms. That is worse than one request per widget.

`@laguzjs/server` executes each root field on its own and writes one NDJSON line
per field as soon as it completes. The client dispatches each line on arrival.
The fast widgets render as early as they would with separate requests, and the
batch still costs one request, one connection slot and one loader context on
the server.

Per-field execution has a second benefit. GraphQL validation is all or nothing:
a single unknown field rejects the whole document. When fields are validated
separately, only the bad one fails. Against a server that validates the whole
document, the client handles the same case by resending each field alone after
a request-level error.

## Dependent queries

A query that needs another query's result normally costs one round trip per
level. With `ref()`, the client can send the dependency and the dependent
together and let the server connect them: the dependent's argument is a
placeholder naming an earlier field of the same request, and the server
substitutes the value once that field resolves. References may only point
backwards, so a request can't contain a cycle.

## Borrowed from processor design

Much of the pool reads like the front end of a processor: components issue
loads, a commit is the issue window, the server is the execution unit.

| Processor technique              | In laguz                                        |
| -------------------------------- | ----------------------------------------------- |
| Common subexpression elimination | Merging identical root fields across components |
| Miss status holding registers    | Fields in flight are never requested twice      |
| Out-of-order completion          | Fields stream back in the order they resolve    |
| Operand forwarding               | `ref()` arguments filled in on the server       |
| Stride prefetching               | `useInfiniteData({ prefetch })`                 |

The in-order counterpart shows up too: React reveals Suspense boundaries in
batches about 300 ms apart, which delays fast data no matter how it was
fetched.

Ideas that follow from the same analogy and are not implemented yet:

- **Value prediction.** On a refresh, assume a dependency's value didn't change
  and refetch its dependents in the same request, discarding the result if the
  guess was wrong. This would help servers that can't resolve references.
- **Trace caching.** Pages render the same few combinations of components, so
  the same composed queries come back. Registering them as persisted queries
  would shrink requests and allow GET requests that a CDN can cache.
- **Profile-guided selection.** Record which selected fields components
  actually read, to find over-fetching.
- **Coherence across tabs.** Share one cache between tabs of the same app.
