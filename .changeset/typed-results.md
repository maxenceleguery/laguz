---
"@laguzjs/client": minor
"@laguzjs/server": minor
---

Typed results. `laguz-types` (in `@laguzjs/server`, also available as `generateTypes`) generates TypeScript types from an SDL file, an introspection result or a running endpoint. With `createPool<Schema>(fetcher)`, `useData` and `useSuspenseData` type-check the root field, its arguments and the selection, autocomplete field names, and return the selected shape. `enumValue()` is now typed by the value it receives. Pools created without a schema behave as before; the hooks no longer take an explicit result type parameter (`useData<T>(...)`).
