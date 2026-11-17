// graphql.ts — a small hand-written GraphQL executor for the subset the suite uses:
// operations with variables, aliases, arguments, inline fragments, inline input objects and
// enum literals. Introspection covers the four types the checks describe.

import {
  VIEWER_LOGIN,
  commentGlobalId,
  createIssueInRepo,
  createPullInRepo,
  decodeGlobalId,
  diffTrees,
  findRepoById,
  issueGlobalId,
  mergeBase,
  mergePullInRepo,
  mergeWouldConflict,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  store,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '.' && input.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(i));
      if (match) {
        tokens.push({ kind: 'number', value: Number(match[0]) });
        i += match[0].length;
        continue;
      }
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
      if (match) {
        tokens.push({ kind: 'name', value: match[0] });
        i += match[0].length;
        continue;
      }
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }
  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', variables: [], selection: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new Error(`unsupported operation ${keyword}`);
    }
    let name: string | undefined;
    const next = this.peek();
    if (next && next.kind === 'name') name = this.next().value as string;
    const variables: OperationNode['variables'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, defaultValue });
      }
    }
    return { kind: keyword, name, variables, selection: this.parseSelectionSet() };
  }

  private parseType(): void {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token && token.kind === 'spread') {
      this.next();
      let typeCondition: string | undefined;
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] | undefined;
    const next = this.peek();
    if (next && next.kind === 'punct' && next.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'string': return node.value;
    case 'number': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlObj {
  __type: string;
  data: unknown;
}

function gql(type: string, data: unknown): GqlObj {
  return { __type: type, data };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function repoObj(repo: Repo): GqlObj {
  return gql('Repository', repo);
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return gql('Issue', { repo, issue });
}

function pullObj(repo: Repo, pr: PullRequest): GqlObj {
  return gql('PullRequest', { repo, pr });
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.tag !== 'Issue' || decoded.parts.length < 2) return null;
  const repo = findRepoById(Number(decoded.parts[0]));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.tag !== 'PullRequest' || decoded.parts.length < 2) return null;
  const repo = findRepoById(Number(decoded.parts[0]));
  if (!repo) return null;
  const pr = repo.pulls.find((p) => p.number === Number(decoded.parts[1]));
  return pr ? { repo, pr } : null;
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.tag !== 'Repository' || decoded.parts.length < 1) return null;
  return findRepoById(Number(decoded.parts[0])) ?? null;
}

// ---------------------------------------------------------------------------------------------
// introspection tables
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  File: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

type Vars = Record<string, unknown>;

