// The Model Context Protocol surface at POST /mcp: JSON-RPC 2.0 over
// Streamable HTTP, the modern era — no handshake, no session state, every
// request answered as one JSON object (a plain body, not an SSE stream).
//
// The suite speaks two eras and the server answers both. The modern era
// (2026-07-28) is server/discover: the client asks which protocol revisions
// the server supports and then calls tools straight away, declaring its
// revision in _meta. The legacy era (2025-11-25 and earlier) is initialize
// followed by notifications/initialized, then tools/list and tools/call.
// A server that answers server/discover is a modern server; initialize is
// kept as a fallback for a legacy-only client.
//
// The six tools are the github-mcp-server set the suite drives: create_repo,
// get_repo, create_issue, list_issues, create_pull_request and
// merge_pull_request. Tool results carry both content (text holding the JSON
// of the result) and structuredContent (the JSON itself), so either reading
// path works. Every error is a JSON-RPC error with the right code — unknown
// tool -32601, bad arguments -32602, a body that is not JSON -32700 on a
// 400 — and never an HTTP 500. A missing Authorization header is a 401
// before anything else, exactly like REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchTip, pullConflicts, squashMerge, type Forge, type Issue, type Repo } from './store.ts';
import { isAuthorized, isRecord, VIEWER_LOGIN } from './util.ts';
import { sendError, sendJson } from './http.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';
const SUPPORTED_REVISIONS = [MODERN_REVISION, LEGACY_REVISION];

// The tool list is a precomputed constant: two tools/list calls answer the
// same list byte for byte, and nothing rebuilds it per request.
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        full_name: Object.freeze({ type: 'string', description: 'The full name of the repository (owner/repo).' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Filter issues by state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The name of the branch where the changes are implemented.' }),
        base: Object.freeze({ type: 'string', description: 'The name of the branch the changes are merged into.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The number of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function stringField(args: JsonObject, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(args: JsonObject, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function repoJson(repo: Repo): JsonObject {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): JsonObject {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    repository: repo.fullName,
  };
}

function resolveRepo(forge: Forge, args: JsonObject): Repo | undefined {
  const owner = stringField(args, 'owner');
  const repoName = stringField(args, 'repo');
  if (owner !== undefined && repoName !== undefined) return forge.getRepo(owner, repoName);
  // A caller may send only full_name ("owner/repo"); the suite fills it when
  // the schema has the property.
  const fullName = stringField(args, 'full_name');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return forge.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  }
  return undefined;
}

class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

type ToolHandler = (forge: Forge, args: JsonObject) => JsonObject;

const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  create_repo: (forge, args) => {
    const name = stringField(args, 'name');
    if (name === undefined) throw new ToolError('name is required');
    if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
      throw new ToolError('a repository with this name already exists');
    }
    const description = stringField(args, 'description') ?? '';
    const isPrivate = args.private === true;
    const repo = forge.createRepo(VIEWER_LOGIN, name, isPrivate, description);
    if (repo === null) throw new ToolError('a repository with this name already exists');
    return repoJson(repo);
  },
  get_repo: (forge, args) => {
    const repo = resolveRepo(forge, args);
    if (repo === undefined) throw new ToolError('repository not found');
    return repoJson(repo);
  },
  create_issue: (forge, args) => {
    const repo = resolveRepo(forge, args);
    if (repo === undefined) throw new ToolError('repository not found');
    const title = stringField(args, 'title');
    if (title === undefined) throw new ToolError('title is required');
    const body = stringField(args, 'body') ?? '';
    const issue = forge.createIssue(repo, title, body, []);
    return issueJson(repo, issue);
  },
  list_issues: (forge, args) => {
    const repo = resolveRepo(forge, args);
    if (repo === undefined) throw new ToolError('repository not found');
    const state = stringField(args, 'state') ?? 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .map((issue) => issueJson(repo, issue));
    return { issues };
  },
  create_pull_request: (forge, args) => {
    const repo = resolveRepo(forge, args);
    if (repo === undefined) throw new ToolError('repository not found');
    const title = stringField(args, 'title');
    const head = stringField(args, 'head');
    const base = stringField(args, 'base');
    if (title === undefined || head === undefined || base === undefined) {
      throw new ToolError('title, head and base are required');
    }
    const headTip = branchTip(repo, head);
    const baseTip = branchTip(repo, base);
    if (headTip === null || baseTip === null) throw new ToolError('head or base branch does not exist');
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === head && existing.base === base) {
        throw new ToolError('A pull request already exists for this head and base');
      }
    }
    const body = stringField(args, 'body') ?? '';
    const pull = forge.createPull(repo, title, body, head, base);
    pull.headSha = headTip;
    pull.baseSha = baseTip;
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.head, sha: headTip },
      base: { ref: pull.base, sha: baseTip },
      merged: false,
    };
  },
  merge_pull_request: (forge, args) => {
    const repo = resolveRepo(forge, args);
    if (repo === undefined) throw new ToolError('repository not found');
    const pullNumber = numberField(args, 'pull_number');
    if (pullNumber === undefined) throw new ToolError('pull_number is required');
    const pull = repo.pulls.get(pullNumber);
    if (pull === undefined) throw new ToolError('pull request not found');
    if (pull.state !== 'open') throw new ToolError('pull request is already closed');
    if (pullConflicts(repo, pull)) throw new ToolError('Merge conflict');
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) throw new ToolError('Merge conflict');
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  },
});

