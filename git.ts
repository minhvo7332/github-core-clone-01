// git smart HTTP: info/refs, git-upload-pack (v2 and v0) and git-receive-pack (v0).
//
// The wire shapes here follow the suite's own git client exactly:
//   - v2 advertisement: `version 2` + capability lines, no service preamble.
//   - v0 advertisement: `# service=...` + flush + ref lines; the first line
//     carries capabilities after a NUL; an empty repo advertises one
//     `0000...0 capabilities^{}` line; peeled tags follow their tag line.
//   - v2 fetch answers LABELED sections (acknowledgments, shallow-info,
//     wanted-refs, packfile), each closed by a delim packet; empty sections
//     are omitted, and the packfile section always carries a pack (a valid
//     0-object pack when nothing is new).
//   - v0 fetch answers plain NAK/ACK/shallow lines, then the sideband pack.
//   - receive-pack is v0 only; its report-status is the pkt-line stream
//     (`unpack ok`, `ok <ref>` / `ng <ref> <reason>`) inside sideband band 1,
//     and a non-fast-forward update is refused with exactly `non-fast-forward`.
//   - Packs carry plain objects only, no deltas; the trailer is SHA-1.

import type { TransportRequest, TransportResponse } from './transport.ts';
import { AGENT, PKT_DELIM, PKT_FLUSH, ZERO_OID, isSha1, pktLine, pktTextLines, readPktLines } from './util.ts';
import { parseCommit, parseTag, parseTree, type Repo, type Store } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V2_CAPS: Array<[string, string]> = [
  ['agent', AGENT],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow filter'],
  ['object-format', 'sha1'],
];

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export function sendBuffer(res: TransportResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Frame pack bytes as sideband-64k pkt-lines (band 1), then a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function peelOf(store: Store, oid: string): string | undefined {
  let current = store.getObject(oid);
  let guard = 0;
  while (current?.type === 'tag' && guard < 10) {
    const target = parseTag(current.data).object;
    if (!isSha1(target)) return undefined;
    const targetObj = store.getObject(target);
    if (targetObj?.type === 'commit') return target;
    if (targetObj?.type === 'tag') {
      current = targetObj;
      guard += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The v0 advertisement body for a service. */
function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      const peeled = peelOf(store, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement body (upload-pack only). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const [key, value] of V2_CAPS) parts.push(pktLine(`${key}=${value}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function isAncestor(store: Store, ancestor: string, oid: string): boolean {
  const queue = [oid];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = store.getObject(current);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/**
 * The objects a fetch must send, plus the shallow boundary.
 *
 * No depth: everything reachable from the wants that the haves do not already
 * hold (a tag want contributes the tag object and its target, as a full clone
 * of an annotated tag needs).
 *
 * With depth: commit generations from the wants (generation 1 = the tips);
 * the boundary is the commits at the deepest generation. A shallow clone's
 * haves are only the boundary commits and their trees — the client does NOT
 * hold their ancestors — so the held set is the haves' own objects, not
 * their full ancestry. That is what makes deepen 2 deliver the parent.
 */
function planFetch(store: Store, plan: FetchPlan): { objects: string[]; shallow: string[]; unshallow: string[] } {
  const isShallowFetch = plan.depth !== null || plan.shallow.length > 0;
  const held = new Set<string>();
  if (isShallowFetch) {
    for (const oid of plan.haves) {
      const obj = store.getObject(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        for (const entryOid of store.collectReachable([parseCommit(obj.data).tree])) held.add(entryOid);
      } else if (obj.type === 'tag') {
        for (const entryOid of store.collectReachable([oid])) held.add(entryOid);
      }
    }
  } else {
    for (const oid of store.collectReachable(plan.haves)) held.add(oid);
  }

  if (plan.depth === null) {
    const objects = new Set<string>();
    for (const oid of store.collectReachable(plan.wants)) {
      if (!held.has(oid)) objects.add(oid);
    }
    return { objects: [...objects], shallow: [], unshallow: [] };
  }

  const maxGen = plan.depth;
  const includedCommits = new Map<string, number>(); // oid -> generation
  const extraObjects = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = plan.wants.map((oid) => ({ oid, gen: 1 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (includedCommits.has(oid)) continue;
    const obj = store.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      extraObjects.add(oid);
      const target = parseTag(obj.data).object;
      if (isSha1(target)) queue.push({ oid: target, gen });
      continue;
    }
    if (obj.type !== 'commit') {
      for (const entryOid of store.collectReachable([oid])) extraObjects.add(entryOid);
      continue;
    }
    includedCommits.set(oid, gen);
    if (gen >= maxGen) continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  const boundary = new Set<string>();
  for (const [oid, gen] of includedCommits) if (gen === maxGen) boundary.add(oid);
  const unshallow: string[] = [];
  for (const oid of plan.shallow) {
    const gen = includedCommits.get(oid);
    if (gen !== undefined && !boundary.has(oid)) unshallow.push(oid);
  }
  const objects = new Set<string>(extraObjects);
  for (const [oid] of includedCommits) {
    if (held.has(oid)) continue;
    objects.add(oid);
    const commit = store.getObject(oid);
    if (commit?.type !== 'commit') continue;
    const tree = parseCommit(commit.data).tree;
    for (const entryOid of store.collectReachable([tree])) {
      if (!held.has(entryOid)) objects.add(entryOid);
    }
  }
  for (const oid of extraObjects) {
    if (held.has(oid)) objects.delete(oid);
  }
  return { objects: [...objects], shallow: [...boundary], unshallow };
}

function parseFetchArgs(lines: string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed === '' || trimmed === 'done' || trimmed === 'command=fetch' || trimmed === 'command=ls-refs') continue;
    if (trimmed.startsWith('want ')) plan.wants.push(trimmed.split(' ')[1]);
    else if (trimmed.startsWith('have ')) plan.haves.push(trimmed.split(' ')[1]);
    else if (trimmed.startsWith('shallow ')) plan.shallow.push(trimmed.slice(8));
    else if (trimmed.startsWith('deepen ')) plan.depth = Number(trimmed.slice(7));
    else if (trimmed.startsWith('deepen-since ')) plan.deepenSince = Number(trimmed.slice(13));
    else if (trimmed.startsWith('deepen-not ')) plan.deepenNot.push(trimmed.slice(11));
  }
  return plan;
}

/** Build the v2 fetch response: labeled sections, delim-separated, packfile last. */
function v2FetchResponse(store: Store, repo: Repo, plan: FetchPlan): Buffer {
  const { objects, shallow, unshallow } = planFetch(store, plan);
  const pack = objects.length === 0 ? store.buildEmptyPack() : store.buildPack(objects);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const heldHaves = plan.haves.filter((oid) => store.getObject(oid) !== undefined);
  if (plan.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of heldHaves) parts.push(pktLine(`ACK ${oid}\n`));
    if (heldHaves.length === plan.haves.length) parts.push(pktLine('ready\n'));
    else parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  // shallow-info
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // wanted-refs
  const wanted = sortedRefs(repo).filter((ref) => plan.wants.includes(ref.oid));
  if (wanted.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of wanted) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

/** Build the v0 fetch response: NAK/ACK + shallow lines, then the sideband pack. */
function v0FetchResponse(store: Store, repo: Repo, plan: FetchPlan): Buffer {
  const { objects, shallow, unshallow } = planFetch(store, plan);
  const pack = objects.length === 0 ? store.buildEmptyPack() : store.buildPack(objects);
  const parts: Buffer[] = [];
  const heldHaves = plan.haves.filter((oid) => store.getObject(oid) !== undefined);
  if (plan.haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of heldHaves) parts.push(pktLine(`ACK ${oid}\n`));
    if (heldHaves.length !== plan.haves.length) parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

/** Handle GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, req: TransportRequest, res: TransportResponse, service: string | null): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers.get('git-protocol') ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) sendBuffer(res, 200, v2Advertisement(), UPLOAD_AD);
    else sendBuffer(res, 200, v0Advertisement(store, repo, 'git-upload-pack'), UPLOAD_AD);
  } else if (service === 'git-receive-pack') {
    sendBuffer(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), RECEIVE_AD);
  } else {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'unknown service' }));
  }
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (v2 ls-refs/fetch, or v0 fetch). */
export function handleUploadPack(store: Store, owner: string, repoName: string, req: TransportRequest, res: TransportResponse, body: Buffer): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  const isV2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
  const lines = pktTextLines(body);
  if (isV2) {
    const command = lines.find((line) => line.startsWith('command='))?.slice(8).trim() ?? '';
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      let unborn = false;
      for (const line of lines) {
        const t = line.replace(/\n$/, '');
        if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11));
        else if (t === 'peel') peel = true;
        else if (t === 'symrefs') symrefs = true;
        else if (t === 'unborn') unborn = true;
      }
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const parts: Buffer[] = [];
      const refs = sortedRefs(repo);
      const mainTip = repo.refs.get('refs/heads/main');
      if (refs.length === 0) {
        if (unborn && keep('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
      } else {
        if (mainTip !== undefined && keep('HEAD')) {
          parts.push(pktLine(symrefs ? `${mainTip} HEAD symref-target:refs/heads/main\n` : `${mainTip} HEAD\n`));
        }
        for (const ref of refs) {
          if (!keep(ref.name)) continue;
          let line = `${ref.oid} ${ref.name}`;
          if (peel) {
            const peeled = peelOf(store, ref.oid);
            if (peeled !== undefined) line += ` peeled:${peeled}`;
          }
          parts.push(pktLine(`${line}\n`));
        }
      }
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
      return;
    }
    if (command === 'fetch') {
      const plan = parseFetchArgs(lines);
      sendBuffer(res, 200, v2FetchResponse(store, repo, plan), UPLOAD_RESULT);
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'unknown command' }));
    return;
  }
  // v0 fetch
  const plan = parseFetchArgs(lines);
  sendBuffer(res, 200, v0FetchResponse(store, repo, plan), UPLOAD_RESULT);
}

/** Handle POST /{owner}/{repo}.git/git-receive-pack (v0 only). */
export function handleReceivePack(store: Store, owner: string, repoName: string, req: TransportRequest, res: TransportResponse, body: Buffer): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  // Split the command list (pkt-lines up to the first flush) from the pack bytes.
  const packets = readPktLines(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string; caps: string[] }> = [];
  let packStart = body.length;
  let pos = 0;
  for (const packet of packets) {
    if (packet === null) {
      packStart = pos + 4;
      break;
    }
    if (packet === 'delim') {
      pos += 4;
      continue;
    }
    const text = packet.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const caps = nul < 0 ? [] : text.slice(nul + 1).trim().split(' ').filter(Boolean);
    const parts = head.trim().split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps });
    pos += 4 + packet.length;
  }
  const useSideband = commands.length > 0 && commands[0].caps.includes('side-band-64k');
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const entries = store.readPack(packBytes);
      for (const entry of entries) store.putObject(entry.type, entry.data, entry.oid);
      // A ref update invalidates the cached depth-1 pack for its old tip.
      store.depth1PackCache.clear();
      store.packCache.clear();
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        } else if (store.getObject(cmd.newOid) === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (cmd.newOid === cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      } else if (!isAncestor(store, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (store.getObject(cmd.newOid) === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  }
  const innerParts: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    innerParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  innerParts.push(PKT_FLUSH);
  const inner = Buffer.concat(innerParts);
  const out = useSideband ? sidebandPack(inner) : Buffer.concat([inner]);
  sendBuffer(res, 200, out, RECEIVE_RESULT);
}
