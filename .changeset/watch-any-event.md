---
"@laguzjs/server": patch
---

`laguz-types --watch` no longer depends on the file names in file system events, which macOS can report as the temporary file of a rename-over save: any change in the schema's directory rereads it, and only a new text regenerates the types, so the same error isn't printed again for unrelated changes.
