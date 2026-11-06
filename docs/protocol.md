# laguz wire protocol, version 1

The contract between `@laguzjs/client` and `@laguzjs/server`. The client also
works against any GraphQL server (falling back to plain JSON and client-side
resolution); everything below marked **server** is what the server package adds.

## Request

`POST` with a JSON body `{ "query": "<document>" }`.

- `accept: application/x-ndjson, application/json` asks for streaming.
- The document is one anonymous query operation whose root fields are all
  aliased `q0`, `q1`, ... (unique per request, in dependency order):

  ```graphql
  {
    q0: user(id: 1) {
      name
      avatar_1kc87rv: avatar(size: 128)
    }
    q1: stats {
      revenue
    }
  }
  ```

  Nested aliases (`<field>_<hash>`) are a client concern: to the server they are
  ordinary GraphQL aliases.

- Argument values are inline literals; the document declares no variables.

## Response

Either a standard GraphQL JSON response, or (**server**, when NDJSON was
accepted) `content-type: application/x-ndjson`: one GraphQL response per line,
one root field per line, in completion order.

```
{"data":{"q1":{"revenue":48210.5}}}
{"data":{"q0":{"name":"Ada Lovelace","avatar_1kc87rv":"/a/1.png?s=128"}}}
```

- A field error carries the alias first in its path: `{"data":{"q0":null},"errors":[{"message":"...","path":["q0"]}]}`.
- **server**: each root field is validated on its own, so an invalid field
  fails only its line.
- A line (or JSON body) with no `data` and an error without `path` is a
  request-level failure. The client then resends each field on its own.
- If the response is compressed, the server must flush the compressor after
  every line; otherwise the stream degrades into one late response.

## References (**server**)

A dependent field takes an argument from an earlier field's result through an
undeclared variable named

```
$_ref__q<n>__<segment>[__<segment>...]
```

which means "the value at `q<n>.<segment>...`". Segments are response keys of
plain fields and never contain `__`.

```graphql
{
  q0: user(id: 1) {
    teamId
  }
  q1: team(id: $_ref__q0__teamId) {
    leadId
  }
  q2: user(id: $_ref__q1__leadId) {
    name
  }
}
```

The server runs `q<n>` first, substitutes the value as a literal, then validates
and executes the dependent field. Rules:

- A reference may only point to a field earlier in the selection. A forward
  reference is unresolved, so a request can't deadlock on a cycle.
- If the dependency failed or the value is missing, the dependent fails with
  `path: ["q<m>"]`.
- Clients only send references to a server that identified itself (see
  Versioning) or when configured with `serverRefs: true`; a plain server would
  reject the undeclared variable.

## Versioning

The server's first NDJSON line (or its merged JSON body) carries
`"extensions": { "laguz": 1 }`, the protocol version. In-band rather than an
HTTP header, so it survives any transport the client plugs in. With
`serverRefs: "auto"` (the default) the client resolves references itself until
it has seen the marker, then forwards them.
