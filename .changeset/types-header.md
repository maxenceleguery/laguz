---
"@laguzjs/server": minor
---

`laguz-types --header "Name: value"` (repeatable) sends headers with the introspection query, for endpoints that need a key, such as Supabase or Hasura. An endpoint answering with something else than JSON now fails with its HTTP status.
