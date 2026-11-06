---
"@laguzjs/client": minor
---

Server rendering. The hooks no longer throw during a server render: `useSyncExternalStore` was missing its server snapshot. `pool.dehydrate()` returns the loaded entries as JSON-safe values and `pool.hydrate(state)` adds them to another pool, keeping newer data and the fields only the browser loaded; `useHydrate(pool, state)` hydrates during render. Without a `window`, pools default to `gcTime: Infinity` and `retry: 0`, so a server request never waits on retries or leaves timers behind. `gcTime: Infinity` used to collect entries at once.
