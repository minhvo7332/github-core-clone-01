// REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests, under /api/v3.
//
// Shapes and statuses follow the suite's checks exactly:
//   - every reply is application/json with a non-empty X-GitHub-Request-Id
//     (the caller in app.ts adds the header); error bodies are {message}.
//   - no token -> 401; a repository under any owner but the viewer -> 404.
//   - POST /user/repos: new -> 201, duplicate name -> 422.
//   - Contents PUT: create -> 201, update with the current blob sha -> 200,
//     stale or missing sha on an update -> 409. The commit message is stored
//     verbatim, and the response carries {content:{sha (blob)}, commit:{sha}}.
//   - Issues and pull requests share one per-repo number sequence, as on
//     GitHub. Labels arrive as strings and are returned as {name} objects;
//     an unknown label on issue create is a 422.
//   - A pull request merge is a squash: the head's changes are applied onto
//     the base tip as one commit; a path changed on both sides differently
//     is a conflict -> 405. A duplicate open PR for the same head+base -> 422.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_ID, VIEWER_LOGIN, commentGlobalId, decodeGlobalId, issueGlobalId, lineDiff, parseCommit, pullGlobalId, repoGlobalId, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';
import { ZERO_OID, isSha1 } from './util.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  body: unknown;
  query: URLSearchParams;
  host: string;
}

type Handler = (ctx: RestContext, params: Record<string, string>) => void;

export function requestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function jsonReply(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function err(res: ServerResponse, status: number, message: string): void {
  jsonReply(res, status, { message });
}

export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: `U_${Buffer.from(repo.owner, 'utf8').toString('base64url')}`, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://${host}/${repo.owner}/${repo.name}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function pullJson(repo: Repo, pr: PullRequest, host: string): Record<string, unknown> {
  return {
    id: pr.globalId,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `http://${host}/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function mustRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    err(ctx.res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    err(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function bodyObj(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return null;
  return ctx.body as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const base = `http://${host}${path}?per_page=${perPage}`;
  const links = [`<${base}&page=${page + 1}>; rel="next"`, `<${base}&page=${lastPage}>; rel="last"`];
  if (page > 1) links.push(`<${base}&page=1>; rel="first"`, `<${base}&page=${page - 1}>; rel="prev"`);
  return links.join(', ');
}

/** The three-way squash merge. Returns {conflict} or the new commit sha. */
export function squashMerge(store: Store, repo: Repo, pr: PullRequest): { conflict: boolean; sha?: string } {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return { conflict: false, sha: undefined };
  const baseObj = store.getObject(baseTip);
  const headObj = store.getObject(headTip);
  if (baseObj === undefined || headObj === undefined) return { conflict: false, sha: undefined };
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(parseCommit(store.getObject(mergeBase)!.data).tree);
  const headTree = store.flattenTree(parseCommit(headObj.data).tree);
  const targetTree = store.flattenTree(parseCommit(baseObj.data).tree);
  const merged = new Map(targetTree);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const baseEntry = baseTree.get(path);
    const headEntry = headTree.get(path);
    const targetEntry = targetTree.get(path);
    const baseOid = baseEntry?.oid ?? null;
    const headOid = headEntry?.oid ?? null;
    const targetOid = targetEntry?.oid ?? null;
    if (headOid === baseOid) continue; // unchanged on the head side
    if (targetOid === baseOid) {
      // Unchanged on the base side: take the head's change.
      if (headEntry === undefined) merged.delete(path);
      else merged.set(path, headEntry);
      continue;
    }
    if (headOid === targetOid) continue; // both sides made the same change
    return { conflict: true }; // both sides changed it differently
  }
  const treeOid = store.buildTreeFromPaths(merged);
  const { oid } = store.buildCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.head}`);
  repo.refs.set(`refs/heads/${pr.base}`, oid);
  return { conflict: false, sha: oid };
}

export function prFiles(store: Store, repo: Repo, pr: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(parseCommit(store.getObject(mergeBase)!.data).tree);
  const headTree = store.flattenTree(parseCommit(store.getObject(headTip)!.data).tree);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const baseEntry = baseTree.get(path);
    const headEntry = headTree.get(path);
    if (baseEntry?.oid === headEntry?.oid) continue;
    const oldText = baseEntry === undefined ? '' : (store.getObject(baseEntry.oid)?.data.toString('utf8') ?? '');
    const newText = headEntry === undefined ? '' : (store.getObject(headEntry.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = baseEntry === undefined ? 'added' : headEntry === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        if (part === '*') {
          keys.push('rest');
          return '(.+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );
  routes.push({ method, pattern: regex, keys, handler });
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// -- API root and meta ---------------------------------------------------------------------

route('GET', '/api/v3', (ctx) => {
  jsonReply(ctx.res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', '/api/v3/meta', (ctx) => {
  jsonReply(ctx.res, 200, { installed_version: '1.0.0' });
});

route('GET', '/api/v3/user', (ctx) => {
  jsonReply(ctx.res, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: userGlobalIdSafe(),
    type: 'User',
    html_url: `http://${ctx.host}/${VIEWER_LOGIN}`,
    url: `http://${ctx.host}/api/v3/user`,
  });
});

