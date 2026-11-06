---
"@laguzjs/client": minor
---

Background refresh state. `useData` and `useInfiniteData` return `fetching`, true while data already shown is refreshed (retries included; a first load is `loading`), and `refetch()`, which refreshes the entry or every loaded page while the data stays on screen. Snapshots carry `fetching`. `pool.invalidate(root, args)` targets a single entry.
