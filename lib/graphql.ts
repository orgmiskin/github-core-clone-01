// The GitHub GraphQL v4 surface at POST /api/graphql: a small lexer, a
// recursive-descent parser and an executor over the same store as REST, so a
// mutation here is visible over REST at once and vice versa.
//
// The documents the suite sends are the ones gh and github-mcp-server send:
// viewer/repository reads, the __type feature probes, issue and pull-request
// reads and the create/close/merge/comment mutations, plus operation batching
// (a JSON array of documents in one body, answered in order). The executor
// covers exactly that surface: variables, aliases, inline fragments, inline
// input objects and enum lists, null variables and operation names.
//
// Global ids are opaque base64 of a typed key ("Repository:12"), stable
// across reads and decodable by node(id:) and by the mutations' inputs.
// An unknown field is a 200 with an errors array naming it, never an HTTP
// error; an unknown repository reads data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  branchTip,
  pullConflicts,
  pullFiles,
  squashMerge,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isAuthorized, isRecord, VIEWER_LOGIN } from './util.ts';
import { sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`).toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${commentId}`);
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '$', '!', '[', ']', '=', '@', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '﻿') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCT.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < length) {
        const current = source[index] as string;
        if (current === '"') {
          index += 1;
          break;
        }
        if (current === '\\' && index + 1 < length) {
          const escaped = source[index + 1] as string;
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 'b') value += '\b';
          else if (escaped === 'f') value += '\f';
          else if (escaped === '/') value += '/';
          else if (escaped === '\\') value += '\\';
          else if (escaped === '"') value += '"';
          else if (escaped === 'u' && index + 5 < length) {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else value += escaped;
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      let isFloat = false;
      if (char === '-') {
        value += '-';
        index += 1;
      }
      while (index < length && /[0-9]/.test(source[index] as string)) {
        value += source[index];
        index += 1;
      }
      if (source[index] === '.' && /[0-9]/.test(source[index + 1] ?? '')) {
        isFloat = true;
        value += '.';
        index += 1;
        while (index < length && /[0-9]/.test(source[index] as string)) {
          value += source[index];
          index += 1;
        }
      }
      if (source[index] === 'e' || source[index] === 'E') {
        isFloat = true;
        value += source[index];
        index += 1;
        if (source[index] === '+' || source[index] === '-') {
          value += source[index];
          index += 1;
        }
        while (index < length && /[0-9]/.test(source[index] as string)) {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < length && /[A-Za-z0-9_]/.test(source[index] as string)) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.position] as Token;
    this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.atPunct('(')) this.parseVariableDefinitions();
    } else if (token.kind === 'name' && token.value === 'subscription') {
      throw new Error('subscriptions are not supported');
    } else if (token.kind === 'name' && token.value === 'fragment') {
      throw new Error('named fragments are not supported');
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, selectionSet };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('selection set ended early');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      }
      const selectionSet = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selectionSet };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives are not used by the suite's documents; skip any, leniently.
    while (this.atPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName('an argument name');
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} in a value`);
  }
}

function parseDocument(source: string): Operation[] {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// schema: the fields each type holds (validation + __type introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt',
    'comments', 'labels', 'repository', 'url',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'repository',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
});

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
});

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

/** An internal value: a typed object the executor walks, or a scalar. */
type ExecValue =
  | string
  | number
  | boolean
  | null
  | ExecValue[]
  | { __typename: string; [key: string]: unknown };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
}

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

/** Evaluate a value node against the operation's variables. */
function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return node.name in variables ? variables[node.name] : undefined;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evaluateValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evaluateValue(arg.value, ctx.variables);
  return out;
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** A cursor for issue pagination: base64 of the creation sequence it follows. */
function issueCursor(seq: number): string {
  return Buffer.from(`issue:${seq}`).toString('base64');
}

function seqAfterCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

type Resolver = (parent: { __typename: string; [key: string]: unknown }, args: Record<string, unknown>, ctx: ExecContext) => ExecValue;

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER_LOGIN }),
    repository: (_parent, args, ctx) => {
      const owner = stringArg(args, 'owner');
      const name = stringArg(args, 'name');
      if (owner === undefined || name === undefined) return null;
      if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo === undefined ? null : { __typename: 'Repository', repo };
    },
    node: (_parent, args, ctx) => {
      const id = stringArg(args, 'id');
      if (id === undefined) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoById(ctx.forge, Number(decoded.key));
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const [repoId, number] = decoded.key.split(':');
        const repo = findRepoById(ctx.forge, Number(repoId));
        if (repo === undefined) return null;
        if (decoded.type === 'Issue') {
          const issue = repo.issues.get(Number(number));
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        const pull = repo.pulls.get(Number(number));
        return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = stringArg(args, 'name');
      if (name === undefined) return null;
      if (!(name in SCHEMA_FIELDS) && !(name in SCHEMA_ENUMS)) return null;
      return { __typename: '__Type', typeName: name };
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoById(ctx.forge, Number(decoded.key)) : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.forge.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', repo, issue };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      if (decoded === null || decoded.type !== 'Issue') throw new GraphQLError('issue not found');
      const [repoId, number] = decoded.key.split(':');
      const repo = findRepoById(ctx.forge, Number(repoId));
      const issue = repo?.issues.get(Number(number));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      issue.updatedAt = ctx.forge.nowIso();
      issue._json = undefined;
      return { __typename: 'CloseIssuePayload', repo, issue };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoById(ctx.forge, Number(decoded.key)) : undefined;
      if (repo === undefined) throw new GraphQLError('repository not found');
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headTip = branchTip(repo, headRefName);
      const baseTip = branchTip(repo, baseRefName);
      if (headTip === null || baseTip === null) throw new GraphQLError('head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === headRefName && existing.base === baseRefName) {
          throw new GraphQLError('A pull request already exists for this head and base');
        }
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = ctx.forge.createPull(repo, title, body, headRefName, baseRefName);
      pull.headSha = headTip;
      pull.baseSha = baseTip;
      return { __typename: 'CreatePullRequestPayload', repo, pull };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.type !== 'PullRequest') throw new GraphQLError('pull request not found');
      const [repoId, number] = decoded.key.split(':');
      const repo = findRepoById(ctx.forge, Number(repoId));
      const pull = repo?.pulls.get(Number(number));
      if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
      if (pull.state !== 'open') throw new GraphQLError('pull request is already closed');
      const merged = squashMerge(ctx.forge, repo, pull);
      if (merged === null) throw new GraphQLError('Merge conflict');
      return { __typename: 'MergePullRequestPayload', repo, pull };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const decoded = decodeGlobalId(subjectId);
      if (decoded === null || decoded.type !== 'Issue') throw new GraphQLError('subject not found');
      const [repoId, number] = decoded.key.split(':');
      const repo = findRepoById(ctx.forge, Number(repoId));
      const issue = repo?.issues.get(Number(number));
      if (repo === undefined || issue === undefined) throw new GraphQLError('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = ctx.forge.createComment(issue, body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', repo, comment } },
      };
    },
  },
  Repository: {
    id: (parent) => repoGlobalId(parent.repo as Repo),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => (parent.repo as Repo).fullName,
    owner: (parent) => ({ __typename: 'User', login: (parent.repo as Repo).owner }),
    defaultBranchRef: (parent) => ({ __typename: 'Ref', name: (parent.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.repo as Repo).description,
    createdAt: (parent) => (parent.repo as Repo).createdAt,
    updatedAt: (parent) => (parent.repo as Repo).updatedAt,
    url: (parent) => `https://github.com/${(parent.repo as Repo).fullName}`,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const number = intArg(args, 'number');
      if (number === undefined) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { __typename: 'Issue', repo, issue };
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      if (states.length > 0) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      if (orderBy !== null && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
        issues.sort((a, b) => b.createdSeq - a.createdSeq);
      } else if (orderBy !== null && orderBy.field === 'CREATED_AT' && orderBy.direction === 'ASC') {
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
      } else {
        issues.sort((a, b) => a.createdSeq - b.createdSeq);
      }
      const afterSeq = seqAfterCursor(stringArg(args, 'after'));
      if (afterSeq >= 0) issues = issues.filter((issue) => issue.createdSeq > afterSeq);
      const first = intArg(args, 'first') ?? issues.length;
      const page = issues.slice(0, Math.max(0, first));
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length > 0 ? issueCursor((page[page.length - 1] as Issue).createdSeq) : null;
      return {
        __typename: 'IssueConnection',
        repo,
        nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue })),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
      };
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      const first = intArg(args, 'first') ?? 30;
      const pulls = [...repo.pulls.values()]
        .filter((pull) => pull.state === 'open')
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestConnection',
        repo,
        nodes: pulls.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
      };
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const number = intArg(args, 'number');
      if (number === undefined) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
    },
  },
  User: {
    login: (parent) => parent.login as string,
    id: () => '1',
    name: () => '',
    email: () => '',
  },
  Issue: {
    id: (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent.issue as Issue).body,
    author: (parent) => ({ __typename: 'User', login: (parent.issue as Issue).user }),
    createdAt: (parent) => (parent.issue as Issue).createdAt,
    updatedAt: (parent) => (parent.issue as Issue).updatedAt,
    repository: (parent) => ({ __typename: 'Repository', repo: parent.repo as Repo }),
    url: (parent) => `https://github.com/${(parent.repo as Repo).fullName}/issues/${(parent.issue as Issue).number}`,
    comments: () => null,
    labels: () => null,
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes as ExecValue[],
    pageInfo: (parent) => parent.pageInfo as { __typename: string; [key: string]: unknown },
    totalCount: (parent) => (parent.nodes as ExecValue[]).length,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage as boolean,
    endCursor: (parent) => parent.endCursor as string | null,
    hasPreviousPage: () => false,
    startCursor: () => null,
  },
  PullRequest: {
    id: (parent) => pullGlobalId(parent.repo as Repo, parent.pull as Pull),
    number: (parent) => (parent.pull as Pull).number,
    title: (parent) => (parent.pull as Pull).title,
    body: (parent) => (parent.pull as Pull).body,
    state: (parent) => {
      const pull = parent.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent.pull as Pull).merged,
    mergeable: (parent) => {
      const pull = parent.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(parent.repo as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (parent) => (parent.pull as Pull).head,
    baseRefName: (parent) => (parent.pull as Pull).base,
    author: (parent) => ({ __typename: 'User', login: (parent.pull as Pull).user }),
    createdAt: (parent) => (parent.pull as Pull).createdAt,
    updatedAt: (parent) => (parent.pull as Pull).updatedAt,
    mergedAt: (parent) => (parent.pull as Pull).mergedAt,
    repository: (parent) => ({ __typename: 'Repository', repo: parent.repo as Repo }),
    files: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      const first = intArg(args, 'first') ?? 30;
      const files = pullFiles(repo, pull).slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', file })),
      };
    },
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes as ExecValue[],
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }),
    totalCount: (parent) => (parent.nodes as ExecValue[]).length,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes as ExecValue[],
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }),
    totalCount: (parent) => (parent.nodes as ExecValue[]).length,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent.file as { filename: string }).filename,
    additions: (parent) => (parent.file as { additions: number }).additions,
    deletions: (parent) => (parent.file as { deletions: number }).deletions,
    changeType: (parent) => {
      const status = (parent.file as { status: string }).status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
    },
  },
  Ref: {
    name: (parent) => parent.name as string,
    target: () => null,
  },
  IssueComment: {
    id: (parent) => commentGlobalId(parent.repo as Repo, (parent.comment as { id: number }).id),
    body: (parent) => (parent.comment as { body: string }).body,
    author: (parent) => ({ __typename: 'User', login: (parent.comment as { user: string }).user }),
    createdAt: (parent) => (parent.comment as { createdAt: string }).createdAt,
    updatedAt: (parent) => (parent.comment as { updatedAt: string }).updatedAt,
  },
  CommentEdge: {
    node: (parent) => parent.node as { __typename: string; [key: string]: unknown },
    cursor: () => null,
  },
  CreateIssuePayload: {
    issue: (parent) => ({ __typename: 'Issue', repo: parent.repo as Repo, issue: parent.issue as Issue }),
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (parent) => ({ __typename: 'Issue', repo: parent.repo as Repo, issue: parent.issue as Issue }),
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => ({ __typename: 'PullRequest', repo: parent.repo as Repo, pull: parent.pull as Pull }),
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => ({ __typename: 'PullRequest', repo: parent.repo as Repo, pull: parent.pull as Pull }),
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge as { __typename: string; [key: string]: unknown },
    clientMutationId: () => null,
  },
  __Type: {
    name: (parent) => parent.typeName as string,
    kind: (parent) => ((parent.typeName as string) in SCHEMA_ENUMS ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (parent) => {
      const names = SCHEMA_FIELDS[parent.typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (parent) => {
      const names = SCHEMA_ENUMS[parent.typeName as string] ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (parent) => parent.name as string,
    description: () => null,
    type: () => null,
  },
  __EnumValue: {
    name: (parent) => parent.name as string,
    description: () => null,
  },
};

/** Execute a selection set against a typed parent value. */
function executeSelectionSet(
  selections: readonly SelectionNode[],
  parent: { __typename: string; [key: string]: unknown },
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, parent, ctx));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const allowed = SCHEMA_FIELDS[parent.__typename] ?? [];
    if (!allowed.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parent.__typename}".`);
    }
    const resolver = RESOLVERS[parent.__typename]?.[field.name];
    const value = resolver === undefined ? null : resolver(parent, argsOf(field, ctx), ctx);
    out[responseKey] = completeValue(value, field.selectionSet, ctx);
  }
  return out;
}

/** Complete a resolved value against its sub-selections (lists, objects, null). */
function completeValue(value: ExecValue, selectionSet: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selectionSet, ctx));
  if (selectionSet === null) return null;
  return executeSelectionSet(selectionSet, value, ctx);
}

/** Run one operation document; returns the {data} or {data, errors} body. */
function executeOperation(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): Record<string, unknown> {
  let operations: Operation[];
  try {
    operations = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in the document' }] };
  }
  let operation = operations[0] as Operation;
  if (operationName !== undefined) {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named === undefined) {
      return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
    }
    operation = named;
  }
  const ctx: ExecContext = { forge, variables };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelectionSet(operation.selectionSet, { __typename: rootType }, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * Handle one POST /api/graphql request (single or batched). Returns true when
 * the path is this surface's; false otherwise.
 */
export function handleGraphQL(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  body: Buffer,
): boolean {
  if (pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
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
    sendJson(forge, res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'a query document is required' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return executeOperation(forge, entry.query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(forge, res, 200, parsed.map(runOne));
    return true;
  }
  sendJson(forge, res, 200, runOne(parsed));
  return true;
}
