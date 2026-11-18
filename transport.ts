// Raw TCP HTTP/1.1 transport for the forge.
//
// Why not node:http: the timed workloads are thousands of small sequential
// requests, and node:http's per-request machinery (IncomingMessage /
// ServerResponse streams, async_hooks, header parsing through llhttp + JS
// stream state) is a large share of the server's per-request CPU. A hand
// parser over node:net does the same work with one Buffer parse and one
// socket.write per request, and dispatch becomes fully synchronous (the body
// is already buffered when the handler runs: no Promise per request).
//
// What the suite's clients actually send (undici fetch, Content-Length
// bodies, keep-alive, HTTP/1.1, no chunked uploads, no pipelining): the
// parser handles exactly that, plus chunked bodies defensively. It does not
// handle HTTP/1.0 keep-alive negotiation beyond `Connection: close`, and it
// answers a malformed request line with 400 and closes the socket.

import { createServer, type Server, type Socket } from 'node:net';

export interface TransportRequest {
  method: string;
  /** Raw request target (path + optional query), as sent. */
  target: string;
  /** Path part of the target (no query), still percent-encoded. */
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
}

export interface TransportResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

export type Dispatcher = (req: TransportRequest, res: TransportResponse) => void;

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const EMPTY_QUERY = new URLSearchParams();

/** Split a request target into its path and query (no URL normalization). */
function splitTarget(target: string): { path: string; query: URLSearchParams } {
  let t = target;
  // Defensive: absolute-form targets (a proxy would send these; undici does not).
  if (t.startsWith('http://') || t.startsWith('https://')) {
    const slash = t.indexOf('/', t.indexOf('://') + 3);
    t = slash < 0 ? '/' : t.slice(slash);
  }
  const q = t.indexOf('?');
  if (q < 0) return { path: t, query: EMPTY_QUERY };
  try {
    return { path: t.slice(0, q), query: new URLSearchParams(t.slice(q + 1)) };
  } catch {
    return { path: t.slice(0, q), query: EMPTY_QUERY };
  }
}

/** Parse one chunked body. Returns {body, consumed} or null when incomplete. */
function parseChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('ascii').trim().split(';')[0];
    const size = parseInt(sizeText, 16);
    if (Number.isNaN(size) || size < 0) return null;
    const chunkStart = lineEnd + 2;
    if (size === 0) {
      // Trailer headers until an empty line, then done.
      const trailerEnd = buf.indexOf('\r\n\r\n', chunkStart);
      if (trailerEnd < 0) {
        // No trailers: the final CRLF after the 0-chunk.
        if (buf.length < chunkStart + 2) return null;
        return { body: Buffer.concat(parts), consumed: chunkStart + 2 - start };
      }
      return { body: Buffer.concat(parts), consumed: trailerEnd + 4 - start };
    }
    if (buf.length < chunkStart + size + 2) return null;
    parts.push(buf.subarray(chunkStart, chunkStart + size));
    pos = chunkStart + size + 2;
  }
}

class Response implements TransportResponse {
  private socket: Socket;
  private status = 200;
  private headers: Record<string, string> = {};
  private wroteHead = false;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
    this.wroteHead = true;
  }

  end(body?: Buffer | string): void {
    const payload = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    if (!this.wroteHead) this.writeHead(200, {});
    const statusText = STATUS_TEXT[this.status] ?? '';
    const headLines = [`HTTP/1.1 ${this.status} ${statusText}\r\n`];
    let hasLength = false;
    let hasConnection = false;
    for (const key of Object.keys(this.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'content-length') hasLength = true;
      if (lower === 'connection') hasConnection = true;
      headLines.push(`${key}: ${this.headers[key]}\r\n`);
    }
    if (!hasLength) headLines.push(`content-length: ${payload.length}\r\n`);
    if (!hasConnection) headLines.push('connection: keep-alive\r\n');
    headLines.push('\r\n');
    const head = Buffer.from(headLines.join(''), 'ascii');
    this.socket.write(Buffer.concat([head, payload]));
  }
}

interface Connection {
  socket: Socket;
  buffer: Buffer;
  closeAfterResponse: boolean;
}

/** Parse and dispatch as many complete requests as the buffer holds. */
function drain(conn: Connection, dispatch: Dispatcher): void {
  for (;;) {
    const buf = conn.buffer;
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      if (buf.length > MAX_HEADER_BYTES) {
        conn.socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
        conn.buffer = Buffer.alloc(0);
      }
      return;
    }
    const headText = buf.subarray(0, headerEnd).toString('ascii');
    const lines = headText.split('\r\n');
    const requestLine = lines[0] ?? '';
    const parts = requestLine.split(' ');
    if (parts.length < 3 || !parts[0] || !parts[1]) {
      conn.socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      conn.buffer = Buffer.alloc(0);
      return;
    }
    const method = parts[0];
    const target = parts[1];
    const headers = new Map<string, string>();
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const existing = headers.get(name);
      headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
    }
    const connectionHeader = (headers.get('connection') ?? '').toLowerCase();
    const closeAfter = connectionHeader.includes('close');
    // A client waiting on 100-continue will not send the body until it gets
    // one; answer immediately so it can proceed.
    if ((headers.get('expect') ?? '').toLowerCase() === '100-continue') {
      conn.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
    let bodyStart = headerEnd + 4;
    let body: Buffer;
    let next: number;
    const transferEncoding = (headers.get('transfer-encoding') ?? '').toLowerCase();
    if (transferEncoding.includes('chunked')) {
      const parsed = parseChunked(buf, bodyStart);
      if (parsed === null) return; // wait for more data
      body = parsed.body;
      next = bodyStart + parsed.consumed;
    } else {
      const contentLength = Number(headers.get('content-length') ?? '0');
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        conn.socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
        conn.buffer = Buffer.alloc(0);
        return;
      }
      if (contentLength > MAX_BODY_BYTES) {
        conn.socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
        conn.buffer = Buffer.alloc(0);
        return;
      }
      if (buf.length < bodyStart + contentLength) return; // wait for more data
      body = buf.subarray(bodyStart, bodyStart + contentLength);
      next = bodyStart + contentLength;
    }
    conn.buffer = buf.subarray(next);
    conn.closeAfterResponse = closeAfter;
    const { path, query } = splitTarget(target);
    const req: TransportRequest = { method, target, path, query, headers, body };
    const res = new Response(conn.socket);
    try {
      dispatch(req, res);
    } catch {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message: 'internal error' }));
      } catch {
        // The socket is gone; nothing more to do.
      }
    }
    if (conn.closeAfterResponse) {
      conn.socket.end();
      conn.buffer = Buffer.alloc(0);
      return;
    }
    // Loop: the buffer may already hold a pipelined request.
    if (conn.buffer.length === 0) return;
  }
}

export function createTransportServer(dispatch: Dispatcher): Server {
  const server = createServer((socket: Socket) => {
    const conn: Connection = { socket, buffer: Buffer.alloc(0), closeAfterResponse: false };
    socket.on('data', (chunk: Buffer) => {
      conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
      drain(conn, dispatch);
    });
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    });
  });
  return server;
}
