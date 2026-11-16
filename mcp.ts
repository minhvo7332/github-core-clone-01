// MCP over streamable HTTP (the 2026-07-28 revision), at POST /mcp.
//
// The suite's client probes `server/discover` first: a result makes the
// session modern, so this endpoint answers discover with the supported
// revisions, the tools capability and the server identity (both as a loose
// serverInfo and under _meta, as the client reads either). The legacy
// `initialize` handshake is answered too, for completeness.
//
// tools/list is one precomputed array, so two calls are byte-identical.
// tools/call maps the suite's semantic arguments onto the canonical property
// names (owner, repo, title, body, head, base, pull_number, name,
// description, private, state) and acts on the same store as REST, so a
// repository or issue created here reads back identically over REST.
//   - an unknown tool is JSON-RPC -32602 (never HTTP 500);
//   - a missing required argument is a tool result with isError:true;
//   - a body that is not JSON is HTTP 400 with JSON-RPC -32700;
//   - no Authorization header is HTTP 401 (checked by app.ts first).

import { VIEWER_LOGIN, issueGlobalId, pullGlobalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { issueJson, pullJson, repoJson, squashMerge } from './rest.ts';

export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, desc] of Object.entries(properties)) props[key] = { type: 'string', description: desc };
  // pull_number and the private flag are not strings.
  if (properties.pull_number !== undefined) props.pull_number = { type: 'integer', description: properties.pull_number };
  if (properties.private !== undefined) props.private = { type: 'boolean', description: properties.private };
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a repository owned by the viewer.', { name: 'The repository name.', owner: 'The owner login (the viewer).', description: 'A short description.', private: 'Whether the repository is private.' }, ['name']),
  tool('get_repo', 'Read one repository by owner and name.', { owner: 'The owner login.', repo: 'The repository name.' }, ['owner', 'repo']),
  tool('list_repos', 'List the viewer repositories.', { owner: 'The owner login (the viewer).' }, []),
  tool('create_issue', 'Create an issue in a repository.', { owner: 'The owner login.', repo: 'The repository name.', title: 'The issue title.', body: 'The issue body.' }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Read one issue by number.', { owner: 'The owner login.', repo: 'The repository name.', issue_number: 'The issue number.' }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List the issues of a repository.', { owner: 'The owner login.', repo: 'The repository name.', state: 'open, closed or all.' }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', { owner: 'The owner login.', repo: 'The repository name.', title: 'The pull request title.', body: 'The pull request body.', head: 'The head branch name.', base: 'The base branch name.' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', { owner: 'The owner login.', repo: 'The repository name.', pull_number: 'The pull request number.' }, ['owner', 'repo', 'pull_number']),
]);

const TOOLS_JSON = JSON.stringify(TOOLS);

function toolResult(data: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): { isError: true; content: Array<{ type: string; text: string }> } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function missingArg(toolDef: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of toolDef.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') return required;
  }
  return null;
}

function getRepoOrNull(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repo = String(args.repo ?? '');
  if (owner !== VIEWER_LOGIN || repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

function callTool(store: Store, host: string, name: string, args: Record<string, unknown>): unknown {
  const def = TOOLS.find((entry) => entry.name === name);
  if (def === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = missingArg(def, args);
  if (missing !== null) return toolError(`missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoJson(repo, host));
    }
    case 'get_repo': {
      const repo = getRepoOrNull(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo, host));
    }
    case 'list_repos': {
      const repos = store.listRepos(VIEWER_LOGIN);
      return toolResult({ repositories: repos.map((repo) => repoJson(repo, host)) });
    }
    case 'create_issue': {
      const repo = getRepoOrNull(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const now = store.nowIso();
      const issue: Issue = {
        number,
        globalId: issueGlobalId(repo.owner, repo.name, number),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: store.issueSeq++,
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(repo, issue, host));
    }
    case 'get_issue': {
      const repo = getRepoOrNull(store, args);
      const issue = repo?.issues.get(Number(args.issue_number));
      if (issue === undefined || repo === null) return toolError('Issue not found');
      return toolResult(issueJson(repo, issue, host));
    }
    case 'list_issues': {
      const repo = getRepoOrNull(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = String(args.state ?? 'open');
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return toolResult({ issues: list.map((issue) => issueJson(repo, issue, host)) });
    }
    case 'create_pull_request': {
      const repo = getRepoOrNull(store, args);
      if (repo === null) return toolError('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.head === head && existing.base === base && existing.state === 'open') {
          return toolError('A pull request already exists for this head and base');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const now = store.nowIso();
      const pr: PullRequest = {
        number,
        globalId: pullGlobalId(repo.owner, repo.name, number),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: store.issueSeq++,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(number, pr);
      return toolResult(pullJson(repo, pr, host));
    }
    case 'merge_pull_request': {
      const repo = getRepoOrNull(store, args);
      const pr = repo?.pulls.get(Number(args.pull_number));
      if (pr === undefined || repo === null) return toolError('Pull request not found');
      if (pr.state === 'closed') return toolError('Pull request is already closed');
      const merged = squashMerge(store, repo, pr);
      if (merged.conflict) return toolError('Merge conflict');
      if (merged.sha === undefined) return toolError('Cannot merge: missing branch tip');
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = store.nowIso();
      pr.mergeCommitSha = merged.sha;
      pr.baseSha = merged.sha;
      pr.updatedAt = store.nowIso();
      return toolResult({ merged: true, sha: merged.sha, message: `Merge pull request #${pr.number} from ${pr.head}`, number: pr.number });
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Handle one POST /mcp body. Returns {status, body, headers}. */
export function handleMcp(store: Store, host: string, rawBody: Buffer): { status: number; body: string; headers: Record<string, string> } {
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      headers: jsonHeaders,
    };
  }
  const id = request.id ?? null;
  const method = String(request.method ?? '');
  const params = (request.params ?? {}) as Record<string, unknown>;
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  const ok = (result: unknown, extraHeaders: Record<string, string> = {}): { status: number; body: string; headers: Record<string, string> } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
    headers: { ...jsonHeaders, ...extraHeaders },
  });
  const rpcError = (code: number, message: string, data?: unknown): { status: number; body: string; headers: Record<string, string> } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }),
    headers: jsonHeaders,
  });

  // A notification has no id and expects no response body.
  if (method === 'notifications/initialized') {
    return { status: 202, body: '', headers: {} };
  }

  if (method === 'server/discover') {
    const declared = (params._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/protocolVersion'];
    const negotiated = typeof declared === 'string' && (MCP_VERSIONS as readonly string[]).includes(declared) ? declared : MCP_VERSIONS[0];
    void negotiated;
    return ok({
      supportedVersions: [...MCP_VERSIONS],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = (MCP_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
    return ok(
      { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo },
      { 'mcp-session-id': `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` },
    );
  }

  if (method === 'tools/list') {
    // The same precomputed array every time: two calls are byte-identical.
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: { tools: JSON.parse(TOOLS_JSON) as unknown } }), headers: jsonHeaders };
  }

  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, host, toolName, args) as Record<string, unknown>;
    if ('__rpcError' in outcome) {
      const rpcErr = outcome.__rpcError as { code: number; message: string };
      return rpcError(rpcErr.code, rpcErr.message);
    }
    return ok(outcome);
  }

  if (method === 'ping') return ok({});

  return rpcError(-32601, `Method not found: ${method}`);
}
