// The GitHub REST v3 surface, under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests.
//
// Contract notes the checks pin down:
//   - every reply is application/json with a non-empty X-GitHub-Request-Id,
//     including 401/404/400/409/422/405;
//   - a missing or wrong token is 401; the same repository name under another
//     owner is 404, never 403;
//   - a duplicate repository name is 422 with "already exists" in the message;
//   - a contents PUT is 201 on create, 200 on update, 409 on a stale sha;
//   - issue numbers (shared with pull requests) increment by one per repo;
//   - list endpoints honour per_page/page and link the next page with a
//     Link rel="next" header on the same origin.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  branchTip,
  commitFile,
  defaultTip,
  deleteFile,
  listCommits,
  pullConflicts,
  pullFiles,
  readPath,
  resolveRef,
  squashMerge,
  type DiffEntry,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isObjectId, parseCommit } from './gitobj.ts';
import { b64decode, b64encodeBytes, isAuthorized, isRecord, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './util.ts';
import { sendError, sendJson, sendJsonText } from './http.ts';

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`).toString('base64'),
    avatar_url: '',
    type: 'User',
    html_url: `https://github.com/${login}`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: userJson(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${issue.user}/issues/${issue.number}`,
  };
}

/** The issue's serialized REST body, cached until the issue mutates. */
function issueJsonText(issue: Issue): string {
  if (issue._json === undefined) issue._json = `${JSON.stringify(issueJson(issue))}\n`;
  return issue._json;
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  const headSha = branchTip(repo, pull.head) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.base) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

/** Split a "Name <email> timestamp tz" identity line into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  const seconds = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(seconds * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return { sha, commit: { message: '' } };
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

/** The per_page/page pair of a list request (per_page 1..100, default 30). */
function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page'));
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const pageRaw = Number(query.get('page'));
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/**
 * The Link header for a paginated list, on the request's own origin. The
 * client follows rel="next" only while it stays on that origin.
 */
function linkHeader(req: IncomingMessage, pathname: string, query: URLSearchParams, page: Page, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / page.perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const urlFor = (pageNumber: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(page.perPage));
    params.set('page', String(pageNumber));
    return `http://${host}${pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  links.push(`<${urlFor(1)}>; rel="first"`);
  if (page.page > 1) links.push(`<${urlFor(page.page - 1)}>; rel="prev"`);
  if (page.page < totalPages) links.push(`<${urlFor(page.page + 1)}>; rel="next"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return links.join(', ');
}

