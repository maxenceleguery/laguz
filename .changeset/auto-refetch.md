---
"@laguzjs/client": minor
---

Automatic refetching. In browsers, pools refetch the entries in use that are older than `staleTime`, and retry failed ones, when the tab becomes visible again (`refetchOnFocus`) and when the network comes back (`refetchOnReconnect`), in one request; both default to true. `useData` and `useInfiniteData` take `refetchInterval` to poll while mounted, paused while the tab is hidden; entries polled at the same interval share one request. `pool.watch` takes an options object (`{ minStaleTime, refetchInterval }`) instead of a minimum stale time.
