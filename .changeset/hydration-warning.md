---
"@laguzjs/client": minor
---

In development, the pool warns when a hydrated entry has to be fetched right after hydration: the server loaded fewer fields than the components read (the warning names them), or the data was already older than `staleTime`.
