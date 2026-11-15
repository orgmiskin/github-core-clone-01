// The forge server: one in-memory store, four surfaces, one dispatcher.
//
// main.ts owns the entry <-> env lifecycle (bind, register, poll /done);
// this file is the server. createApp() builds one Forge and
// one HTTP server; every request is read once and then dispatched by path:
//
//   GET  /healthz        the env's boot probe: 200 {"ok":true}, no auth
//   /api/v3/*            REST v3 (lib/rest.ts)
//   /api/graphql         GraphQL v4 (lib/graphql.ts)
//   /mcp                 MCP over JSON-RPC (lib/mcp.ts)
//   /{owner}/{repo}.git/* git smart HTTP (lib/githttp.ts)
//
// Anything else is a JSON 404, never HTML and never a bare connection drop:
// a conformance suite treats an unexplained close as a crash. A handler that
// throws answers 500 with a JSON {message} and the server keeps running —
// one malformed request must not cost the whole trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { loadConfig } from './lib/util.ts';
import { readBody, sendError, sendJson } from './lib/http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGit } from './lib/githttp.ts';

/** The path and query of a request URL, or '/' when it does not parse.
 *
 * Origin-form URLs — everything the env and the suite send — are split by
 * hand: the URL constructor is correct but needlessly expensive on a hot
 * path (two thousand sequential reads). Anything unusual falls back to it. */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  if (raw.startsWith('/') && !raw.includes(' ')) {
    const question = raw.indexOf('?');
    if (question === -1) return { pathname: raw, query: EMPTY_QUERY };
    return { pathname: raw.slice(0, question), query: new URLSearchParams(raw.slice(question + 1)) };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: EMPTY_QUERY };
  }
}

/** One shared empty query set: most requests carry no query string. */
const EMPTY_QUERY = new URLSearchParams();

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(loadConfig());
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname, query } = parseUrl(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}, no auth, no body to read.
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(forge, res, 200, { ok: true });
      return;
    }

    // Everything else reads its body once, then dispatches by path.
    readBody(req)
      .then((body) => {
        if (handleRest(forge, req, res, pathname, query, body)) return;
        if (handleGraphQL(forge, req, res, pathname, body)) return;
        if (handleMcp(forge, req, res, pathname, body)) return;
        if (handleGit(forge, req, res, pathname, query, body)) return;
        sendError(forge, res, 404, 'Not Found');
      })
      .catch((err: unknown) => {
        // A body read that failed, or a handler that threw: answer 500 and stay up.
        if (res.writableEnded) return;
        const message = err instanceof Error && err.message === 'request body too large' ? 'Request Entity Too Large' : 'Internal Server Error';
        sendError(forge, res, err instanceof Error && err.message === 'request body too large' ? 413 : 500, message);
      });
  });
}
