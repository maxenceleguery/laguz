---
"@laguzjs/server": patch
---

`createHandler` answers 400 when the body isn't JSON or has no `query` string, and 405 for methods other than POST, instead of throwing.
