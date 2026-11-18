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
//
// Transport: a raw node:net HTTP/1.1 parser (see transport.ts) instead of
// node:http. The body is already buffered when dispatch runs, so dispatch is
// fully synchronous: no Promise, no stream events, no async_hooks per request.

import type { Server } from 'node:net';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, jsonReply, type RestContext } from './rest.ts';
import { createTransportServer, type TransportRequest, type TransportResponse } from './transport.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(36)}`;
}

function hasAuth(req: TransportRequest): boolean {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

function unauthorized(res: TransportResponse): void {
  jsonReply(res, 401, { message: 'Requires authentication' });
}

export function createApp(): Server {
  const store = new Store();
  return createTransportServer((req: TransportRequest, res: TransportResponse) => {
    try {
      dispatch(store, req, res);
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId() });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }));
      } catch {
        // The socket is gone; nothing more to do.
      }
    }
  });
}

function dispatch(store: Store, req: TransportRequest, res: TransportResponse): void {
  const method = req.method;
  const path = req.path;
  const query = req.query;
  const host = req.headers.get('host') ?? '127.0.0.1';

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
    const outcome = handleMcp(store, host, req.body);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
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
      handleUploadPack(store, owner, repoName, req, res, req.body);
      return;
    }
    if (suffix === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(store, owner, repoName, req, res, req.body);
      return;
    }
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    let parsed: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      if (req.body.length > 0) {
        try {
          parsed = JSON.parse(req.body.toString('utf8'));
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
