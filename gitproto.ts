// gitproto.ts — the git smart-HTTP surface: advertisements, protocol v2 ls-refs/fetch,
// protocol v0 fetch, and receive-pack. No git binary anywhere; packs are built and read
// directly from the store's objects.

import {
  AGENT,
  ZERO_OID,
  decodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandPack,
  store,
  writePack,
  type GitObject,
  type Repo,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitResponse {
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

/** Refs in a stable order: HEAD first, then heads, then tags, each sorted. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const main = repo.refs.get('refs/heads/main');
  if (main) out.push({ name: 'HEAD', oid: main });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

function v0Capabilities(service: 'upload' | 'receive'): string {
  const base = service === 'upload'
    ? 'side-band-64k shallow thin-pack ofs-delta'
    : 'report-status side-band-64k delete-refs ofs-delta';
  return `${base} agent=${AGENT} symref=HEAD:refs/heads/main`;
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const parts: Buffer[] = [];
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  parts.push(pktLine(`# service=${serviceName}\n`));
  parts.push(pktFlush());
  const caps = v0Capabilities(service);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      // Peeled line for an annotated tag, right after its own line.
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object && object.type === 'tag') {
          const target = parseTag(object.data).object;
          if (isObjectId(target)) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
        }
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

export function infoRefs(repo: Repo, service: 'upload' | 'receive', gitProtocol: string): GitResponse {
  if (service === 'upload' && gitProtocol === 'version=2') {
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: v2Advertisement(),
    };
  }
  return {
    status: 200,
    contentType: `application/x-git-${service === 'upload' ? 'upload' : 'receive'}-pack-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// protocol v2 ls-refs
// ---------------------------------------------------------------------------------------------

export function lsRefs(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const lines: string[] = [];
  let sawCommand = false;
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') { sawDelim = true; continue; }
    const line = packet.payload.toString('utf8');
    if (!sawCommand) {
      if (line !== 'command=ls-refs\n') return jsonError(400, 'expected command=ls-refs');
      sawCommand = true;
      continue;
    }
    if (!sawDelim) continue; // agent= / object-format= lines before the delim
    lines.push(line);
  }
  if (!sawCommand) return jsonError(400, 'expected command=ls-refs');

  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }

  const out: Buffer[] = [];
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const main = repo.refs.get('refs/heads/main');
  if (repo.refs.size === 0) {
    if (unborn && keep('HEAD')) {
      out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (keep('HEAD') && main) {
      out.push(pktLine(`${main} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (peel && name.startsWith('refs/tags/')) {
        const object = repo.objects.get(oid);
        if (object && object.type === 'tag') {
          const target = parseTag(object.data).object;
          if (isObjectId(target)) line += ` peeled:${target}`;
        }
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(pktFlush());
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(out),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2FetchRequest(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let sawCommand = false;
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') { sawDelim = true; continue; }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawCommand) {
      if (line !== 'command=fetch') return null;
      sawCommand = true;
      continue;
    }
    if (!sawDelim) continue; // agent= / object-format= lines before the delim
    if (line.startsWith('want ')) req.wants.push(line.slice(5));
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  return sawCommand ? req : null;
}

function parseV0FetchRequest(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  return req.wants.length ? req : null;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** New shallow boundaries. */
  shallow: string[];
  /** Old shallow boundaries that are now fully included. */
  unshallow: string[];
  /** Whether every have the client named is in this store. */
  havesKnown: boolean;
}

function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const havesKnown = req.haves.every((oid) => lookup(oid) !== undefined);
  // Commit generations from the wants (shortest distance; linear histories make this exact).
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of req.wants) {
    const object = lookup(want);
    if (object && object.type === 'commit') queue.push({ oid: want, gen: 0 });
    else if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isObjectId(target)) queue.push({ oid: target, gen: 0 });
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    const prev = generation.get(oid);
    if (prev !== undefined && prev <= gen) continue;
    generation.set(oid, gen);
    if (req.depth !== null && gen >= req.depth) continue;
    includedCommits.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (req.depth !== null) {
    for (const [oid, gen] of generation) {
      if (gen === req.depth - 1 && includedCommits.has(oid)) shallow.push(oid);
    }
    for (const old of req.shallow) {
      const gen = generation.get(old);
      if (gen !== undefined && gen < req.depth - 1) unshallow.push(old);
    }
  } else {
    for (const old of req.shallow) {
      if (generation.has(old)) unshallow.push(old);
    }
  }
  shallow = [...new Set(shallow)].sort();
  unshallow = [...new Set(unshallow)].sort();

  // Objects reachable from the included commits, minus what the client already holds.
  // The traversal follows a commit's parents only while they are themselves included, so a
  // shallow fetch never leaks generations past its depth.
  const seeds = new Set<string>();
  for (const want of req.wants) if (lookup(want)) seeds.add(want);
  for (const oid of includedCommits) seeds.add(oid);
  const wanted = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const oid = stack.pop()!;
    if (wanted.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    wanted.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (includedCommits.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
  // Objects the client already holds: reachable from its haves, but the traversal stops at its
  // shallow boundaries — a shallow client does not hold a boundary's parents.
  const shallowSet = new Set(req.shallow);
  const held = new Set<string>();
  const heldStack = [...req.haves];
  while (heldStack.length) {
    const oid = heldStack.pop()!;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      heldStack.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) heldStack.push(parent);
      }
    } else if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        heldStack.push(entry.oid);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow, havesKnown };
}

