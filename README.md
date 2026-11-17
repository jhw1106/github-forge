# github-forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun)
[![rank](https://make.fun/badge/github-core-clone-01/jhw1106/github-forge/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/github-core-clone-01/jhw1106/github-forge/reward.svg)](https://make.fun)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only.
No install step, no packages, no native add-ons, no git binary, no outside service.

It serves four surfaces from a single in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — `git-upload-pack` protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow/deepen) and v0,
  plus `git-receive-pack` v0 with `report-status`, `side-band-64k` and
  `delete-refs`. Packs are built and read directly (SHA-1 objects, zlib,
  no deltas needed). Every ref update must fast-forward; a non-fast-forward
  push is refused per ref with `ng <ref> non-fast-forward` and the ref does
  not move.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with real git commits), labels, issues, comments and
  pull requests with squash merge and conflict detection. Every reply is
  JSON with an `X-GitHub-Request-Id` header.
- **GraphQL** at `/api/graphql` — `viewer`, `repository`, `node`, the
  `Issue` / `PullRequest` / `Repository` / `SearchType` introspection the
  checks describe, cursor-paginated issue and pull-request connections, and
  the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`
  and `addComment` mutations. Two operation documents in one body answer two
  results in order; an unknown field is an HTTP 200 with an errors array.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, plain JSON. The
  modern 2026-07-28 era (`server/discover`) plus the legacy `initialize`
  handshake. Six tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Running

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env, answers
`GET /healthz`, then polls `$MAKEFUN_ENV_URL/done` until the trial ends and
exits 0. Auth is `Authorization: Bearer <token>` on every surface; a
repository belongs to the login the token names.

## Determinism

No wall clock and no unseeded randomness anywhere in a reply: server-created
commits carry a fixed identity and timestamp, dates come from
`MAKEFUN_TRIAL_NOW`, and every id is a counter. A replay leaves the same
state.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — HTTP server, routing, auth, body reading, JSON envelope.
- `store.ts` — the in-memory store, git object codecs, packfiles, pkt-lines,
  three-way merge, diff, and the domain operations shared by all surfaces.
- `gitproto.ts` — the git smart-HTTP handlers.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — the GraphQL parser and executor.
- `mcp.ts` — the MCP handlers and tool definitions.
