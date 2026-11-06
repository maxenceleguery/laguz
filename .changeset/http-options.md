---
"@laguzjs/client": minor
---

`httpFetcher` options: `headers` can be a function, sync or async, that runs before each request (fresh auth tokens), `init` passes other `fetch` options such as `credentials`, and `fetch` replaces the global one. A response that isn't JSON, such as a proxy's error page, now fails with its HTTP status instead of a JSON parse error.
