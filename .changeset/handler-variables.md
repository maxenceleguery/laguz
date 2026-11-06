---
"@laguzjs/server": patch
---

`createHandler` passes `variables` and `operationName` from the request body to `execute`, so mutations and other ordinary GraphQL requests work on the same endpoint. It answers 400 when `variables` is not an object or `operationName` not a string.
