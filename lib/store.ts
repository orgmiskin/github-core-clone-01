// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments — one store behind all four surfaces
// (REST v3, git smart HTTP, GraphQL v4, MCP), so a write through any of them
// is visible through the others at once.
//
// Determinism: every timestamp comes from the trial's fixed time
// (MAKEFUN_TRIAL_NOW); server-made commits take that instant plus a
// monotonically increasing counter, so two commits never collide and a replay
// of the same requests builds the same objects. No wall clock, no randomness.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { DEFAULT_BRANCH, VIEWER_EMAIL, VIEWER_NAME, repoKey, type ForgeConfig } from './util.ts';

/** A repository label. */
export interface Label {
  name: string;
  color: string;
}

/** An issue comment. */
export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

/** An issue. `_json` caches the REST serialization, cleared on mutation. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  _json?: string;
}

/** A pull request. */
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  /** The head/base tips at creation (fallbacks when a branch is deleted). */
  headSha: string;
  baseSha: string;
  user: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** A repository: git state plus its issues, pulls and labels. */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Creation order across the forge (the user/repos list order). */
  seq: number;
  /** All git objects, by id. */
  objects: Map<string, GitObject>;
  /** Refs by full name (refs/heads/*, refs/tags/*) to object id. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Labels by lowercase name. */
  labels: Map<string, Label>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  /** Cached fetch packs, keyed by the selection's inputs. */
  packCache: Map<string, CachedFetch>;
}

/** One cached fetch selection: the pack plus its shallow boundary lines. */
export interface CachedFetch {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/** One changed file of a pull request's diff. */
export interface DiffEntry {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The most fetch packs kept per repository (FIFO eviction). */
const PACK_CACHE_LIMIT = 128;

const COMMIT_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** Whether two flattened file entries are the same version (or both absent). */
function sameFile(a: { oid: string } | undefined, b: { oid: string } | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

/** The number of lines in a blob's bytes (a trailing newline ends, not starts, a line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

// ---------------------------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------------------------

/** The whole forge: every repository and the counters that keep ids deterministic. */
export class Forge {
  readonly config: ForgeConfig;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private nextSeq = 1;
  private requestSeq = 0;
  private commitSeq = 0;

  constructor(config: ForgeConfig) {
    this.config = config;
  }

  /** The trial's fixed time, as an ISO-8601 UTC string. */
  nowIso(): string {
    return this.config.nowIso;
  }

  /** A deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  /** The timestamp for a server-made commit: the trial instant plus a counter. */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return this.config.nowSec + this.commitSeq;
  }

  /** Create a repository under the viewer; null when the name is taken. */
  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: this.config.nowIso,
      updatedAt: this.config.nowIso,
      seq: this.nextSeq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Find a repository by owner and name (case-insensitive). */
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  /** Every repository of one owner, in creation order. */
  listRepos(owner: string): Repo[] {
    const login = owner.toLowerCase();
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === login) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Delete a repository and everything in it. */
  deleteRepo(repo: Repo): void {
    this.repos.delete(repoKey(repo.owner, repo.name));
  }

  /** Create an issue; `labels` must already exist (checked by the caller). */
  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: repo.owner,
      createdSeq: this.nextSeq,
      createdAt: this.config.nowIso,
      updatedAt: this.config.nowIso,
      comments: [],
    };
    this.nextIssueId += 1;
    this.nextSeq += 1;
    repo.issues.set(number, issue);
    return issue;
  }

  /** Create a comment on an issue. */
  createComment(issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      user: issue.user,
      createdAt: this.config.nowIso,
      updatedAt: this.config.nowIso,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue._json = undefined;
    return comment;
  }