function resolveArgs(field: FieldNode, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, vars);
  return out;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    list = list.filter((issue) =>
      states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  let startIdx = 0;
  if (typeof args.after === 'string' && args.after) {
    const num = decodeCursor(args.after);
    if (num !== null) {
      const idx = list.findIndex((issue) => issue.number === num);
      if (idx >= 0) startIdx = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + first < list.length;
  const endCursor = page.length ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length ? encodeCursor(page[0].number) : null;
  return gql('IssueConnection', {
    repo,
    issues: page,
    pageInfo: { hasNextPage, hasPreviousPage: startIdx > 0, startCursor, endCursor },
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return gql('PullRequestConnection', {
    repo,
    prs: page,
    pageInfo: {
      hasNextPage: first < list.length,
      hasPreviousPage: false,
      startCursor: page.length ? encodeCursor(page[0].number) : null,
      endCursor: page.length ? encodeCursor(page[page.length - 1].number) : null,
    },
  });
}

function filesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>): GqlObj {
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  let paths: string[] = [];
  if (headTip && baseTip) {
    const base = mergeBase((oid) => repo.objects.get(oid), baseTip, headTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    paths = diffTrees(repo, baseTree, headTree).map((d) => d.filename);
  }
  const first = typeof args.first === 'number' ? args.first : paths.length;
  return gql('FileConnection', { files: paths.slice(0, first) });
}

function mergeableOf(repo: Repo, pr: PullRequest): string {
  if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(
  parent: GqlObj,
  field: FieldNode,
  vars: Vars,
  errors: Array<{ message: string }>,
): unknown {
  const args = resolveArgs(field, vars);
  const unknownField = (): null => {
    errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__type}".` });
    return null;
  };
  switch (parent.__type) {
    case 'Query': {
      if (field.name === 'viewer') return gql('User', { login: VIEWER_LOGIN });
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = name ? store.getRepo(owner, name) : undefined;
        return repo ? repoObj(repo) : null;
      }
      if (field.name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.tag === 'Repository') {
          const repo = findRepoByGlobalId(id);
          return repo ? repoObj(repo) : null;
        }
        if (decoded.tag === 'Issue') {
          const found = findIssueByGlobalId(id);
          return found ? issueObj(found.repo, found.issue) : null;
        }
        if (decoded.tag === 'PullRequest') {
          const found = findPullByGlobalId(id);
          return found ? pullObj(found.repo, found.pr) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        if (TYPE_FIELDS[name] || TYPE_ENUM_VALUES[name]) {
          return gql('__Type', {
            name,
            fields: TYPE_FIELDS[name] ?? null,
            enumValues: TYPE_ENUM_VALUES[name] ?? null,
          });
        }
        return null;
      }
      if (field.name === '__schema') return null;
      return unknownField();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string'
          ? findRepoByGlobalId(input.repositoryId)
          : null;
        if (!repo) {
          errors.push({ message: 'repository not found for createIssue' });
          return gql('CreateIssuePayload', { issue: null });
        }
        const created = createIssueInRepo(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          [],
        );
        if (!created.ok) {
          errors.push({ message: created.error });
          return gql('CreateIssuePayload', { issue: null });
        }
        return gql('CreateIssuePayload', { issue: issueObj(repo, created.value) });
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.issueId === 'string'
          ? findIssueByGlobalId(input.issueId)
          : null;
        if (!found) {
          errors.push({ message: 'issue not found for closeIssue' });
          return gql('CloseIssuePayload', { issue: null });
        }
        found.issue.state = 'closed';
        return gql('CloseIssuePayload', { issue: issueObj(found.repo, found.issue) });
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string'
          ? findRepoByGlobalId(input.repositoryId)
          : null;
        if (!repo) {
          errors.push({ message: 'repository not found for createPullRequest' });
          return gql('CreatePullRequestPayload', { pullRequest: null });
        }
        const created = createPullInRepo(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if (!created.ok) {
          errors.push({ message: created.error });
          return gql('CreatePullRequestPayload', { pullRequest: null });
        }
        return gql('CreatePullRequestPayload', { pullRequest: pullObj(repo, created.value) });
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.pullRequestId === 'string'
          ? findPullByGlobalId(input.pullRequestId)
          : null;
        if (!found) {
          errors.push({ message: 'pull request not found for mergePullRequest' });
          return gql('MergePullRequestPayload', { pullRequest: null });
        }
        const merged = mergePullInRepo(found.repo, found.pr);
        if (!merged.ok) {
          errors.push({ message: merged.error });
          return gql('MergePullRequestPayload', { pullRequest: pullObj(found.repo, found.pr) });
        }
        return gql('MergePullRequestPayload', { pullRequest: pullObj(found.repo, found.pr) });
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.subjectId === 'string'
          ? findIssueByGlobalId(input.subjectId)
          : null;
        if (!found) {
          errors.push({ message: 'issue not found for addComment' });
          return gql('AddCommentPayload', { commentEdge: null });
        }
        const comment = {
          id: found.repo.nextComment++,
          body: String(input.body ?? ''),
          seq: store.seq++,
        };
        found.issue.comments.push(comment);
        const node = gql('IssueComment', {
          repo: found.repo,
          issue: found.issue,
          comment,
        });
        return gql('AddCommentPayload', {
          commentEdge: gql('IssueCommentEdge', { node }),
        });
      }
      return unknownField();
    }
    case 'User': {
      const user = parent.data as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.login;
      if (field.name === 'name') return user.login;
      return unknownField();
    }
    case 'Repository': {
      const repo = parent.data as Repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return gql('User', { login: repo.owner });
        case 'description': return repo.description;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? gql('Ref', { name: repo.defaultBranch }) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = typeof number === 'number'
            ? repo.issues.find((i) => i.number === number)
            : undefined;
          return issue ? issueObj(repo, issue) : null;
        }
        case 'issues': return issuesConnection(repo, args);
        case 'pullRequests': return pullsConnection(repo, args);
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pr = typeof number === 'number'
            ? repo.pulls.find((p) => p.number === number)
            : undefined;
          return pr ? pullObj(repo, pr) : null;
        }
        default: return unknownField();
      }
    }
    case 'Issue': {
      const { repo, issue } = parent.data as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        default: return unknownField();
      }
    }
    case 'PullRequest': {
      const { repo, pr } = parent.data as { repo: Repo; pr: PullRequest };
      switch (field.name) {
        case 'id': return pullGlobalId(repo, pr);
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pr.merged;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return mergeableOf(repo, pr);
        case 'files': return filesConnection(repo, pr, args);
        default: return unknownField();
      }
    }
    case 'IssueConnection': {
      const data = parent.data as { repo: Repo; issues: Issue[]; pageInfo: unknown };
      if (field.name === 'nodes') return data.issues.map((i) => issueObj(data.repo, i));
      if (field.name === 'pageInfo') return gql('PageInfo', data.pageInfo);
      if (field.name === 'totalCount') return data.issues.length;
      return unknownField();
    }
    case 'PullRequestConnection': {
      const data = parent.data as { repo: Repo; prs: PullRequest[]; pageInfo: unknown };
      if (field.name === 'nodes') return data.prs.map((p) => pullObj(data.repo, p));
      if (field.name === 'pageInfo') return gql('PageInfo', data.pageInfo);
      if (field.name === 'totalCount') return data.prs.length;
      return unknownField();
    }
    case 'PageInfo': {
      const info = parent.data as Record<string, unknown>;
      if (field.name in info) return info[field.name];
      return unknownField();
    }
    case 'Ref': {
      const ref = parent.data as { name: string };
      if (field.name === 'name') return ref.name;
      return unknownField();
    }
    case 'FileConnection': {
      const data = parent.data as { files: string[] };
      if (field.name === 'nodes') return data.files.map((path) => gql('File', { path }));
      return unknownField();
    }
    case 'File': {
      const file = parent.data as { path: string };
      if (field.name === 'path') return file.path;
      return unknownField();
    }
    case 'IssueCommentEdge': {
      const edge = parent.data as { node: GqlObj };
      if (field.name === 'node') return edge.node;
      return unknownField();
    }
    case 'IssueComment': {
      const data = parent.data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
      if (field.name === 'id') return commentGlobalId(data.repo, data.issue, data.comment);
      if (field.name === 'body') return data.comment.body;
      return unknownField();
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const data = parent.data as { issue: GqlObj | null };
      if (field.name === 'issue') return data.issue;
      return unknownField();
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const data = parent.data as { pullRequest: GqlObj | null };
      if (field.name === 'pullRequest') return data.pullRequest;
      return unknownField();
    }
    case 'AddCommentPayload': {
      const data = parent.data as { commentEdge: GqlObj | null };
      if (field.name === 'commentEdge') return data.commentEdge;
      return unknownField();
    }
    case '__Type': {
      const type = parent.data as { name: string; fields: string[] | null; enumValues: string[] | null };
      if (field.name === 'name') return type.name;
      if (field.name === 'fields') {
        return type.fields ? type.fields.map((name) => gql('__Field', { name })) : null;
      }
      if (field.name === 'enumValues') {
        return type.enumValues
          ? type.enumValues.map((name) => gql('__EnumValue', { name }))
          : null;
      }
      return unknownField();
    }
    case '__Field': {
      const f = parent.data as { name: string };
      if (field.name === 'name') return f.name;
      return unknownField();
    }
    case '__EnumValue': {
      const v = parent.data as { name: string };
      if (field.name === 'name') return v.name;
      return unknownField();
    }
    default:
      return unknownField();
  }
}