/** Slice one page out of a list and answer it with the Link header. */
function sendPage<T>(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  items: readonly T[],
  render: (item: T) => unknown,
): void {
  const page = pageOf(query);
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage).map(render);
  const link = linkHeader(req, pathname, query, page, items.length);
  sendJson(forge, res, 200, slice, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/** Parse a JSON request body; null when empty, or a 400 is sent and null returned. */
function parseBody(forge: Forge, res: ServerResponse, body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    sendError(forge, res, 400, 'Problems parsing JSON');
    return null;
  }
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/** Find the repository a route names, answering 404 (never 403) when absent. */
function findRepo(forge: Forge, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN) {
    sendError(forge, res, 404, 'Not Found');
    return null;
  }
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    sendError(forge, res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** A positive integer path segment, or null. */
function numberParam(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Handle one /api/v3 request. Returns true when the path is under /api/v3
 * (handled, even as a 404); false when it is not this surface's path at all.
 */
export function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const tail = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
  const segments = tail === '' ? [] : tail.split('/').map((segment) => decodeURIComponent(segment));

  // The API root and meta are public, as on github.com; everything else needs the token.
  const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
  if (!isPublic && !isAuthorized(req, forge.config)) {
    sendError(forge, res, 401, 'Bad credentials');
    return true;
  }

  // GET /api/v3/ — the API root, with the token's scopes.
  if (method === 'GET' && segments.length === 0) {
    sendJson(
      forge,
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    sendJson(forge, res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }

  // GET /api/v3/user — the token owner.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    sendJson(forge, res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
    return true;
  }

  // POST /api/v3/user/repos — create a repository under the viewer.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const name = stringField(parsed, 'name');
      if (name === undefined || name === '') {
        sendError(forge, res, 422, 'name is required');
        return true;
      }
      const created = forge.createRepo(
        VIEWER_LOGIN,
        name,
        parsed.private === true,
        stringField(parsed, 'description') ?? '',
      );
      if (created === null) {
        sendError(forge, res, 422, 'Repository creation failed. (name already exists on this account)');
        return true;
      }
      sendJson(forge, res, 201, repoJson(created));
      return true;
    }
    if (method === 'GET') {
      sendPage(forge, req, res, pathname, query, forge.listRepos(VIEWER_LOGIN), (repo) => repoJson(repo));
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // Everything below is /repos/{owner}/{name}[/...].
  if (segments.length < 3 || segments[0] !== 'repos') {
    sendError(forge, res, 404, 'Not Found');
    return true;
  }
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{owner}/{name}
  if (rest.length === 0) {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (method === 'GET') {
      sendJson(forge, res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const description = stringField(parsed, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof parsed.private === 'boolean') repo.private = parsed.private;
      repo.updatedAt = forge.nowIso();
      sendJson(forge, res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  const area = rest[0] as string;

  // --- branches -----------------------------------------------------------
  if (area === 'branches') {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(forge, res, 200, branches);
      return true;
    }
    if (method === 'GET' && rest.length > 1) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) {
        sendError(forge, res, 404, 'Branch not found');
        return true;
      }
      sendJson(forge, res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // --- git refs -----------------------------------------------------------
  if (area === 'git' && rest[1] === 'refs') {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const ref = stringField(parsed, 'ref');
      const sha = stringField(parsed, 'sha');
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isObjectId(sha)) {
        sendError(forge, res, 422, 'Invalid ref or sha');
        return true;
      }
      const object = repo.objects.get(sha);
      if (object === undefined) {
        sendError(forge, res, 422, 'Invalid SHA');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(forge, res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      sendJson(forge, res, 201, { ref, object: { sha, type: object.type } });
      return true;
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      const object = repo.objects.get(sha);
      sendJson(forge, res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // --- commits ------------------------------------------------------------
  if (area === 'commits' && rest.length === 1) {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (method !== 'GET') {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    const refParam = query.get('sha');
    const tip = refParam === null ? defaultTip(repo) : resolveRef(repo, refParam);
    if (tip === null) {
      sendJson(forge, res, 200, []);
      return true;
    }
    sendJson(forge, res, 200, listCommits(repo, tip).map((sha) => commitJson(repo, sha)));
    return true;
  }

  // --- contents -----------------------------------------------------------
  if (area === 'contents') {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    const path = rest.slice(1).join('/');
    if (method === 'PUT') {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const content = stringField(parsed, 'content');
      if (content === undefined) {
        sendError(forge, res, 422, 'content is required');
        return true;
      }
      const message = stringField(parsed, 'message') ?? `Update ${path}`;
      const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
      const sha = stringField(parsed, 'sha');
      const parent = branchTip(repo, branch) ?? defaultTip(repo);
      if (parent !== null && sha !== undefined) {
        const current = readPath(repo, parent, path);
        if (current.kind === 'file' && current.oid.toLowerCase() !== sha.toLowerCase()) {
          sendError(forge, res, 409, 'sha does not match the current file');
          return true;
        }
      }
      let bytes: Buffer;
      try {
        bytes = b64decode(content);
      } catch {
        sendError(forge, res, 422, 'content is not valid base64');
        return true;
      }
      const written = commitFile(forge, repo, branch, path, bytes, message);
      const baseName = path.split('/').pop() ?? path;
      sendJson(forge, res, written.isNew ? 201 : 200, {
        content: { sha: written.blobSha, encoding: 'base64', name: baseName, path, size: bytes.length },
        commit: { sha: written.commitSha },
      });
      return true;
    }
    if (method === 'GET') {
      const refParam = query.get('ref');
      const tip = refParam === null ? defaultTip(repo) : resolveRef(repo, refParam);
      if (tip === null) {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      const found = readPath(repo, tip, path);
      if (found.kind === 'missing') {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      if (found.kind === 'file') {
        const baseName = path.split('/').pop() ?? path;
        sendJson(forge, res, 200, {
          type: 'file',
          encoding: 'base64',
          size: found.data.length,
          name: baseName,
          path,
          content: b64encodeBytes(found.data),
          sha: found.oid,
        });
        return true;
      }
      const entries = found.entries.map((entry) => {
        const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const isDir = entry.mode === '40000';
        const blob = isDir ? undefined : repo.objects.get(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          size: blob?.data.length ?? 0,
          name: entry.name,
          path: entryPath,
          sha: entry.oid,
        };
      });
      sendJson(forge, res, 200, entries);
      return true;
    }
    if (method === 'DELETE') {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const message = stringField(parsed, 'message') ?? `Delete ${path}`;
      const branch = stringField(parsed, 'branch') ?? repo.defaultBranch;
      const sha = stringField(parsed, 'sha');
      const tip = branchTip(repo, branch);
      if (tip === null) {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      const current = readPath(repo, tip, path);
      if (current.kind !== 'file') {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      if (sha !== undefined && current.oid.toLowerCase() !== sha.toLowerCase()) {
        sendError(forge, res, 409, 'sha does not match the current file');
        return true;
      }
      const commitSha = deleteFile(forge, repo, branch, path, message);
      if (commitSha === null) {
        sendError(forge, res, 404, 'Not Found');
        return true;
      }
      sendJson(forge, res, 200, { commit: { sha: commitSha } });
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // --- labels -------------------------------------------------------------
  if (area === 'labels' && rest.length === 1) {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (method === 'POST') {
      const parsed = parseBody(forge, res, body);
      if (parsed === null) return true;
      const labelName = stringField(parsed, 'name');
      if (labelName === undefined || labelName === '') {
        sendError(forge, res, 422, 'name is required');
        return true;
      }
      const existing = repo.labels.get(labelName.toLowerCase());
      if (existing !== undefined) {
        sendJson(forge, res, 201, { name: existing.name, color: existing.color });
        return true;
      }
      const label = { name: labelName, color: stringField(parsed, 'color') ?? 'ededed' };
      repo.labels.set(labelName.toLowerCase(), label);
      sendJson(forge, res, 201, { name: label.name, color: label.color });
      return true;
    }
    if (method === 'GET') {
      sendJson(
        forge,
        res,
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
      );
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // --- issues -------------------------------------------------------------
  if (area === 'issues') {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseBody(forge, res, body);
        if (parsed === null) return true;
        const title = stringField(parsed, 'title');
        if (title === undefined || title === '') {
          sendError(forge, res, 422, 'title is required');
          return true;
        }
        const labelNames = Array.isArray(parsed.labels)
          ? (parsed.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : [];
        const labels: Array<{ name: string; color: string }> = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName.toLowerCase());
          if (label === undefined) {
            sendError(forge, res, 422, `Label does not exist: ${labelName}`);
            return true;
          }
          labels.push(label);
        }
        const issue = forge.createIssue(repo, title, stringField(parsed, 'body') ?? '', labels);
        sendJson(forge, res, 201, issueJson(issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        sendPage(forge, req, res, pathname, query, issues, (issue) => issueJson(issue));
        return true;
      }
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    const number = numberParam(rest[1] as string);
    if (number === null) {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJsonText(forge, res, 200, issueJsonText(issue));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(forge, res, body);
        if (parsed === null) return true;
        const state = stringField(parsed, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = stringField(parsed, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = stringField(parsed, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        issue.updatedAt = forge.nowIso();
        issue._json = undefined;
        sendJson(forge, res, 200, issueJson(issue));
        return true;
      }
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const parsed = parseBody(forge, res, body);
        if (parsed === null) return true;
        const text = stringField(parsed, 'body');
        if (text === undefined) {
          sendError(forge, res, 422, 'body is required');
          return true;
        }
        const comment = forge.createComment(issue, text);
        sendJson(forge, res, 201, commentJson(comment));
        return true;
      }
      if (method === 'GET') {
        sendJson(forge, res, 200, issue.comments.map((comment) => commentJson(comment)));
        return true;
      }
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  // --- pull requests ------------------------------------------------------
  if (area === 'pulls') {
    const repo = findRepo(forge, res, owner, name);
    if (repo === null) return true;
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseBody(forge, res, body);
        if (parsed === null) return true;
        const title = stringField(parsed, 'title');
        const head = stringField(parsed, 'head');
        const base = stringField(parsed, 'base');
        if (title === undefined || title === '' || head === undefined || base === undefined) {
          sendError(forge, res, 422, 'title, head and base are required');
          return true;
        }
        const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
        const headTip = branchTip(repo, headBranch);
        const baseTip = branchTip(repo, base);
        if (headTip === null || baseTip === null) {
          sendError(forge, res, 422, 'head or base branch does not exist');
          return true;
        }
        if (headBranch === base) {
          sendError(forge, res, 422, 'head and base must differ');
          return true;
        }
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.head === headBranch && existing.base === base) {
            sendError(forge, res, 422, 'A pull request already exists for this head and base');
            return true;
          }
        }
        const pull = forge.createPull(repo, title, stringField(parsed, 'body') ?? '', headBranch, base);
        pull.headSha = headTip;
        pull.baseSha = baseTip;
        sendJson(forge, res, 201, pullJson(pull, repo));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        sendPage(forge, req, res, pathname, query, pulls, (pull) => pullJson(pull, repo));
        return true;
      }
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    const number = numberParam(rest[1] as string);
    if (number === null) {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        sendJson(forge, res, 200, pullJson(pull, repo));
        return true;
      }
      sendError(forge, res, 404, 'Not Found');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const files: DiffEntry[] = pullFiles(repo, pull);
      sendJson(forge, res, 200, files);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.state !== 'open') {
        sendError(forge, res, 405, 'Pull request is already closed');
        return true;
      }
      if (pullConflicts(repo, pull)) {
        sendError(forge, res, 405, 'Merge conflict');
        return true;
      }
      const sha = squashMerge(forge, repo, pull);
      if (sha === null) {
        sendError(forge, res, 405, 'Merge conflict');
        return true;
      }
      sendJson(forge, res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    sendError(forge, res, 404, 'Not Found');
    return true;
  }

  sendError(forge, res, 404, 'Not Found');
  return true;
}
