# Contributing

Thanks for taking the time. Bug reports with a reproduction, focused pull
requests and benchmark results from real applications are all welcome.

For anything larger than a fix, open an issue first so we can agree on the
approach before you spend time on it.

## Setup

You need [Bun](https://bun.sh) (the version is pinned in `package.json`).

```sh
git clone https://github.com/maxenceleguery/laguz.git
cd laguz
bun install        # also installs the git hooks
bun run check      # format, lint, types and tests
```

| Command             | Does                                              |
| ------------------- | ------------------------------------------------- |
| `bun test`          | Unit and integration tests                        |
| `bun run typecheck` | TypeScript                                        |
| `bun run lint`      | oxlint                                            |
| `bun run format`    | oxfmt                                             |
| `bun run build`     | Builds both packages to `dist/`                   |
| `bun run demo`      | The benchmark page on http://localhost:3020       |
| `bun run bench`     | The browser benchmarks (needs Chromium on `PATH`) |

## Repository layout

- `packages/client`: `@laguzjs/client`. The pool (`pool.ts`), selection
  handling (`selection.ts`), the HTTP transport and the React hooks.
- `packages/server`: `@laguzjs/server`.
- `bench`: the benchmark server, page and drivers.
- `docs`: the guide, the protocol and the benchmark reports.
- `site`: the project page.

## Workflow

`main` is always releasable. Work on a short-lived branch named after what it
does (`fix/retry-delay`, `feat/enum-args`, `docs/suspense`) and open a pull
request against `main`. Pull requests are squash-merged, so the title becomes
the commit message.

Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`,
`docs`, `test`, `refactor`, `perf`, `build`, `ci` or `chore`, an optional scope
(`client`, `server`, `bench`, `site`), and a short description in the
imperative:

```
fix(client): retry fields that failed together in one request
```

The git hooks format and lint staged files on commit, check the commit message,
and run the type check and tests before a push.

## Changes to the packages

- Add or update tests for every behavior change. Tests live next to the code
  (`*.test.ts`) and run with `bun test`.
- If a published package changes, add a changeset with `bun changeset` and
  describe the change for users in a sentence or two. Both packages are
  released together with the same version.
- If the wire format changes, update `docs/protocol.md` and keep the client and
  server compatible, or bump the protocol version.
- Performance claims need numbers. Run the relevant benchmark before and after,
  and include the results in the pull request.

## Releases

Merging to `main` updates a "version packages" pull request with the pending
changesets. Merging that pull request publishes both packages to npm with
provenance, from the release workflow.
