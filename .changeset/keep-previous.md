---
"@laguzjs/client": minor
---

`keepPrevious`: `useData` and `useInfiniteData` can keep returning the previous arguments' data, flagged with `previous: true`, while new arguments load, instead of emptying the screen on every filter or search change. `useInfiniteData` now starts over at one page when the first page's arguments change, instead of refetching as many pages as were shown, one after the other.