// ---------------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Handle one JSON-RPC request object. Returns null for a notification. */
function handleRpcRequest(forge: Forge, request: JsonObject): Record<string, unknown> | null {
  const id = 'id' in request ? request.id : undefined;
  const isNotification = id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? (request.params as JsonObject) : {};

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and expects no answer (202, empty body).
    return null;
  }

  if (method === 'server/discover') {
    // The modern era: the client learns the supported revisions and the
    // server identity in one call, then calls tools without a handshake.
    const result: Record<string, unknown> = {
      supportedVersions: [...SUPPORTED_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return rpcResult(id, result);
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_REVISIONS.includes(requested) ? requested : LEGACY_REVISION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS, nextCursor: undefined });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) {
      return rpcError(id, -32601, `unknown tool: ${name}`);
    }
    const args = isRecord(params.arguments) ? (params.arguments as JsonObject) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    for (const property of required) {
      if (args[property] === undefined || args[property] === null || args[property] === '') {
        return rpcError(id, -32602, `missing required argument: ${property}`);
      }
    }
    try {
      const result = handler(forge, args);
      const text = JSON.stringify(result);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: result,
      });
    } catch (err) {
      if (err instanceof ToolError) {
        return rpcResult(id, {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        });
      }
      throw err;
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * Handle a request to /mcp. Returns true when the path is this surface's;
 * false otherwise.
 */
export function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  body: Buffer,
): boolean {
  if (pathname !== '/mcp') return false;
  const method = req.method ?? 'GET';
  if (method !== 'POST') {
    sendError(forge, res, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthorized(req, forge.config)) {
    sendError(forge, res, 401, 'Bad credentials');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // A body that is not JSON is a parse error, -32700, on a 400.
    sendJson(forge, res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(forge, res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const isNotification = !('id' in parsed);
  let answer: Record<string, unknown> | null;
  try {
    answer = handleRpcRequest(forge, parsed as JsonObject);
  } catch {
    answer = rpcError(parsed.id ?? null, -32603, 'Internal error');
  }
  if (answer === null) {
    // A notification: acknowledged with a 202 and an empty body.
    res.writeHead(202, {
      'x-github-request-id': `req_${forge.nextRequestId()}`,
      'content-length': '0',
    });
    res.end();
    return true;
  }
  void isNotification;
  sendJson(forge, res, 200, answer);
  return true;
}
