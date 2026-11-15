// Entry point: the conversation between this process and the trial
// environment. Everything the forge does lives in app.ts; this file only
// walks the process through its four moves:
//
//   1. Build the server and bind an ephemeral port. listen(0) lets the
//      kernel pick the port — 8080 belongs to the environment, never to us.
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register so the env knows
//      where to drive the forge. The env takes the address the request came
//      from, adds the port, and treats that as our base URL.
//   3. Poll GET $MAKEFUN_ENV_URL/done until the answer is {"done": true}.
//      The env answers right away either way, so this is a plain poll with
//      backoff; the process never leaves before the env says the trial is
//      over.
//   4. Close the server and exit 0.
//
// The environment's origin comes from MAKEFUN_ENV_URL. Without it there is
// nobody to register with, so the process gives up at once with exit 1.
// A failed request is retried with exponential backoff, except a 400 or 405
// from /register, which means the request itself broke the contract — that
// is fatal, because retrying the same broken request would never help.
//
// Nothing here reads the wall clock or rolls dice: the only time involved
// is how long to wait between retries, and that never reaches a request,
// so a replay of a trial behaves exactly like the live run.
//
// This is our own implementation of the lifecycle the kit's starter
// sketches: the same wire behavior, written fresh here so the entrypoint
// is ours.

import { createApp } from './app.ts';

/** The trial environment's origin, with any trailing slashes trimmed off. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

/** How long a single request to the env may run before it is abandoned. */
const REQUEST_BUDGET_MS = 30_000;
/** The pause after the first failed request; it doubles after each failure. */
const BACKOFF_FIRST_MS = 250;
/** The pause never grows past this, however many requests fail. */
const BACKOFF_CAP_MS = 2_000;
/** Doubling stops after this many failures; past that the pause is the cap. */
const BACKOFF_MAX_DOUBLINGS = 8;

/** A promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pause before the retry that follows `failures` failed requests. */
function backoffAfter(failures: number): number {
  const doublings = Math.min(failures, BACKOFF_MAX_DOUBLINGS);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** doublings);
}

/** Thrown when /register answers 400 or 405: a broken request, not a retry. */
class RegisterRejected extends Error {}

/**
 * Tell the env which port the forge bound. A 200 registers us; a 409 means
 * another process already registered, which we accept — the env drives the
 * first registration and this process simply waits its turn. A 400 or 405
 * is a contract violation and ends the program. Anything else (a dropped
 * connection, a timeout, another status) is retried: the env may still be
 * starting, and a retry costs nothing.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new RegisterRejected(`the env rejected the register with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof RegisterRejected) throw err;
    }
    await delay(backoffAfter(failures));
    failures += 1;
  }
}

/**
 * Ask the env whether the trial is over, until it says yes. A poll that
 * fails or times out is not an answer, so it is retried; a 200 whose body
 * is not {"done": true} just means the suite is still running.
 */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the poll ran out of time: the trial goes on.
    }
    await delay(backoffAfter(failures));
    failures += 1;
  }
}

/**
 * Bind the server to a port the kernel picks and hand that port back.
 * The server starts unbound; this is the step that puts it on the wire.
 */
async function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  return bound.port;
}

/** The whole life of the process: bind, register, wait, shut down. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] forge bound to port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered with the env; waiting for the trial to end\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] the env says done; shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