function isGqlObj(value: unknown): value is GqlObj {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as GqlObj).__type === 'string' &&
    'data' in (value as GqlObj)
  );
}

function executeSelection(
  parent: GqlObj,
  selections: SelectionNode[],
  vars: Vars,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== parent.__type) continue;
      const nested = executeSelection(parent, selection.selection, vars, errors);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const value = resolveField(parent, selection, vars, errors);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) =>
        isGqlObj(item) && selection.selection
          ? executeSelection(item, selection.selection, vars, errors)
          : item,
      );
      continue;
    }
    if (isGqlObj(value)) {
      out[responseKey] = selection.selection
        ? executeSelection(value, selection.selection, vars, errors)
        : null;
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeOne(body: unknown): Record<string, unknown> {
  const obj = (body !== null && typeof body === 'object' && !Array.isArray(body))
    ? (body as Record<string, unknown>)
    : {};
  const query = typeof obj.query === 'string' ? obj.query : '';
  const variables = (obj.variables !== null && typeof obj.variables === 'object' && !Array.isArray(obj.variables))
    ? (obj.variables as Record<string, unknown>)
    : {};
  if (!query) {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  }
  // A body with several operation documents answers each in order, merged into one data object.
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  for (const operation of operations) {
    const vars: Vars = { ...variables };
    for (const varDef of operation.variables) {
      if (!(varDef.name in vars) && varDef.defaultValue) {
        vars[varDef.name] = resolveValue(varDef.defaultValue, vars);
      }
    }
    const root = gql(operation.kind === 'mutation' ? 'Mutation' : 'Query', null);
    Object.assign(data, executeSelection(root, operation.selection, vars, errors));
  }
  const result: Record<string, unknown> = { data };
  if (errors.length) result.errors = errors;
  return result;
}

/** POST /api/graphql. Returns the HTTP status and the JSON body. */
export function handleGraphQL(body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((item) => executeOne(item)) };
  }
  return { status: 200, json: executeOne(body) };
}
