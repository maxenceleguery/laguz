---
"@laguzjs/client": minor
---

`createPoolContext(create)` returns `PoolProvider`, `Hydrate`, `usePool` and `useData`, `useSuspenseData`, `useInfiniteData` and `useMutation` bound to the provided pool, replacing the context code every server-rendered app wrote by hand. The provider creates one pool per mount, so per request on the server and per page load in the browser, and hydrates it from its `state` prop.
