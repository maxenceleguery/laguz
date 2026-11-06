---
"@laguzjs/client": minor
---

`operationName: (roots, type) => name` names the operations a pool sends, `query <name> { ... }` and `mutation <name> { ... }`, from their root fields, so server logs and tracing can tell batches apart. An invalid name fails the fields of that request. Named batches are still split, streamed and forwarded by `@laguzjs/server`.
