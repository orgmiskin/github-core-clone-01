# github-core-clone-01

A GitHub-compatible git forge in one process: git smart HTTP, REST v3,
GraphQL v4 and MCP, all backed by a single in-memory store. Standard library
only — no dependencies.

## What it is

One server speaks four protocols, and they all see the same state. A push
over git smart HTTP shows up in REST commit listings; an issue created over
GraphQL is visible over MCP; a pull request merged over REST updates the
branches a clone sees. There is no database: the store lives in memory and
is rebuilt from the trial's seed, so a replay of the same trial produces the
same state byte for byte.

- **Git smart HTTP** — upload-pack v2 (`ls-refs`, `fetch` with shallow and
  deepen) and receive-pack v0, fast-forward only. Packs are generated
  undeltified and cached per (repo, wants, haves, depth).
- **REST v3** — repos, branches, refs, commits, contents, labels, issues,
  comments and pull requests under `/api/v3`, with GitHub-shaped bodies,
  pagination and the usual status codes (422 on a duplicate repo name or an
  unknown label, 409 on a stale content sha, 405 on a conflicted merge).
- **GraphQL v4** — viewer, repository, issue and pull-request reads,
  `node(id:)` with opaque global ids, `__type` introspection, cursor
  pagination, batched documents, and the create/close/merge/comment
  mutations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP at `/mcp`, the modern
  `server/discover` era with `initialize` kept for legacy clients, and the
  six tools of github-mcp-server: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Layout

```
main.ts          entry point: bind, register with the env, poll for done
app.ts           the server: one Forge, dispatch by path
lib/
  store.ts       the in-memory forge: repos, issues, pulls, git objects,
                 fetch selection, three-way merge
  gitobj.ts      git objects, packs, pkt-lines, sideband framing
  githttp.ts     smart HTTP: advertisements, ls-refs, fetch, receive-pack
  rest.ts        the REST v3 router
  graphql.ts     a small GraphQL lexer, parser and executor
  mcp.ts         the MCP tools and JSON-RPC plumbing
  http.ts        body reading and JSON replies
  util.ts        config, auth, viewer identity, small helpers
```

## Running it

Node 22 or newer, no install step:

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL/register`, and exits when the environment reports done.
For local hacking, `createApp()` in `app.ts` is the server on its own —
listen on any port and talk to it with a bearer token of your choice:

```sh
curl -H "Authorization: Bearer dev" localhost:PORT/api/v3/user
```

Environment variables the entry honours:

| Variable | Meaning |
| --- | --- |
| `MAKEFUN_SHOP_TOKEN` | The bearer token the suite presents; when set, only this exact token is accepted. Unset, any non-empty bearer token works (local runs). |
| `MAKEFUN_TRIAL_SEED` | Seeds deterministic behaviour for the trial. |
| `MAKEFUN_TRIAL_NOW` | The fixed "now" every timestamp is derived from. |
| `MAKEFUN_ENV_URL` | The environment to register with and poll. |

## Determinism

The forge never reads the wall clock and never rolls unseeded randomness.
Timestamps come from `MAKEFUN_TRIAL_NOW` plus a per-request counter, request
ids come from a counter, and the authenticated user is always the scenario
viewer. Two runs of the same trial produce the same exported state.

## License

MIT. See [LICENSE](LICENSE).
