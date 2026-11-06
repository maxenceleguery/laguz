---
"@laguzjs/server": patch
---

Validate a batch once instead of once per root field, and cache parsed and validated documents. A repeated 19-field query now costs about a third of the CPU of graphql-js's `graphql()`, down from five times as much. An exception thrown by a custom `execute` now fails only its field.
