// store.ts — the forge's in-memory store plus the git object codecs it needs.
//
// Everything here is deterministic: no wall clock, no unseeded randomness.
// Server-created commits carry the fixed conformance identity and timestamp so a
// replay produces byte-identical objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const AGENT = 'github-forge/1.0';
export const COMMIT_TIMESTAMP = 1700000000;
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';
export const FIXED_NOW_ISO: string = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return '2025-01-01T00:00:00Z';
})();

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(data)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees / commits / tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
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
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
}): Buffer {
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${COMMIT_TIMESTAMP} +0000`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${COMMIT_TIMESTAMP} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Every object reachable from `roots` (commit → tree + parents, tag → target, tree → entries). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  opts: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (opts.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `descendant` through parent links (or equal)? */
export function isAncestor(
  lookup: (oid: string) => GitObject | undefined,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The closest common ancestor of two commits (exact for the linear histories this forge sees). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const bAncestors = new Set<string>();
  const bQueue = [b];
  while (bQueue.length) {
    const oid = bQueue.pop()!;
    if (bAncestors.has(oid)) continue;
    bAncestors.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) bQueue.push(parent);
  }
  // BFS from a by generation so the first common ancestor found is the closest to a.
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = zlibInflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta expects a different base size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Uint8Array, opts: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (buffer.subarray(trailerStart).toString('hex') !== computed) throw new Error('pack trailer does not match its bytes');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  let deltaCount = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const entry of raw) {
      if (resolved.has(entry.offset)) continue;
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: { type: GitObjectType; data: Buffer } | undefined;
        if (entry.typeCode === 6) base = resolved.get(entry.baseOffset!);
        else {
          const baseObj = opts.resolveBase?.(entry.baseOid!);
          if (baseObj) base = baseObj;
          else {
            for (const r of resolved.values()) if (r.oid === entry.baseOid) { base = r; break; }
          }
        }
        if (!base) continue;
        const data = applyDelta(base.data, entry.data);
        const oid = hashObject(base.type, data);
        resolved.set(entry.offset, { type: base.type, data, oid });
        objects.set(oid, { type: base.type, data });
        deltaCount += 1;
        progress = true;
      } else {
        const type = CODE_TYPE[entry.typeCode];
        const oid = hashObject(type, entry.data);
        resolved.set(entry.offset, { type, data: entry.data, oid });
        objects.set(oid, { type, data: entry.data });
        progress = true;
      }
    }
  }
  if (resolved.size !== raw.length) throw new Error('pack has an unresolvable delta');
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines and sideband
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines (flush = 0000, delim = 0001, data otherwise). */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (head === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520) throw new Error(`bad pkt-line length ${head}`);
    if (offset + length > buffer.length) throw new Error('pkt-line is truncated');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Chunk a pack into sideband band-1 pkt-lines (max 65515 payload bytes each). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the domain store
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  commitSeq: Map<string, number>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  seq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      commitSeq: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.seq++,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Record a commit object's creation order (first sighting wins). */
  noteCommit(repo: Repo, oid: string): void {
    if (!repo.commitSeq.has(oid)) repo.commitSeq.set(oid, this.seq++);
  }
}

export const store = new Store();

/** Global ids are base64 of a type tag + the local ids: opaque, stable, never the plain number. */
export function globalId(tag: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${tag}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { tag: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { tag: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', repo.id, pr.number);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('Comment', repo.id, issue.number, comment.id);
}

export function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// tree operations
// ---------------------------------------------------------------------------------------------

/** Set (or delete, when blobOid is null) one path in a tree; returns the new root tree oid. */
export function setPathInTree(repo: Repo, treeOid: string | null, parts: readonly string[], blobOid: string | null): string {
  const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
  const name = parts[0];
  if (parts.length === 1) {
    const idx = entries.findIndex((e) => e.name === name);
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) entries[idx] = { mode: '100644', name, oid: blobOid };
    else entries.push({ mode: '100644', name, oid: blobOid });
  } else {
    const idx = entries.findIndex((e) => e.name === name);
    const subTreeOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const newSub = setPathInTree(repo, subTreeOid, parts.slice(1), blobOid);
    const subEntries = parseTree(repo.objects.get(newSub)?.data ?? Buffer.alloc(0));
    if (subEntries.length === 0) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) entries[idx] = { mode: '40000', name, oid: newSub };
    else entries.push({ mode: '40000', name, oid: newSub });
  }
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** The blob oid at a path in a tree, or null. */
export function blobAtPath(repo: Repo, treeOid: string | null, parts: readonly string[]): string | null {
  if (!treeOid) return null;
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry.mode === '100644' || entry.mode === '100755' ? entry.oid : null;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The entries of the tree at a path (null when the path is not a directory). */
export function treeAtPath(repo: Repo, treeOid: string | null, parts: readonly string[]): TreeEntry[] | null {
  if (!treeOid) return [];
  let current = treeOid;
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === part);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Flat path → blob oid map for a whole tree. */
export function flatTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!treeOid) return out;
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, o] of flatTree(repo, entry.oid, path)) out.set(p, o);
    } else if (entry.mode !== '160000') {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** Create a commit on a branch (parent = current tip, or none for an unborn branch). */
export function commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const data = buildCommit({ tree: treeOid, parents: parent ? [parent] : [], message });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(ref, oid);
  store.noteCommit(repo, oid);
  return oid;
}

/** Commits reachable from a ref, newest first (by creation order). */
export function commitsFrom(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const queue = [tip];
  const out: string[] = [];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  out.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// three-way merge and diff
// ---------------------------------------------------------------------------------------------

export interface MergeOutcome {
  conflict: boolean;
  treeOid: string | null;
}

/** Merge `theirs` into `ours` over `base`; a file both sides changed differently conflicts. */
export function threeWayMerge(
  repo: Repo,
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): MergeOutcome {
  const base = flatTree(repo, baseTree);
  const ours = flatTree(repo, oursTree);
  const theirs = flatTree(repo, theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, string>();
  for (const path of paths) {
    const b = base.get(path) ?? null;
    const o = ours.get(path) ?? null;
    const t = theirs.get(path) ?? null;
    if (o === t) { if (o !== null) result.set(path, o); continue; }
    if (b === o) { if (t !== null) result.set(path, t); continue; }
    if (b === t) { if (o !== null) result.set(path, o); continue; }
    return { conflict: true, treeOid: null };
  }
  let treeOid: string | null = null;
  for (const [path, oid] of result) {
    treeOid = setPathInTree(repo, treeOid, path.split('/'), oid);
  }
  if (treeOid === null) {
    const data = buildTree([]);
    treeOid = hashObject('tree', data);
    if (!repo.objects.has(treeOid)) repo.objects.set(treeOid, { type: 'tree', data });
  }
  return { conflict: false, treeOid };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(blob: Buffer): number {
  const text = blob.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** LCS length of two line lists (files here are small). */
function lcsLength(a: string[], b: string[]): number {
  const rows = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = rows[j];
      rows[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(rows[j], rows[j - 1]);
      prev = tmp;
    }
  }
  return rows[b.length];
}

export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileDiff[] {
  const base = flatTree(repo, baseTree);
  const head = flatTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const lines = lineCount(repo.objects.get(h!)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions: Math.max(lines, 1), deletions: 0, changes: Math.max(lines, 1) });
    } else if (h === undefined) {
      const lines = lineCount(repo.objects.get(b)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(lines, 1), changes: Math.max(lines, 1) });
    } else {
      const oldText = (repo.objects.get(b)?.data ?? Buffer.alloc(0)).toString('utf8');
      const newText = (repo.objects.get(h)?.data ?? Buffer.alloc(0)).toString('utf8');
      const oldLines = oldText === '' ? [] : oldText.split('\n');
      const newLines = newText === '' ? [] : newText.split('\n');
      if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
      if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
      const common = lcsLength(oldLines, newLines);
      const additions = newLines.length - common;
      const deletions = oldLines.length - common;
      // A blob difference with no line-count delta (e.g. only a trailing newline) still counts.
      const add = additions === 0 && deletions === 0 ? 1 : additions;
      out.push({ filename: path, status: 'modified', additions: add, deletions, changes: add + deletions });
    }
  }
  return out;
}

/** Would merging `headTip` into `baseTip` conflict? (merge-base → head vs merge-base → base.) */
export function mergeWouldConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase((oid) => repo.objects.get(oid), baseTip, headTip);
  const baseCommit = base ? repo.objects.get(base) : undefined;
  const baseTree = baseCommit && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTipTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  return threeWayMerge(repo, baseTree, baseTipTree, headTipTree).conflict;
}

// ---------------------------------------------------------------------------------------------
// domain operations shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------------------------

export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

export function createIssueInRepo(
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): DomainResult<Issue> {
  if (!title.trim()) return { ok: false, error: 'title is required', status: 422 };
  for (const labelName of labelNames) {
    if (!repo.labels.has(labelName)) {
      return { ok: false, error: `label "${labelName}" does not exist`, status: 422 };
    }
  }
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: labelNames.map((n) => repo.labels.get(n)!),
    comments: [],
    seq: store.seq++,
  };
  repo.issues.push(issue);
  return { ok: true, value: issue };
}

export function createPullInRepo(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): DomainResult<PullRequest> {
  if (!title.trim()) return { ok: false, error: 'title is required', status: 422 };
  if (!head || !base) return { ok: false, error: 'head and base are required', status: 422 };
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return { ok: false, error: `head branch "${head}" does not exist`, status: 422 };
  if (!baseSha) return { ok: false, error: `base branch "${base}" does not exist`, status: 422 };
  const existing = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
  if (existing) {
    return { ok: false, error: `an open pull request already exists for head "${head}"`, status: 422 };
  }
  const pr: PullRequest = {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: store.seq++,
  };
  repo.pulls.push(pr);
  return { ok: true, value: pr };
}

/** Squash-merge an open PR onto its base branch. */
export function mergePullInRepo(
  repo: Repo,
  pr: PullRequest,
): DomainResult<{ sha: string; message: string }> {
  if (pr.merged || pr.state !== 'open') {
    return { ok: false, error: 'pull request is already closed', status: 405 };
  }
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return { ok: false, error: 'branch not found', status: 404 };
  if (mergeWouldConflict(repo, baseTip, headTip)) {
    return { ok: false, error: 'pull request cannot be merged: conflicting files', status: 405 };
  }
  const base = mergeBase((oid) => repo.objects.get(oid), baseTip, headTip);
  const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
  const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTipTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const merged = threeWayMerge(repo, baseTree, baseTipTree, headTipTree);
  if (merged.conflict || merged.treeOid === null) {
    return { ok: false, error: 'pull request cannot be merged: conflicting files', status: 405 };
  }
  const message = pr.title;
  const commitSha = commitOnBranch(repo, pr.baseRef, message, merged.treeOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = FIXED_NOW_ISO;
  pr.merge_commit_sha = commitSha;
  return { ok: true, value: { sha: commitSha, message } };
}
