// rest.ts — the REST v3 surface under /api/v3. Every reply is JSON with an
// X-GitHub-Request-Id header; errors carry a string `message`.

import {
  FIXED_NOW_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  blobAtPath,
  commitOnBranch,
  commitsFrom,
  createIssueInRepo,
  createPullInRepo,
  diffTrees,
  globalId,
  hashObject,
  isObjectId,
  mergeBase,
  mergePullInRepo,
  mergeWouldConflict,
  parseCommit,
  pullGlobalId,
  issueGlobalId,
  repoGlobalId,
  setPathInTree,
  store,
  treeAtPath,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface ApiResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, json: unknown, headers?: Record<string, string>): ApiResponse =>
  ({ status, json, headers });
const err = (status: number, message: string): ApiResponse =>
  ({ status, json: { message } });

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function ownerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_NOW_ISO,
    updated_at: FIXED_NOW_ISO,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    fork: false,
    archived: false,
    disabled: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: '' })),
    user: ownerJson(),
    comments: issue.comments.length,
    created_at: FIXED_NOW_ISO,
    updated_at: FIXED_NOW_ISO,
  };
}

function mergeableOf(repo: Repo, pr: PullRequest): string {
  if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: pullGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable: mergeableOf(repo, pr),
    merge_commit_sha: pr.merge_commit_sha,
    merged_at: pr.merged_at,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: ownerJson(),
    created_at: FIXED_NOW_ISO,
    updated_at: FIXED_NOW_ISO,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(
  items: T[],
  query: URLSearchParams,
  baseUrl: string,
): { items: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const u = new URL(baseUrl);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return u.toString();
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (links.length) headers.Link = links.join(', ');
  return { items: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Resolve a branch name, tag name or commit oid to a commit oid. */
function resolveRef(repo: Repo, ref?: string | null): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return tag;
  return null;
}

function repoOr404(owner: string, name: string): Repo | ApiResponse {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function isRepo(value: Repo | ApiResponse): value is Repo {
  return (value as Repo).objects !== undefined;
}

// ---------------------------------------------------------------------------------------------
// the router: method + path segments under /api/v3 + query + parsed body + request base url
// ---------------------------------------------------------------------------------------------

export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): ApiResponse {
  const obj = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const str = (value: unknown, fallback = ''): string =>
    typeof value === 'string' ? value : fallback;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: `${baseUrl}/user`,
      repository_url: `${baseUrl}/repos/{owner}/{repo}`,
      rate_limit_url: `${baseUrl}/rate_limit`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('User', VIEWER_ID),
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      type: 'User',
      created_at: FIXED_NOW_ISO,
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const { items, headers } = paginate(repos.map((r) => repoJson(r)), query, baseUrl);
      return ok(200, items, headers);
    }
    if (method === 'POST') {
      const b = obj(body);
      const name = str(b.name).trim();
      if (!name) return err(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name)) {
        return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
      }
      const repo = store.createRepo(name, {
        private: typeof b.private === 'boolean' ? b.private : false,
        description: str(b.description),
      });
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);
    const repoOrErr = repoOr404(owner, name);
    if (!isRepo(repoOrErr)) return repoOrErr;
    const repo = repoOrErr;

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const b = obj(body);
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.private = b.private;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, json: null };
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`) },
            protected: false,
          }));
        return ok(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: rest[1], commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const b = obj(body);
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          return err(422, 'ref must start with refs/heads/ or refs/tags/');
        }
        if (!isObjectId(sha) || !repo.objects.has(sha)) {
          return err(422, 'sha does not name an object in this repository');
        }
        if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
        repo.refs.set(ref, sha);
        if (repo.objects.get(sha)?.type === 'commit') store.noteCommit(repo, sha);
        return ok(201, { ref, object: { sha } });
      }
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) return err(404, 'Not Found');
        return ok(200, { ref: `refs/heads/${rest[3]}`, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha'));
      if (!tip) return ok(200, []);
      const list = commitsFrom(repo, tip).map((sha) => {
        const commit = parseCommit(repo.objects.get(sha)!.data);
        return {
          sha,
          commit: {
            message: commit.message,
            author: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_NOW_ISO },
            committer: { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_NOW_ISO },
          },
        };
      });
      const { items, headers } = paginate(list, query, baseUrl);
      return ok(200, items, headers);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (!tip) return err(404, 'Not Found');
        const commit = repo.objects.get(tip);
        if (!commit || commit.type !== 'commit') return err(404, 'Not Found');
        const treeOid = parseCommit(commit.data).tree;
        const parts = path === '' ? [] : path.split('/');
        const blobOid = path === '' ? null : blobAtPath(repo, treeOid, parts);
        if (path !== '' && blobOid) {
          const blob = repo.objects.get(blobOid)!;
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: parts[parts.length - 1],
            path,
            content: blob.data.toString('base64'),
            sha: blobOid,
          });
        }
        const entries = treeAtPath(repo, treeOid, parts);
        if (entries === null) return err(404, 'Not Found');
        return ok(200, entries.map((entry) => {
          const isDir = entry.mode === '40000';
          const object = repo.objects.get(entry.oid);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: path === '' ? entry.name : `${path}/${entry.name}`,
            sha: entry.oid,
            size: !isDir && object ? object.data.length : undefined,
          };
        }));
      }
      if (method === 'PUT') {
        const b = obj(body);
        const message = str(b.message, `Update ${path}`);
        const contentB64 = str(b.content);
        if (!contentB64) return err(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const branch = str(b.branch, repo.defaultBranch) || repo.defaultBranch;
        // A branch that does not exist yet starts from the default branch tip.
        if (!repo.refs.has(`refs/heads/${branch}`)) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
        }
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
        const parts = path.split('/');
        const existing = blobAtPath(repo, baseTree, parts);
        const givenSha = typeof b.sha === 'string' ? b.sha : null;
        if (existing && givenSha && givenSha !== existing) {
          return err(409, 'sha does not match the current file');
        }
        const blobOid = hashObject('blob', content);
        if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
        const newTree = setPathInTree(repo, baseTree, parts, blobOid);
        const commitSha = commitOnBranch(repo, branch, message, newTree);
        return ok(existing ? 200 : 201, {
          content: {
            name: parts[parts.length - 1],
            path,
            sha: blobOid,
            size: content.length,
            encoding: 'base64',
            type: 'file',
          },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const b = obj(body);
        const message = str(b.message, `Delete ${path}`);
        const branch = str(b.branch, repo.defaultBranch) || repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found');
        const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
        const parts = path.split('/');
        const existing = blobAtPath(repo, baseTree, parts);
        if (!existing) return err(404, 'Not Found');
        const givenSha = typeof b.sha === 'string' ? b.sha : null;
        if (givenSha && givenSha !== existing) return err(409, 'sha does not match the current file');
        const newTree = setPathInTree(repo, baseTree, parts, null);
        const commitSha = commitOnBranch(repo, branch, message, newTree);
        return ok(200, { commit: { sha: commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const b = obj(body);
      const name = str(b.name).trim();
      if (!name) return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, `label "${name}" already exists`);
      const color = typeof b.color === 'string' && b.color ? b.color : 'd73a4a';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color, description: '' });
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.issues.filter((issue) =>
            state === 'all' ? true : issue.state === state);
          const direction = query.get('direction') ?? 'desc';
          list = [...list].sort((a, b) =>
            direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const { items, headers } = paginate(list.map((i) => issueJson(repo, i)), query, baseUrl);
          return ok(200, items, headers);
        }
        if (method === 'POST') {
          const b = obj(body);
          const title = str(b.title).trim();
          if (!title) return err(422, 'title is required');
          const labelNames: string[] = Array.isArray(b.labels)
            ? (b.labels as unknown[]).map((l) =>
                typeof l === 'string' ? l : str((l as Record<string, unknown>).name))
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              return err(422, `label "${labelName}" does not exist`);
            }
          }
          const created = createIssueInRepo(repo, title, str(b.body), labelNames);
          if (!created.ok) return err(created.status, created.error);
          return ok(201, issueJson(repo, created.value));
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      const issue = Number.isFinite(number)
        ? repo.issues.find((i) => i.number === number)
        : undefined;
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const b = obj(body);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const names = (b.labels as unknown[]).map((l) =>
              typeof l === 'string' ? l : str((l as Record<string, unknown>).name));
            for (const labelName of names) {
              if (!repo.labels.has(labelName)) {
                return err(422, `label "${labelName}" does not exist`);
              }
            }
            issue.labels = names.map((n) => repo.labels.get(n)!);
          }
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: ownerJson(),
            created_at: FIXED_NOW_ISO,
          })));
        }
        if (method === 'POST') {
          const b = obj(body);
          const commentBody = str(b.body);
          if (!commentBody) return err(422, 'body is required');
          const comment = { id: repo.nextComment++, body: commentBody, seq: store.seq++ };
          issue.comments.push(comment);
          return ok(201, {
            id: comment.id,
            body: comment.body,
            user: ownerJson(),
            created_at: FIXED_NOW_ISO,
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((pr) =>
            state === 'all' ? true : pr.state === state);
          const { items, headers } = paginate(list.map((p) => pullJson(repo, p)), query, baseUrl);
          return ok(200, items, headers);
        }
        if (method === 'POST') {
          const b = obj(body);
          const title = str(b.title).trim();
          const head = str(b.head).trim();
          const base = str(b.base).trim();
          if (!title) return err(422, 'title is required');
          if (!head || !base) return err(422, 'head and base are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha) return err(422, `head branch "${head}" does not exist`);
          if (!baseSha) return err(422, `base branch "${base}" does not exist`);
          const created = createPullInRepo(repo, title, str(b.body), head, base);
          if (!created.ok) return err(created.status, created.error);
          return ok(201, pullJson(repo, created.value));
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1], 10);
      const pr = Number.isFinite(number)
        ? repo.pulls.find((p) => p.number === number)
        : undefined;
      if (rest.length === 2) {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(repo, pr));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pr) return err(404, 'Not Found');
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        if (!headTip || !baseTip) return err(404, 'Not Found');
        const base = mergeBase((oid) => repo.objects.get(oid), baseTip, headTip);
        const baseTree = base
          ? parseCommit(repo.objects.get(base)!.data).tree
          : null;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        return ok(200, diffTrees(repo, baseTree, headTree));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pr) return err(404, 'Not Found');
        if (pr.merged || pr.state !== 'open') {
          return err(405, 'pull request is already closed');
        }
        const merged = mergePullInRepo(repo, pr);
        if (!merged.ok) return err(merged.status, merged.error);
        return ok(200, { sha: merged.value.sha, merged: true, message: merged.value.message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
