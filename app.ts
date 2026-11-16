// The HTTP server: routing, auth, body reading. One process, one store.
//
// Routes:
//   GET  /healthz                       200 {ok:true} (no auth; the env's boot probe)
//   POST /mcp                          MCP over streamable HTTP
//   POST /api/graphql                  GraphQL v4 (single operation or a batch array)
//   /api/v3/*                          REST v3 (see rest.ts)
//   /{owner}/{repo}.git/info/refs      git smart-HTTP advertisements
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//   anything else                      404 {"message":"Not Found"}
//
// Auth: every surface but /healthz requires a non-empty Bearer token and
// answers 401 {"message": ...} without one. The token is opaque; the viewer
// is always adaiversen. Every JSON reply carries X-GitHub-Request-Id.
// A REST body that is not JSON is a 400 {"message": ...}; a git body is
// binary and is never parsed as JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, jsonReply, type RestContext } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function requestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

function unauthorized(res: ServerResponse): void {
  jsonReply(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(store, req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId() });
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }));
        } else {
          res.destroy();
        }
      }
    })();
  });
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { path, query } = pathOf(req);
  const host = req.headers.host ?? '127.0.0.1';

  if (method === 'GET' && path === '/healthz') {
    jsonReply(res, 200, { ok: true });
    return;
  }

  if (!hasAuth(req)) {
    unauthorized(res);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method !== 'POST') {
      jsonReply(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const outcome = handleMcp(store, host, body);
    res.writeHead(outcome.status, { ...outcome.headers, 'x-github-request-id': requestId() });
    res.end(outcome.body);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      jsonReply(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      jsonReply(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    const outcome = handleGraphQL(store, parsed);
    jsonReply(res, outcome.status, outcome.payload);
    return;
  }

  // git smart HTTP.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3];
    if (suffix === 'info/refs' && method === 'GET') {
      handleInfoRefs(store, owner, repoName, req, res, query.get('service'));
      return;
    }
    if (suffix === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      handleUploadPack(store, owner, repoName, req, res, body);
      return;
    }
    if (suffix === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(store, owner, repoName, req, res, body);
      return;
    }
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    let parsed: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const body = await readBody(req);
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          jsonReply(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
      }
    }
    const ctx: RestContext = { store, req, res, body: parsed, query, host };
    if (handleRest(ctx, method, path)) return;
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }

  jsonReply(res, 404, { message: 'Not Found' });
}
