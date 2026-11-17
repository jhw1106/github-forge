// app.ts — the HTTP server: routing, auth, body reading and the JSON envelope.
// The four surfaces (git smart HTTP, REST v3, GraphQL, MCP) all live in this one process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { store, VIEWER_LOGIN } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true; // no token configured (local development only)
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, json: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = json === null ? '' : JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': body.length,
  });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((s) => s.length > 0).map(decodeSegment);

        // GET /healthz — the boot check; no auth.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Everything else needs the bearer token.
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }

        // GraphQL.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const result = handleGraphQL(body);
          sendJson(res, result.status, result.json);
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          let parseFailed = false;
          try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
          } catch {
            parseFailed = true;
          }
          const result = handleMcp(body, parseFailed);
          if (result.status === 202 || result.json === null) {
            res.writeHead(result.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json);
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          const raw = method === 'GET' || method === 'HEAD'
            ? Buffer.alloc(0)
            : await readBody(req);
          let body: unknown;
          if (raw.length === 0) {
            body = undefined;
          } else {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
          const baseUrl = `http://${req.headers.host ?? 'localhost'}${url.pathname}${url.search}`;
          const result = handleRest(method, restSegments, url.searchParams, body, baseUrl);
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, result.status, result.json, result.headers);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
          const service = segments[2];
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET' && service === 'info' && segments[3] === 'refs') {
            const svc = url.searchParams.get('service');
            if (svc === 'git-upload-pack') {
              const result = infoRefs(repo, 'upload', req.headers['git-protocol'] ?? '');
              sendBuffer(res, result.status, result.contentType, result.body);
              return;
            }
            if (svc === 'git-receive-pack') {
              const result = infoRefs(repo, 'receive', '');
              sendBuffer(res, result.status, result.contentType, result.body);
              return;
            }
            sendJson(res, 400, { message: 'unknown service' });
            return;
          }
          if (method === 'POST' && service === 'git-upload-pack') {
            const body = await readBody(req);
            const result = uploadPack(repo, body, req.headers['git-protocol'] ?? '');
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          if (method === 'POST' && service === 'git-receive-pack') {
            const body = await readBody(req);
            const result = receivePack(repo, body);
            sendBuffer(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: (err as Error).message || 'internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