  /** Create a pull request; the caller resolves the branches first. */
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: this.nextPullId,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha: '',
      baseSha: '',
      user: repo.owner,
      createdSeq: this.nextSeq,
      createdAt: this.config.nowIso,
      updatedAt: this.config.nowIso,
    };
    this.nextPullId += 1;
    this.nextSeq += 1;
    repo.pulls.set(number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------------------------
// git objects and refs
// ---------------------------------------------------------------------------------------------

/** Store objects from a parsed pack; clears the repo's fetch-pack cache. */
export function addObjects(repo: Repo, objects: ReadonlyMap<string, GitObject>): void {
  for (const [oid, object] of objects) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  repo.packCache.clear();
}

/** The tip of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The tip of the repository's default branch, or null when it is unborn. */
export function defaultTip(repo: Repo): string | null {
  return branchTip(repo, repo.defaultBranch);
}

/**
 * Resolve a ref-ish: a branch name first, then a 40-hex object id that the
 * store holds. Returns the commit id, or null.
 */
export function resolveRef(repo: Repo, ref: string): string | null {
  const branch = branchTip(repo, ref);
  if (branch !== null) return branch;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** A commit's tree id, or null when the object is not a commit. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Follow annotated tags to their commit (a commit resolves to itself). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Create a commit object in the store and return its id. */
export function createCommit(
  forge: Forge,
  repo: Repo,
  fields: { tree: string; parents: readonly string[]; message: string },
): string {
  const timestamp = forge.nextCommitTimestamp();
  const data = buildCommit({
    tree: fields.tree,
    parents: fields.parents,
    message: fields.message,
    author: COMMIT_IDENTITY,
    committer: COMMIT_IDENTITY,
    timestamp,
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.packCache.clear();
  return oid;
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(repo: Repo, roots: Iterable<string>, out: Set<string>): void {
  const queue: string[] = [...roots];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
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
}

/** A tree and everything under it (subtrees and blobs), into `out`. */
export function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') continue;
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/** Flatten a tree to `path -> {oid, mode}` for every file in it. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface DirNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, DirNode>;
}

/**
 * Build (and store) the tree objects for a flat file map, returning the root
 * tree id. Empty directories cannot exist in git: a directory appears only
 * when it holds a file.
 */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] as string;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const buildNode = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(sub) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildNode(root);
}

/**
 * Commit one file on a branch (the contents API's write). A branch that does
 * not exist yet starts from the default branch's tip, or from nothing when
 * the repository is unborn. Returns the commit and blob ids and whether the
 * file is new on that branch.
 */
export function commitFile(
  forge: Forge,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; isNew: boolean } {
  const parent = branchTip(repo, branch) ?? defaultTip(repo);
  const baseFiles = parent === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTree(repo, parent) as string);
  const blobSha = hashObject('blob', content);
  if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: Buffer.from(content) });
  const isNew = !baseFiles.has(path);
  const files = new Map(baseFiles);
  files.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = buildTreeFromFiles(repo, files);
  const commitSha = createCommit(forge, repo, { tree: treeOid, parents: parent === null ? [] : [parent], message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.packCache.clear();
  return { commitSha, blobSha, isNew };
}

/** Commit the removal of one file from a branch; null when the file is absent. */
export function deleteFile(forge: Forge, repo: Repo, branch: string, path: string, message: string): string | null {
  const parent = branchTip(repo, branch);
  if (parent === null) return null;
  const tree = commitTree(repo, parent);
  if (tree === null) return null;
  const files = flattenTree(repo, tree);
  if (!files.has(path)) return null;
  files.delete(path);
  const treeOid = buildTreeFromFiles(repo, files);
  const commitSha = createCommit(forge, repo, { tree: treeOid, parents: [parent], message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.packCache.clear();
  return commitSha;
}

/** What a path in a commit resolves to: a file, a directory, or nothing. */
export type PathLookup =
  | { kind: 'file'; oid: string; data: Buffer; mode: string }
  | { kind: 'dir'; oid: string; entries: TreeEntry[] }
  | { kind: 'missing' };

/** Read a repository-relative path out of a commit's tree. */
export function readPath(repo: Repo, commitOid: string, path: string): PathLookup {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return { kind: 'missing' };
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') {
    const object = repo.objects.get(tree);
    if (object === undefined) return { kind: 'missing' };
    return { kind: 'dir', oid: tree, entries: parseTree(object.data) };
  }
  const parts = clean.split('/');
  let treeOid = tree;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return { kind: 'missing' };
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return { kind: 'missing' };
    const last = index === parts.length - 1;
    if (entry.mode === '40000') {
      if (!last) {
        treeOid = entry.oid;
        continue;
      }
      const dirObject = repo.objects.get(entry.oid);
      if (dirObject === undefined) return { kind: 'missing' };
      return { kind: 'dir', oid: entry.oid, entries: parseTree(dirObject.data) };
    }
    if (!last) return { kind: 'missing' };
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return { kind: 'missing' };
    return { kind: 'file', oid: entry.oid, data: blob.data, mode: entry.mode };
  }
  return { kind: 'missing' };
}

/** A commit's history, newest first (depth-first from the tip, deduplicated). */
export function listCommits(repo: Repo, tipOid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index] as string);
  }
  return out;
}