function fetchV2(repo: Repo, body: Buffer): GitResponse {
  const req = parseV2FetchRequest(body);
  if (!req) return jsonError(400, 'malformed fetch request');
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  // Protocol v2 sends the acknowledgments section only when the client named haves; a
  // fresh clone (no haves) goes straight to shallow-info / packfile, and real git rejects
  // an acknowledgments section it did not ask for.
  if (req.haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.havesKnown) {
      parts.push(pktLine(`ACK ${req.haves[req.haves.length - 1]}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

function fetchV0(repo: Repo, body: Buffer): GitResponse {
  const req = parseV0FetchRequest(body);
  if (!req) return jsonError(400, 'malformed fetch request');
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  if (req.haves.length && plan.havesKnown) {
    parts.push(pktLine(`ACK ${req.haves[req.haves.length - 1]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length) {
    parts.push(...sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

export function uploadPack(repo: Repo, body: Buffer, gitProtocol: string): GitResponse {
  if (gitProtocol === 'version=2') {
    // v2: the first data line names the command.
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      return jsonError(400, 'malformed pkt-line stream');
    }
    const first = packets.find((p) => p.kind === 'data');
    if (!first) return jsonError(400, 'empty upload-pack request');
    const command = first.payload.toString('utf8').replace(/\n$/, '');
    if (command === 'command=ls-refs') return lsRefs(repo, body);
    if (command === 'command=fetch') return fetchV2(repo, body);
    return jsonError(400, `unknown command ${command}`);
  }
  return fetchV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): GitResponse {
  // Split the command list (pkt-lines up to the first flush) from the pack that follows it.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let sawFlush = false;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        sawFlush = true;
        packStart = offset + 4;
        break;
      }
      if (head === '0001') { offset += 4; continue; }
      const length = parseInt(head, 16);
      if (!Number.isFinite(length) || length < 4 || length > 65520) throw new Error('bad pkt-line length');
      if (offset + length > body.length) throw new Error('pkt-line is truncated');
      const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\u0000');
      const refPart = nul < 0 ? line : line.slice(0, nul);
      const [oldOid, newOid, ref] = refPart.split(' ');
      if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref || !ref.startsWith('refs/')) {
        throw new Error('bad push command');
      }
      commands.push({ oldOid, newOid, ref });
      offset += length;
    }
  } catch {
    return jsonError(400, 'malformed receive-pack request');
  }
  if (!sawFlush || commands.length === 0) return jsonError(400, 'malformed receive-pack request');

  // Store the pack's objects (a pack is always present for creates/updates, even an empty one).
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        if (object.type === 'commit') store.noteCommit(repo, oid);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError) {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = repo.objects.get(command.newOid);
      if (!target || target.type !== 'commit') {
        // Tags may point at a tag object; anything else must be a commit the server now holds.
        if (!target || (command.ref.startsWith('refs/tags/') && target.type !== 'tag')) {
          results.push({ ref: command.ref, ok: false, reason: 'missing object' });
          continue;
        }
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        if (target.type === 'commit') store.noteCommit(repo, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined || current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
        continue;
      }
      // Fast-forward: the new tip must descend from the old tip.
      if (!isAncestor((oid) => repo.objects.get(oid), command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      if (target.type === 'commit') store.noteCommit(repo, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  // report-status, pkt-lined inside sideband band 1.
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(pktFlush());
  const innerBytes = Buffer.concat(inner);
  const outer: Buffer[] = [];
  let off = 0;
  while (off < innerBytes.length) {
    const chunk = innerBytes.subarray(off, Math.min(innerBytes.length, off + 65515));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  outer.push(pktFlush());
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(outer),
  };
}

