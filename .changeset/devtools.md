---
"@laguzjs/client": minor
---

Devtools. `LaguzDevtools` from `@laguzjs/client/devtools` is a panel that lists each request a pool sends, with when each of its fields arrived, and each cache entry with its status, readers, age and data, with refetch and invalidate buttons. It renders in the browser only, after hydration. It is built on two new pool methods: `pool.inspect()` reports the cache entry by entry, and `pool.observe(listener)` follows each request's start, results and outcome, at no cost until something observes.
