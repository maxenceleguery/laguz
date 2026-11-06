---
"@laguzjs/client": minor
"@laguzjs/server": minor
---

Enum arguments: `enumValue("DESC")` prints as `DESC` instead of a quoted string, in root and field arguments, inside input objects and lists. The server now types values forwarded through `ref()` by the argument they fill, so a referenced enum field can feed an enum argument.