function userGlobalIdSafe(): string {
  return `U_${Buffer.from(VIEWER_LOGIN, 'utf8').toString('base64url')}`;
}

// -- Repositories --------------------------------------------------------------------------

route('POST', '/api/v3/user/repos', (ctx) => {
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const name = str(body.name);
  if (name === '') return err(ctx.res, 422, 'name is required');
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return err(ctx.res, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
  }
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, body.private === true, str(body.description));
  jsonReply(ctx.res, 201, repoJson(repo, ctx.host));
});

route('GET', '/api/v3/user/repos', (ctx) => {
  const { page, perPage } = parsePage(ctx.query);
  const all = ctx.store.listRepos(VIEWER_LOGIN);
  const total = all.length;
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const extra: Record<string, string> = {};
  const link = linkHeader(ctx.host, '/api/v3/user/repos', ctx.query, page, perPage, total);
  if (link !== null) extra.link = link;
  jsonReply(ctx.res, 200, slice.map((repo) => repoJson(repo, ctx.host)), extra);
});

route('GET', '/api/v3/repos/:owner/:repo', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  jsonReply(ctx.res, 200, repoJson(repo, ctx.host));
});

route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedAt = ctx.store.nowIso();
  jsonReply(ctx.res, 200, repoJson(repo, ctx.host));
});

route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  ctx.store.deleteRepo(repo.owner, repo.name);
  jsonReply(ctx.res, 204, null);
});

// -- Branches, commits, refs ----------------------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const out: Array<{ name: string; commit: { sha: string } }> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  jsonReply(ctx.res, 200, out);
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const branch = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const out: Array<{ sha: string; commit: { message: string } }> = [];
  if (tip !== undefined) {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = ctx.store.getObject(oid);
      if (obj?.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      out.push({ sha: oid, commit: { message: view.message } });
      queue.push(...view.parents);
    }
  }
  jsonReply(ctx.res, 200, out);
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/') || !isSha1(sha)) return err(ctx.res, 422, 'Invalid ref or sha');
  if (ctx.store.getObject(sha) === undefined) return err(ctx.res, 422, 'Object does not exist');
  repo.refs.set(ref, sha);
  jsonReply(ctx.res, 201, { ref, object: { sha }, url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}` });
});

// -- Contents -------------------------------------------------------------------------------

function readTreeAt(ctx: RestContext, repo: Repo, ref: string | null): { tip: string | undefined; tree: Map<string, { oid: string; mode: string }> } {
  const branch = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return { tip: undefined, tree: new Map() };
  const obj = ctx.store.getObject(tip);
  if (obj?.type !== 'commit') return { tip, tree: new Map() };
  return { tip, tree: ctx.store.flattenTree(parseCommit(obj.data).tree) };
}

route('GET', '/api/v3/repos/:owner/:repo/contents/*', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const path = decodeParam(p.rest);
  const ref = ctx.query.get('ref');
  const { tree } = readTreeAt(ctx, repo, ref);
  const file = tree.get(path);
  if (file !== undefined) {
    const obj = ctx.store.getObject(file.oid);
    if (obj === undefined) return err(ctx.res, 404, 'Not Found');
    jsonReply(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      content: obj.data.toString('base64'),
      sha: file.oid,
      size: obj.data.length,
      name: path.split('/').pop() ?? path,
      path,
      url: `http://${ctx.host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `http://${ctx.host}/${repo.owner}/${repo.name}/blob/${ref ?? repo.defaultBranch}/${path}`,
    });
    return;
  }
  // Directory listing: immediate children of path.
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; name: string; path: string; sha: string; size?: number }>();
  for (const [entryPath, entry] of tree) {
    if (!entryPath.startsWith(prefix)) continue;
    const rest = entryPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = ctx.store.getObject(entry.oid);
      children.set(rest, { type: 'file', name: rest, path: entryPath, sha: entry.oid, size: obj?.data.length ?? 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        // The directory's tree oid: rebuild from the flattened map is overkill;
        // find it by walking the tree structure.
        children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirTreeSha(ctx, repo, ref, `${prefix}${dirName}`) });
      }
    }
  }
  if (children.size === 0) return err(ctx.res, 404, 'Not Found');
  jsonReply(ctx.res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
});