/** The merge base of two commits: the closest common ancestor (null when unrelated). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = new Set<string>();
  const queueA = [a];
  let headA = 0;
  while (headA < queueA.length) {
    const oid = queueA[headA] as string;
    headA += 1;
    if (aAncestors.has(oid)) continue;
    aAncestors.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB = [b];
  let headB = 0;
  while (headB < queueB.length) {
    const oid = queueB[headB] as string;
    headB += 1;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (aAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

/** The diff of two trees, as a pull request's file list. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): DiffEntry[] {
  const baseFiles = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const headFiles = headTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, headTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: DiffEntry[] = [];
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    if (base === undefined && head !== undefined) {
      const additions = lineCount(repo.objects.get(head.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const deletions = lineCount(repo.objects.get(base.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base !== undefined && head !== undefined) {
      const additions = lineCount(repo.objects.get(head.oid)?.data ?? Buffer.alloc(0));
      const deletions = lineCount(repo.objects.get(base.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/** A pull request's changed files: the diff of merge-base...head. */
export function pullFiles(repo: Repo, pull: Pull): DiffEntry[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  return diffTrees(repo, baseTree, commitTree(repo, headTip));
}

/**
 * Whether a pull request conflicts: some file changed on the head since the
 * merge base, and also changed on the base tip since the merge base, to a
 * different version.
 */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return false;
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTree(repo, base) as string);
  const headFiles = flattenTree(repo, commitTree(repo, headTip) as string);
  const baseTipFiles = flattenTree(repo, commitTree(repo, baseTip) as string);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const head = headFiles.get(path);
    const fromBase = baseFiles.get(path);
    const onBase = baseTipFiles.get(path);
    if (sameFile(head, fromBase)) continue;
    if (sameFile(onBase, fromBase)) continue;
    if (!sameFile(head, onBase)) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: one commit on the base
 * whose tree is the base tree plus the head's changes. Returns the merge
 * commit, or null when the pull conflicts.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  if (pullConflicts(repo, pull)) return null;
  const headTip = branchTip(repo, pull.head) as string;
  const baseTip = branchTip(repo, pull.base) as string;
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTree(repo, base) as string);
  const headFiles = flattenTree(repo, commitTree(repo, headTip) as string);
  const merged = flattenTree(repo, commitTree(repo, baseTip) as string);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const head = headFiles.get(path);
    const fromBase = baseFiles.get(path);
    if (sameFile(head, fromBase)) continue;
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  const treeOid = buildTreeFromFiles(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const commitSha = createCommit(forge, repo, { tree: treeOid, parents: [baseTip], message });
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = forge.nowIso();
  return commitSha;
}

// ---------------------------------------------------------------------------------------------
// fetch selection
// ---------------------------------------------------------------------------------------------

