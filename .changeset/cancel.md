---
"@laguzjs/client": minor
"@laguzjs/server": patch
---

Request cancellation. The pool aborts a request once nothing waits for any of its pending fields (the components unmounted, or an invalidation replaced them), checked at the end of the task so StrictMode's remount keeps it. Aborted requests report no error, aren't retried and don't use up retries. Fetchers receive `options.signal`, which `httpFetcher` passes to `fetch` (combined with `init.signal`). On the server, cancelling a streamed response closes its results.