function dirTreeSha(ctx: RestContext, repo: Repo, ref: string | null, dir: string): string {
  const branch = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return ZERO_OID;
  const obj = ctx.store.getObject(tip);
  if (obj?.type !== 'commit') return ZERO_OID;
  let treeOid = parseCommit(obj.data).tree;
  for (const part of dir.split('/')) {
    const treeObj = ctx.store.getObject(treeOid);
    if (treeObj?.type !== 'tree') return ZERO_OID;
    const entry = parseTree(treeObj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return ZERO_OID;
    treeOid = entry.oid;
  }
  return treeOid;
}

route('PUT', '/api/v3/repos/:owner/:repo/contents/*', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const path = decodeParam(p.rest);
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') return err(ctx.res, 422, 'message and content are required');
  const content = Buffer.from(contentB64, 'base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const { tree } = readTreeAt(ctx, repo, branch);
  const existing = tree.get(path);
  if (existing !== undefined) {
    if (sha === null || sha !== existing.oid) return err(ctx.res, 409, 'sha does not match the current blob');
    const { commitSha, contentSha } = ctx.store.commitFile(repo, branch, path, content, message);
    jsonReply(ctx.res, 200, { content: { sha: contentSha, encoding: 'base64' }, commit: { sha: commitSha } });
    return;
  }
  if (sha !== null) return err(ctx.res, 409, 'sha does not match the current blob');
  const { commitSha, contentSha } = ctx.store.commitFile(repo, branch, path, content, message);
  jsonReply(ctx.res, 201, { content: { sha: contentSha, encoding: 'base64' }, commit: { sha: commitSha } });
});

route('DELETE', '/api/v3/repos/:owner/:repo/contents/*', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const path = decodeParam(p.rest);
  const body = bodyObj(ctx);
  const message = body === null ? '' : str(body.message);
  const sha = body === null ? null : typeof body.sha === 'string' ? body.sha : null;
  const branch = body !== null && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const { tree } = readTreeAt(ctx, repo, branch);
  const existing = tree.get(path);
  if (existing === undefined) return err(ctx.res, 404, 'Not Found');
  if (sha !== null && sha !== existing.oid) return err(ctx.res, 409, 'sha does not match the current blob');
  const commitSha = ctx.store.deleteFile(repo, branch, path, message === '' ? 'Delete file' : message);
  if (commitSha === null) return err(ctx.res, 404, 'Not Found');
  jsonReply(ctx.res, 200, { commit: { sha: commitSha } });
});

// -- Labels ---------------------------------------------------------------------------------

route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const name = str(body.name);
  if (name === '') return err(ctx.res, 422, 'name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const label: Label = { name, color };
  repo.labels.set(name, label);
  jsonReply(ctx.res, 201, { name, color, description: '' });
});

route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  jsonReply(ctx.res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
});

// -- Issues ---------------------------------------------------------------------------------

route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const title = str(body.title);
  if (title === '') return err(ctx.res, 422, 'title is required');
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? str((entry as Record<string, unknown>).name) : '';
      if (name === '') continue;
      const label = repo.labels.get(name);
      if (label === undefined) return err(ctx.res, 422, `Label ${name} does not exist`);
      labels.push(label);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = ctx.store.nowIso();
  const issue: Issue = {
    number,
    globalId: issueGlobalId(repo.owner, repo.name, number),
    title,
    body: str(body.body),
    state: 'open',
    labels,
    comments: [],
    seq: ctx.store.issueSeq++,
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  jsonReply(ctx.res, 201, issueJson(repo, issue, ctx.host));
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  const { page, perPage } = parsePage(ctx.query);
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const total = list.length;
  const slice = list.slice((page - 1) * perPage, page * perPage);
  const extra: Record<string, string> = {};
  const link = linkHeader(ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.query, page, perPage, total);
  if (link !== null) extra.link = link;
  jsonReply(ctx.res, 200, slice.map((issue) => issueJson(repo, issue, ctx.host)), extra);
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const issue = repo.issues.get(Number(p.number));
  if (issue === undefined) return err(ctx.res, 404, 'Not Found');
  jsonReply(ctx.res, 200, issueJson(repo, issue, ctx.host));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const issue = repo.issues.get(Number(p.number));
  if (issue === undefined) return err(ctx.res, 404, 'Not Found');
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.updatedAt = ctx.store.nowIso();
  jsonReply(ctx.res, 200, issueJson(repo, issue, ctx.host));
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const issue = repo.issues.get(Number(p.number));
  if (issue === undefined) return err(ctx.res, 404, 'Not Found');
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const commentBody = str(body.body);
  if (commentBody === '') return err(ctx.res, 422, 'body is required');
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment = { id, globalId: commentGlobalId(repo.owner, repo.name, issue.number, id), body: commentBody, createdAt: ctx.store.nowIso() };
  issue.comments.push(comment);
  jsonReply(ctx.res, 201, {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  });
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const issue = repo.issues.get(Number(p.number));
  if (issue === undefined) return err(ctx.res, 404, 'Not Found');
  jsonReply(
    ctx.res,
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      node_id: comment.globalId,
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    })),
  );
});

