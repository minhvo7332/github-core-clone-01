// The forge's whole state: one in-memory store for git objects, repositories,
// issues, pull requests, comments and labels. Everything the four surfaces
// serve reads and writes this one object, so a change made over any surface
// (a git push, a REST contents PUT, a GraphQL mutation, an MCP tool call) is
// visible on all the others immediately.
//
// Design notes:
//   - Git objects are stored as raw bytes keyed by their SHA-1, exactly as
//     pushed; a clone re-sends the same bytes, so client-built commits
//     round-trip byte-exactly.
//   - Commits this server builds (contents PUTs, squash merges) use a fixed
//     identity and a counter timestamp, so their bytes are deterministic.
//   - The viewer is one fixed login (adaiversen, id 1000): the trial token is
//     opaque and encodes no login, and repositories are keyed by owner+name,
//     so a lookup under any other owner is a 404.

import { inflateSync } from 'node:zlib';
import { b64urlDecode, b64urlEncode, encodeVarint, isSha1, objectId, sha1Hex, zlibDeflateData } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  owner: string;
  name: string;
  dbId: number;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
const COMMIT_EPOCH = 1700000000;
const COMMIT_IDENTITY = 'adaiversen <adaiversen@users.noreply.github.com>';

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64urlEncode(`${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return `I_${b64urlEncode(`${owner}/${name}#${number}`)}`;
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return `PR_${b64urlEncode(`${owner}/${name}#${number}`)}`;
}

export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return `C_${b64urlEncode(`${owner}/${name}#${number}:${commentId}`)}`;
}

export function userGlobalId(login: string): string {
  return `U_${b64urlEncode(login)}`;
}

/** Decode a global id back to its parts, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number; commentId: number } | null {
  const prefix = id.slice(0, id.indexOf('_'));
  const rest = b64urlDecode(id.slice(id.indexOf('_') + 1));
  if (rest === null) return null;
  if (prefix === 'R') {
    const [owner, name] = rest.split('/');
    if (owner === undefined || name === undefined) return null;
    return { kind: 'R', owner, name, number: 0, commentId: 0 };
  }
  if (prefix === 'I' || prefix === 'PR') {
    const hash = rest.indexOf('#');
    if (hash < 0) return null;
    const [owner, name] = rest.slice(0, hash).split('/');
    const number = Number(rest.slice(hash + 1));
    if (owner === undefined || name === undefined || !Number.isInteger(number)) return null;
    return { kind: prefix, owner, name, number, commentId: 0 };
  }
  if (prefix === 'C') {
    const hash = rest.indexOf('#');
    const colon = rest.indexOf(':');
    if (hash < 0 || colon < 0) return null;
    const [owner, name] = rest.slice(0, hash).split('/');
    const number = Number(rest.slice(hash + 1, colon));
    const commentId = Number(rest.slice(colon + 1));
    if (owner === undefined || name === undefined || !Number.isInteger(number) || !Number.isInteger(commentId)) return null;
    return { kind: 'C', owner, name, number, commentId };
  }
  return null;
}

/** git's tree-entry sort: byte order of the name, a directory as if it ended in '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** A line diff by longest common subsequence: additions/deletions of whole lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS lengths, one row at a time (files here are small).
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  commitSeq = 0;
  issueSeq = 0;
  /** Depth-1 pack per tip oid: the clone workload asks for the same tip 50 times. */
  depth1PackCache = new Map<string, Buffer>();

  nowIso(): string {
    return new Date().toISOString();
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      owner,
      name,
      dbId: this.nextRepoId,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  /** Build a commit object for a server-made commit. The message is stored verbatim. */
  buildCommit(tree: string, parents: readonly string[], message: string): { oid: string; data: Buffer } {
    const ts = COMMIT_EPOCH + this.commitSeq;
    this.commitSeq += 1;
    const who = `${COMMIT_IDENTITY} ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    return { oid: this.putObject('commit', data), data };
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = this.getObject(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build the tree for a flat path map, creating intermediate trees bottom-up. */
  buildTreeFromPaths(paths: Map<string, { oid: string; mode: string }>): string {
    // Group by directory, deepest first.
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const root = new Map<string, { oid: string; mode: string }>();
    dirs.set('', root);
    for (const [path, entry] of paths) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(name, entry);
    }
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const dirNames = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
    const treeOids = new Map<string, string>();
    for (const dir of dirNames) {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of dirs.get(dir)!) entries.push({ mode: entry.mode, name, oid: entry.oid });
      // Attach child trees whose parent is this dir.
      for (const [childDir, childOid] of treeOids) {
        const slash = childDir.lastIndexOf('/');
        const parent = slash < 0 ? '' : childDir.slice(0, slash);
        if (parent !== dir) continue;
        const name = slash < 0 ? childDir : childDir.slice(slash + 1);
        entries.push({ mode: '40000', name, oid: childOid });
      }
      const data = buildTree(entries);
      treeOids.set(dir, this.putObject('tree', data));
    }
    return treeOids.get('')!;
  }

  /** All objects reachable from roots: commit -> tree + parents, tag -> target, tree -> entries. */
  collectReachable(roots: Iterable<string>, maxDepth = 0): Set<string> {
    const seen = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const root of roots) if (isSha1(root)) queue.push({ oid: root, depth: 1 });
    while (queue.length > 0) {
      const { oid, depth } = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (maxDepth > 0 && depth >= maxDepth) continue;
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push({ oid: commit.tree, depth: depth + 1 });
        for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      } else if (object.type === 'tag') {
        queue.push({ oid: parseTag(object.data).object, depth: depth + 1 });
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push({ oid: entry.oid, depth: depth + 1 });
        }
      }
    }
    return seen;
  }

  /** The first common ancestor of two commits (BFS from b over a's ancestor set). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') queueB.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** Build a packfile of plain (non-delta) objects, in the given order. */
  buildPack(oids: Iterable<string>): Buffer {
    const list = [...oids];
    const parts: Buffer[] = [];
    const header = Buffer.allocUnsafe(12);
    header.write('PACK', 0, 4, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(list.length, 8);
    parts.push(header);
    for (const oid of list) {
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      parts.push(encodeVarint(TYPE_CODE[obj.type], obj.data.length));
      parts.push(zlibDeflateData(obj.data));
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
  }

  /** An empty pack: header + count 0 + SHA-1 trailer. */
  buildEmptyPack(): Buffer {
    const header = Buffer.allocUnsafe(12);
    header.write('PACK', 0, 4, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(0, 8);
    return Buffer.concat([header, Buffer.from(sha1Hex(header), 'hex')]);
  }

  /** Depth-1 pack for a tip: the tip commit, its tree and blobs (cached per tip). */
  depth1Pack(tip: string): Buffer {
    const cached = this.depth1PackCache.get(tip);
    if (cached !== undefined) return cached;
    const commit = this.objects.get(tip);
    const oids: string[] = [];
    if (commit?.type === 'commit') {
      const view = parseCommit(commit.data);
      oids.push(tip, view.tree);
      for (const entry of this.flattenTree(view.tree).values()) oids.push(entry.oid);
    }
    const pack = this.buildPack(oids);
    this.depth1PackCache.set(tip, pack);
    return pack;
  }

  /** Read a packfile the client sent. Plain entries only; a delta entry is an error. */
  readPack(pack: Buffer): Array<{ type: ObjectType; data: Buffer; oid: string }> {
    if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
      throw new Error('pack does not start with PACK');
    }
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
    const count = pack.readUInt32BE(8);
    const out: Array<{ type: ObjectType; data: Buffer; oid: string }> = [];
    let offset = 12;
    for (let i = 0; i < count; i += 1) {
      if (offset >= pack.length - 20) throw new Error('pack is truncated');
      let byte = pack[offset];
      const typeNum = (byte >> 4) & 0x07;
      let size = byte & 0x0f;
      let shift = 4;
      offset += 1;
      while (byte & 0x80) {
        if (offset >= pack.length - 20) throw new Error('pack entry size is truncated');
        byte = pack[offset];
        offset += 1;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      if (typeNum === 6 || typeNum === 7) throw new Error('delta pack entries are not accepted');
      const type = CODE_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack entry type ${typeNum}`);
      // inflateSync with {info:true} reports the consumed input length through
      // engine.bytesWritten — the same trick the suite's own client uses.
      const inflated = inflateWithLength(pack.subarray(offset, pack.length - 20));
      offset += inflated.consumed;
      const data = inflated.data;
      if (data.length !== size) throw new Error('pack entry size mismatch');
      out.push({ type, data, oid: objectId(type, data) });
    }
    return out;
  }

  /** Commit one file on a branch. Returns {commitSha, contentSha}. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const blobOid = this.putObject('blob', content);
    const paths = tip === undefined ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(parseCommit(this.objects.get(tip)!.data).tree);
    paths.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromPaths(paths);
    const parents = tip === undefined ? [] : [tip];
    const { oid } = this.buildCommit(treeOid, parents, message);
    repo.refs.set(ref, oid);
    repo.updatedAt = this.nowIso();
    return { commitSha: oid, contentSha: blobOid };
  }

  /** Delete one file on a branch. Returns the new commit sha, or null when absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const paths = this.flattenTree(parseCommit(this.objects.get(tip)!.data).tree);
    if (!paths.has(path)) return null;
    paths.delete(path);
    const treeOid = this.buildTreeFromPaths(paths);
    const { oid } = this.buildCommit(treeOid, [tip], message);
    repo.refs.set(ref, oid);
    repo.updatedAt = this.nowIso();
    return oid;
  }
}

/** Inflate one zlib stream, reporting how many input bytes it consumed. */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  // inflateSync with {info:true} returns {buffer, engine}; the engine's
  // bytesWritten is the consumed input length — the same trick the suite's
  // own client uses to walk pack entries.
  const result = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}
