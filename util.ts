// Small shared helpers: hashing, base64url, git pkt-lines, varints, zlib.
// Only Node built-ins; nothing here touches the network or the disk.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const AGENT = 'github-core-clone/1.0.0';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** SHA-1 of a git object header + content: the object's id. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, content]));
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function isSha1(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

/** One pkt-line: 4 hex digits of (payload length + 4) + the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer of pkt-lines into payloads; flush is null, delim is the string 'delim'. */
export function readPktLines(buf: Buffer): Array<Buffer | null | 'delim'> {
  const out: Array<Buffer | null | 'delim'> = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      out.push(null);
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push('delim');
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) break;
    out.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return out;
}

/** Parse the pkt-line text of a request body into lines (payloads as strings). */
export function pktTextLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const part of readPktLines(buf)) {
    if (Buffer.isBuffer(part)) lines.push(part.toString('utf8'));
  }
  return lines;
}

/** Git pack entry varint: type (3 bits) + size, little-endian 7-bit groups. */
export function encodeVarint(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size !== 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function zlibDeflateData(data: Buffer): Buffer {
  return zlibDeflate(data, { level: 6 });
}

export function zlibInflateData(data: Buffer): Buffer {
  return zlibInflate(data);
}