// -- Pull requests --------------------------------------------------------------------------

function findPull(repo: Repo, number: number): PullRequest | undefined {
  return repo.pulls.get(number);
}

route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const body = bodyObj(ctx);
  if (body === null) return err(ctx.res, 400, 'Invalid request body');
  const head = str(body.head);
  const base = str(body.base);
  const title = str(body.title);
  if (head === '' || base === '' || title === '') return err(ctx.res, 422, 'head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return err(ctx.res, 422, 'head or base branch does not exist');
  for (const existing of repo.pulls.values()) {
    if (existing.head === head && existing.base === base && existing.state === 'open') {
      return err(ctx.res, 422, 'A pull request already exists for this head and base');
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = ctx.store.nowIso();
  const pr: PullRequest = {
    number,
    globalId: pullGlobalId(repo.owner, repo.name, number),
    title,
    body: str(body.body),
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: ctx.store.issueSeq++,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(number, pr);
  jsonReply(ctx.res, 201, pullJson(repo, pr, ctx.host));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const { page, perPage } = parsePage(ctx.query);
  let list = [...repo.pulls.values()];
  if (state !== 'all') list = list.filter((pr) => pr.state === state);
  list.sort((a, b) => b.seq - a.seq);
  const total = list.length;
  const slice = list.slice((page - 1) * perPage, page * perPage);
  const extra: Record<string, string> = {};
  const link = linkHeader(ctx.host, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.query, page, perPage, total);
  if (link !== null) extra.link = link;
  jsonReply(ctx.res, 200, slice.map((pr) => pullJson(repo, pr, ctx.host)), extra);
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const pr = findPull(repo, Number(p.number));
  if (pr === undefined) return err(ctx.res, 404, 'Not Found');
  jsonReply(ctx.res, 200, pullJson(repo, pr, ctx.host));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const pr = findPull(repo, Number(p.number));
  if (pr === undefined) return err(ctx.res, 404, 'Not Found');
  jsonReply(ctx.res, 200, prFiles(ctx.store, repo, pr));
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, p) => {
  const repo = mustRepo(ctx, decodeParam(p.owner), decodeParam(p.repo));
  if (repo === null) return;
  const pr = findPull(repo, Number(p.number));
  if (pr === undefined) return err(ctx.res, 404, 'Not Found');
  if (pr.state === 'closed') return err(ctx.res, 405, 'Pull request is already closed');
  const merged = squashMerge(ctx.store, repo, pr);
  if (merged.conflict) return err(ctx.res, 405, 'Merge conflict');
  if (merged.sha === undefined) return err(ctx.res, 422, 'Cannot merge: missing branch tip');
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = ctx.store.nowIso();
  pr.mergeCommitSha = merged.sha;
  pr.baseSha = merged.sha;
  pr.updatedAt = ctx.store.nowIso();
  jsonReply(ctx.res, 200, { merged: true, sha: merged.sha, message: `Merge pull request #${pr.number} from ${pr.head}` });
});

/** Dispatch a REST request. Returns true when a route handled it. */
export function handleRest(ctx: RestContext, method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(normalized);
    if (match === null) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, index) => {
      params[key] = match[index + 1] ?? '';
    });
    r.handler(ctx, params);
    return true;
  }
  return false;
}

// Re-exported so the GraphQL module can share the same global-id decoding.
export { decodeGlobalId };
