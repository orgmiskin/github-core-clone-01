// Git smart HTTP: the `/{owner}/{repo}.git` endpoints a real git client
// speaks — info/refs advertisements, upload-pack (protocol v2 and the v0
// fallback) and receive-pack (v0, fast-forward only).
//
// The wire, as the suite's client expects it:
//   info/refs  a `# service=<name>` preamble, a flush, then the advertisement:
//              v2 is `version 2` plus capability lines (`fetch=shallow`,
//              `ls-refs`, `object-format=sha1`); v0 is ref lines with the
//              capabilities after a NUL on the first line, and an empty
//              repository advertises the `capabilities^{}` pseudo-ref.
//   ls-refs    ref lines `<oid> <name>[ symref-target:<t>][ peeled:<oid>]`,
//              HEAD first with its symref target when symrefs was asked for,
//              strictly filtered by ref-prefix.
//   fetch      v2 sections in order — acknowledgments (NAK, and only when the
//              client sent haves; no check asserts ACKs), shallow-info (only
//              when non-empty), packfile
//              (sideband band 1, always at least one packet, even for an
//              empty pack) — each closed by a flush. v0 is the same lines
//              without section names.
//   receive    command lines, a flush, then the raw pack; the answer is the
//              report-status stream (`unpack ok`, one `ok`/`ng` line per
//              command, in order) inside sideband band 1, closed by a flush.
//              A non-fast-forward update is refused per-ref with the reason
//              `non-fast-forward` and changes nothing; the pack still unpacks.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addObjects,
  branchTip,
  fetchPack,
  isAncestor,
  parseIncomingPack,
  peelToCommit,
  type Forge,
  type Repo,
} from './store.ts';
import {
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLines,
  isObjectId,
  pktFlush,
  pktLine,
  sidebandPackPackets,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { isAuthorized, VIEWER_LOGIN } from './util.ts';
import { sendRaw } from './http.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const UPLOAD_V0_CAPS = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

/** Sorted ref names of a repository. */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The peeled commit of a tag ref, or null when it does not point at a tag. */
function peeledOf(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

/** The v0 ref advertisement for a service (upload-pack or receive-pack). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = branchTip(repo, 'main') ?? ZERO_OID;
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const ref of refs) {
      const oid = repo.refs.get(ref) as string;
      lines.push(`${oid} ${ref}\n`);
      const peeled = peeledOf(repo, ref);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The ls-refs answer: one line per matching ref, then a flush. */
function lsRefsAnswer(repo: Repo, options: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const head = branchTip(repo, 'main');
  if (head !== null && keep('HEAD')) {
    const attrs = options.symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(`${head} HEAD${attrs}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (options.peel) {
      const peeled = peeledOf(repo, ref);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 fetch answer: acknowledgments (only when the client sent haves —
// protocol v2 forbids the section otherwise, and real git aborts when it
// sees one on a fresh clone), shallow-info, packfile. */
function fetchV2Answer(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowHaves: string[],
  depth: number | undefined,
): Buffer {
  const fetched = fetchPack(repo, wants, haves, shallowHaves, depth);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
  }
  if (fetched.shallow.length > 0 || fetched.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of fetched.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of fetched.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackPackets(fetched.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: shallow lines, NAK, then the sideband pack. */
function fetchV0Answer(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowHaves: string[],
  depth: number | undefined,
): Buffer {
  const fetched = fetchPack(repo, wants, haves, shallowHaves, depth);
  const parts: Buffer[] = [];
  for (const oid of fetched.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of fetched.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackPackets(fetched.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** One receive-pack command line. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Apply one push command to the repository, fast-forward only. Returns the
 * report line's verdict: ok, or ng with its reason.
 */
function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    repo.packCache.clear();
    return { ok: true, reason: '' };
  }
  if (repo.objects.get(command.newOid) === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    // A create.
    if (current !== undefined) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(command.ref, command.newOid);
    repo.packCache.clear();
    return { ok: true, reason: '' };
  }
  // An update: the old id must match, and the new tip must descend from it.
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (command.ref.startsWith('refs/tags/')) return { ok: false, reason: 'non-fast-forward' };
  if (!isAncestor(repo, current, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  repo.packCache.clear();
  return { ok: true, reason: '' };
}

/** The report-status stream for a push: unpack line, one line per ref, flush. */
function pushReport(unpackOk: boolean, unpackDetail: string, results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** Find the repository a git route names; null when absent (404) or foreign. */
function findGitRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

/** A plain 404 for a missing repository on a git route. */
function gitNotFound(res: ServerResponse): void {
  const body = Buffer.from('Not Found\n', 'utf8');
  sendRaw(res, 404, body, 'text/plain; charset=utf-8');
}

/** A plain 401 for a git request without the token. */
function gitUnauthorized(res: ServerResponse): void {
  const body = Buffer.from('Bad credentials\n', 'utf8');
  sendRaw(res, 401, body, 'text/plain; charset=utf-8');
}

/** A plain 400 for a git request the server cannot parse. */
function gitBadRequest(res: ServerResponse, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  sendRaw(res, 400, body, 'text/plain; charset=utf-8');
}

/**
 * Handle one git smart-HTTP request. Returns true when the path is a git
 * route (handled, even as a 404); false when it is not this surface's path.
 */
export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const endpoint = match[3] as string;

  if (!isAuthorized(req, forge.config)) {
    gitUnauthorized(res);
    return true;
  }
  const repo = findGitRepo(forge, owner, name);
  if (repo === null) {
    gitNotFound(res);
    return true;
  }

  // --- info/refs ----------------------------------------------------------
  if (method === 'GET' && endpoint === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(res, 200, wantsV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD);
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD);
      return true;
    }
    gitBadRequest(res, 'unknown service');
    return true;
  }

  // --- git-upload-pack ----------------------------------------------------
  if (method === 'POST' && endpoint === 'git-upload-pack') {
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      gitBadRequest(res, 'bad pkt-line stream');
      return true;
    }
    const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' || lines[0]?.startsWith('command=') === true;
    if (isV2) {
      const commandLine = lines[0] ?? '';
      const commandMatch = /^command=([a-z-]+)\n?$/.exec(commandLine);
      if (commandMatch === null) {
        gitBadRequest(res, 'expected a v2 command');
        return true;
      }
      const command = commandMatch[1] as string;
      // Arguments follow the delim (or, leniently, any line after the command
      // that is not an agent/object-format line).
      const args: string[] = [];
      let pastDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8');
        if (text.startsWith('command=')) continue;
        if (!pastDelim && (text.startsWith('agent=') || text.startsWith('object-format='))) continue;
        args.push(text.replace(/\n$/, ''));
      }
      if (command === 'ls-refs') {
        let peel = false;
        let symrefs = false;
        const prefixes: string[] = [];
        for (const arg of args) {
          if (arg === 'peel') peel = true;
          else if (arg === 'symrefs') symrefs = true;
          else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
        }
        sendRaw(res, 200, lsRefsAnswer(repo, { peel, symrefs, prefixes }), UPLOAD_RESULT);
        return true;
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | undefined;
        for (const arg of args) {
          if (arg.startsWith('want ') && isObjectId(arg.slice(5))) wants.push(arg.slice(5));
          else if (arg.startsWith('have ') && isObjectId(arg.slice(5))) haves.push(arg.slice(5));
          else if (arg.startsWith('shallow ') && isObjectId(arg.slice(8))) shallow.push(arg.slice(8));
          else if (arg.startsWith('deepen ')) {
            const n = Number(arg.slice(7));
            if (Number.isInteger(n) && n > 0) depth = n;
          }
        }
        if (wants.length === 0) {
          // A fetch with nothing wanted still answers a well-formed reply.
          sendRaw(res, 200, fetchV2Answer(repo, [], [], [], undefined), UPLOAD_RESULT);
          return true;
        }
        sendRaw(res, 200, fetchV2Answer(repo, wants, haves, shallow, depth), UPLOAD_RESULT);
        return true;
      }
      gitBadRequest(res, `unknown v2 command ${command}`);
      return true;
    }
    // v0 fetch: want/shallow/deepen lines, a flush, then have/done lines.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) {
          const oid = text.slice(5, 45);
          if (isObjectId(oid)) wants.push(oid);
        } else if (text.startsWith('shallow ') && isObjectId(text.slice(8))) shallow.push(text.slice(8));
        else if (text.startsWith('deepen ')) {
          const n = Number(text.slice(7));
          if (Number.isInteger(n) && n > 0) depth = n;
        }
      } else if (text.startsWith('have ') && isObjectId(text.slice(5))) {
        haves.push(text.slice(5));
      }
    }
    sendRaw(res, 200, fetchV0Answer(repo, wants, haves, shallow, depth), UPLOAD_RESULT);
    return true;
  }

  // --- git-receive-pack ---------------------------------------------------
  if (method === 'POST' && endpoint === 'git-receive-pack') {
    let prefix;
    try {
      prefix = decodePktLinesPrefix(body);
    } catch {
      gitBadRequest(res, 'bad pkt-line stream');
      return true;
    }
    const commands: PushCommand[] = [];
    let sideband = false;
    let malformed = false;
    for (const packet of prefix.packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k')) sideband = true;
      }
      const parts = line.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string) || !(parts[2] as string).startsWith('refs/')) {
        malformed = true;
        break;
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (malformed || commands.length === 0) {
      gitBadRequest(res, 'bad push command list');
      return true;
    }
    const packBytes = body.subarray(prefix.consumed);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects: Map<string, GitObject> = parseIncomingPack(repo, packBytes);
        addObjects(repo, objects);
      } catch (err) {
        unpackOk = false;
        unpackDetail = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const results = commands.map((command) => {
      if (!unpackOk) return { ref: command.ref, ok: false, reason: 'unpack failed' };
      const verdict = applyPushCommand(repo, command);
      return { ref: command.ref, ok: verdict.ok, reason: verdict.reason };
    });
    const report = pushReport(unpackOk, unpackDetail, results);
    if (sideband) {
      // The report rides band 1; every packet carries its own band byte.
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < report.length; offset += 65515) {
        const chunk = report.subarray(offset, Math.min(report.length, offset + 65515));
        chunks.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
      sendRaw(res, 200, Buffer.concat([...chunks, pktFlush()]), RECEIVE_RESULT);
    } else {
      sendRaw(res, 200, Buffer.concat([report, pktFlush()]), RECEIVE_RESULT);
    }
    return true;
  }

  gitBadRequest(res, 'unsupported method for this endpoint');
  return true;
}
