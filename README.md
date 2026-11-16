# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/minhvo7332/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/minhvo7332/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: smart-HTTP git (upload-pack v2 / receive-pack v0), REST v3, GraphQL and MCP, over an in-memory object store. One process, stdlib only — no dependencies.

What it implements:

- **Git smart HTTP** at `/{owner}/{repo}.git` — `upload-pack` (protocol v2 when the client asks, v0 otherwise) and `receive-pack` (v0), including shallow clones, deepen, annotated tags, and non-fast-forward rejection.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents (create/update/delete with SHA checks), issues, labels, comments, pull requests (files, merge with squash, conflict detection), and GitHub-style pagination with `Link` headers.
- **GraphQL** at `/api/graphql` — repositories, issues, pull requests, commits, files, and mutations (`createIssue`, `createPullRequest`, `mergePullRequest`, `addComment`) with stable opaque global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 with `server/discover`, `initialize`, `tools/list`, and `tools/call` for the repository, issue, and pull-request tools.

## Run it

```sh
node main.ts
```

Requires Node 22+ (uses type stripping — no build step). The server listens on an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, and exits when `$MAKEFUN_ENV_URL/done` reports done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vtp8qmbj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