/** What a fetch sends: the object ids, and the shallow boundary lines. */
export interface FetchSelection {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Select the objects a fetch sends: everything reachable from the wants at
 * most `depth` generations out (the want at generation 1), minus what the
 * client already holds. A non-shallow have excludes its whole closure; a
 * shallow have (a boundary the client already knows) excludes only the
 * commit itself and its tree. Commits cut off by the depth are reported
 * shallow; shallow boundaries whose parents are now included are unshallow.
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowHaves: readonly string[],
  depth: number | undefined,
): FetchSelection {
  const shallowSet = new Set(shallowHaves);
  const wantCommits: string[] = [];
  const extra = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      wantCommits.push(want);
    } else if (object.type === 'tag') {
      extra.add(want);
      const target = peelToCommit(repo, want);
      if (target !== null) wantCommits.push(target);
      else {
        const tag = parseTag(object.data);
        extra.add(tag.object);
      }
    } else {
      extra.add(want);
    }
  }

  // Generations out from the wants, cut at the depth.
  const generation = new Map<string, number>();
  const commits = new Set<string>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 1]);
  let head = 0;
  while (head < queue.length) {
    const [oid, gen] = queue[head] as [string, number];
    head += 1;
    if (generation.has(oid)) continue;
    if (depth !== undefined && gen > depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    generation.set(oid, gen);
    commits.add(oid);
    if (depth === undefined || gen < depth) {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
    }
  }

  const collected = new Set<string>([...extra, ...commits]);
  for (const oid of commits) {
    const tree = commitTree(repo, oid);
    if (tree !== null) collectTree(repo, tree, collected);
  }

  // What the client already holds.
  const excluded = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      const object = repo.objects.get(have);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        excluded.add(have);
        const tree = commitTree(repo, have);
        if (tree !== null) collectTree(repo, tree, excluded);
      } else if (object.type === 'tree') {
        excluded.add(have);
        collectTree(repo, have, excluded);
      } else {
        excluded.add(have);
      }
    } else {
      collectReachable(repo, [have], excluded);
    }
  }

  const sent = [...collected].filter((oid) => !excluded.has(oid));
  const sentSet = new Set(sent);
  const available = (oid: string): boolean => sentSet.has(oid) || excluded.has(oid) || shallowSet.has(oid);

  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of commits) {
      if (!sentSet.has(oid)) continue;
      if (generation.get(oid) !== depth) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.some((parent) => !available(parent))) shallow.push(oid);
    }
  }

  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => sentSet.has(parent) || excluded.has(parent))) unshallow.push(oid);
  }

  sent.sort();
  shallow.sort();
  unshallow.sort();
  return { oids: sent, shallow, unshallow };
}

/**
 * The pack for a fetch selection, cached per repository: the clone workload
 * asks fifty concurrent clients for the same depth-1 pack, and the pack is
 * identical every time. The cache is cleared on any mutation of the repo.
 */
export function fetchPack(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowHaves: readonly string[],
  depth: number | undefined,
): CachedFetch {
  const key = JSON.stringify([
    [...wants].sort(),
    [...haves].sort(),
    [...shallowHaves].sort(),
    depth ?? null,
  ]);
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const selection = selectFetch(repo, wants, haves, shallowHaves, depth);
  const objects: GitObject[] = [];
  for (const oid of selection.oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const fetched: CachedFetch = { pack: writePack(objects), shallow: selection.shallow, unshallow: selection.unshallow };
  if (repo.packCache.size >= PACK_CACHE_LIMIT) {
    const oldest = repo.packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) repo.packCache.delete(oldest);
  }
  repo.packCache.set(key, fetched);
  return fetched;
}

/** Parse an incoming pack, resolving thin-pack bases against the repo store. */
export function parseIncomingPack(repo: Repo, bytes: Buffer): Map<string, GitObject> {
  return readPack(bytes, { resolveBase: (oid) => repo.objects.get(oid) });
}
