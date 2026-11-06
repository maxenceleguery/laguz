---
"@laguzjs/client": minor
---

Streaming server rendering. `createPoolContext(create, { useServerInsertedHTML })`, given Next's hook from `next/navigation`, streams the data `useSuspenseData` loads during the server render to the browser with the HTML: each flush carries the entries settled since the last one, and the browser pool hydrates from them before React hydrates the content that uses them. Pages need no server-side prefetch; data already hydrated from props isn't sent again.
