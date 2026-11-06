---
"@laguzjs/client": minor
---

Queries defined once: `queries<Schema>()` returns a typed factory of query descriptors (`{ root, args, fields }`), checked and autocompleted where they are defined. `useData`, `useSuspenseData` and `pool.load` take a descriptor in place of `root, args, fields` (`null` skips in `useData`), and `useInfiniteData` pages can be descriptors, so a server load and the components that read it always build the same entry.
