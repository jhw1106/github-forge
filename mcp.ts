// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP,
// plain JSON responses. The modern 2026-07-28 era (server/discover, no handshake, no session)
// plus the legacy initialize handshake as a fallback. Tools act on the same store as REST.

import {
  VIEWER_LOGIN,
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  store,
  type Repo,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_NAME = 'github-forge';
export const MCP_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function textResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireArgs(
  args: Record<string, unknown>,
  names: readonly string[],
): ToolResult {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      return { ok: false, message: `missing required argument: ${name}` };
    }
  }
  return { ok: true, value: null };
}

function repoOf(args: Record<string, unknown>): ToolResult {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  if (owner !== VIEWER_LOGIN) return { ok: false, message: `repository ${owner}/${name} not found` };
  const repo = store.getRepo(owner, name);
  if (!repo) return { ok: false, message: `repository ${owner}/${name} not found` };
  return { ok: true, value: repo };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const match = (toolName: string): boolean =>
    name === toolName || name.toLowerCase().endsWith(`__${toolName}`);
  if (match('create_repo')) {
    const check = requireArgs(args, ['name']);
    if (!check.ok) return errorResult(check.message);
    const repoName = String(args.name);
    if (store.getRepo(VIEWER_LOGIN, repoName)) {
      return errorResult(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    }
    const repo = store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: typeof args.private === 'boolean' ? args.private : false,
    });
    return textResult(repoJson(repo));
  }
  if (match('get_repo')) {
    const check = requireArgs(args, ['owner', 'repo']);
    if (!check.ok) return errorResult(check.message);
    const found = repoOf(args);
    if (!found.ok) return errorResult(found.message);
    return textResult(repoJson(found.value as Repo));
  }
  if (match('create_issue')) {
    const check = requireArgs(args, ['owner', 'repo', 'title']);
    if (!check.ok) return errorResult(check.message);
    const found = repoOf(args);
    if (!found.ok) return errorResult(found.message);
    const repo = found.value as Repo;
    const created = createIssueInRepo(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      [],
    );
    if (!created.ok) return errorResult(created.error);
    return textResult(issueJson(repo, created.value));
  }
  if (match('list_issues')) {
    const check = requireArgs(args, ['owner', 'repo']);
    if (!check.ok) return errorResult(check.message);
    const found = repoOf(args);
    if (!found.ok) return errorResult(found.message);
    const repo = found.value as Repo;
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues
      .filter((issue) => (state === 'all' ? true : issue.state === state))
      .map((issue) => issueJson(repo, issue));
    return textResult(list);
  }
  if (match('create_pull_request')) {
    const check = requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (!check.ok) return errorResult(check.message);
    const found = repoOf(args);
    if (!found.ok) return errorResult(found.message);
    const repo = found.value as Repo;
    const created = createPullInRepo(
      repo,
      String(args.title),
      typeof args.body === 'string' ? args.body : '',
      String(args.head),
      String(args.base),
    );
    if (!created.ok) return errorResult(created.error);
    return textResult(pullJson(repo, created.value));
  }
  if (match('merge_pull_request')) {
    const check = requireArgs(args, ['owner', 'repo', 'pull_number']);
    if (!check.ok) return errorResult(check.message);
    const found = repoOf(args);
    if (!found.ok) return errorResult(found.message);
    const repo = found.value as Repo;
    const number = Number(args.pull_number);
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return errorResult(`pull request #${args.pull_number} not found`);
    const merged = mergePullInRepo(repo, pr);
    if (!merged.ok) return errorResult(merged.error);
    return textResult(pullJson(repo, pr));
  }
  return errorResult(`unknown tool: ${name}`);
}

export interface McpResponse {
  status: number;
  json: unknown | null;
}

/** Handle one POST /mcp request. `body` is the parsed JSON body, or undefined when unparseable. */
export function handleMcp(body: unknown, parseFailed: boolean): McpResponse {
  if (parseFailed) {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const obj = (body !== null && typeof body === 'object' && !Array.isArray(body))
    ? (body as Record<string, unknown>)
    : {};
  const method = typeof obj.method === 'string' ? obj.method : '';
  const id = 'id' in obj ? obj.id : undefined;
  const params = (obj.params !== null && typeof obj.params === 'object' && !Array.isArray(obj.params))
    ? (obj.params as Record<string, unknown>)
    : {};

  // A notification has no id: answer 202 with no body.
  if (id === undefined) {
    return { status: 202, json: null };
  }

  const result = (value: unknown): McpResponse =>
    ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const failure = (code: number, message: string): McpResponse =>
    ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return result({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_NAME, version: MCP_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: MCP_NAME, version: MCP_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : SUPPORTED_VERSIONS[0];
    return result({
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_NAME, version: MCP_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};
    const known = TOOLS.some((tool) =>
      name === tool.name || name.toLowerCase().endsWith(`__${String(tool.name)}`));
    if (!name || !known) {
      return failure(-32602, `unknown tool: ${name}`);
    }
    return result(callTool(name, args));
  }
  if (method === 'ping') {
    return result({});
  }
  return failure(-32601, `method not found: ${method}`);
}
