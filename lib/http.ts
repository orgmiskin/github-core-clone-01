// Shared HTTP plumbing: reading request bodies and answering with JSON or
// raw bytes. Every JSON answer carries a non-empty X-GitHub-Request-Id, as
// the protocol checks require of every REST reply (including errors).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The largest request body accepted (packs stay well under this). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request's whole body, rejecting past the size cap.
 *
 * A request that cannot carry a body (GET/HEAD, or an explicit
 * Content-Length of 0) resolves at once with an empty buffer: no listener
 * dance, no extra event-loop turn. That is the read workload's hot path —
 * two thousand sequential GETs — and the git advertisement's. */
export function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || req.headers['content-length'] === '0') {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Answer with a JSON body and the request-id header. */
export function sendJson(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Answer with a pre-serialized JSON string (the read workload's hot path). */
export function sendJsonText(
  forge: Forge,
  res: ServerResponse,
  status: number,
  text: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Answer with a JSON error body: {"message": ...}. */
export function sendError(
  forge: Forge,
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendJson(forge, res, status, { message }, extraHeaders);
}

/** Answer with raw bytes and a caller-chosen content type. */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}
