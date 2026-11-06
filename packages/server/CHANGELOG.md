# @laguzjs/server

## 0.1.2

### Patch Changes

- 0b5c999: Validate a batch once instead of once per root field, and cache parsed and validated documents. A repeated 19-field query now costs about a third of the CPU of graphql-js's `graphql()`, down from five times as much. An exception thrown by a custom `execute` now fails only its field.

## 0.1.1

### Patch Changes

- 3c3a296: `createHandler` answers 400 when the body isn't JSON or has no `query` string, and 405 for methods other than POST, instead of throwing.

## 0.1.0

Initial release.
