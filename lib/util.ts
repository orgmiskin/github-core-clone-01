// Shared helpers for the forge: environment configuration, the fixed viewer
// identity, bearer-token auth and small byte utilities.
//
// The trial harness hands the entry three facts through the environment:
//   MAKEFUN_SHOP_TOKEN  the one bearer token the suite presents
//   MAKEFUN_TRIAL_SEED  the trial seed (unused here; kept for reference)
//   MAKEFUN_TRIAL_NOW   the trial's fixed opening time, the source of every
//                       timestamp the forge emits (never the wall clock, so a
//                       replay of the same requests produces the same bytes)
//
// The scenario is fixed forever (SCENARIO_SEED never changes), so the viewer
// the token names is always the same login in every trial.

import type { IncomingMessage } from 'node:http';

/** The login the trial token names, in every trial. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id. */
export const VIEWER_ID = 1000;
/** The viewer's display name. */
export const VIEWER_NAME = 'ada iversen';
/** The viewer's email, used as the identity on server-made commits. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The default branch every repository is created with. */
export const DEFAULT_BRANCH = 'main';

/** Fallback trial time when MAKEFUN_TRIAL_NOW is unset (local runs). */
const FALLBACK_NOW = '2026-11-15T00:00:00Z';

/** The environment the harness hands the entry. */
export interface ForgeConfig {
  /** The bearer token to accept, '' when the harness did not set one. */
  token: string;
  /** The trial seed, '' when unset. */
  seed: string;
  /** The trial's fixed time as an ISO-8601 UTC string. */
  nowIso: string;
  /** The same instant as unix seconds. */
  nowSec: number;
}

/** Read the harness environment once, at server creation. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const token = env.MAKEFUN_SHOP_TOKEN ?? '';
  const seed = env.MAKEFUN_TRIAL_SEED ?? '';
  const rawNow = env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = rawNow === '' ? NaN : Date.parse(rawNow);
  const nowMs = Number.isFinite(parsed) ? parsed : Date.parse(FALLBACK_NOW);
  const nowIso = new Date(nowMs).toISOString().replace('.000Z', 'Z');
  return { token, seed, nowIso, nowSec: Math.floor(nowMs / 1000) };
}

/**
 * Whether the request carries the trial token. When the harness set
 * MAKEFUN_SHOP_TOKEN the token must match it exactly; when it did not (a local
 * run outside the harness) any non-empty bearer token is accepted so the
 * server can still be exercised by hand.
 */
export function isAuthorized(req: IncomingMessage, config: ForgeConfig): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (config.token === '') return true;
  return token === config.token;
}

/** Base64 (standard alphabet) of a UTF-8 string. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 (standard alphabet) of raw bytes. */
export function b64encodeBytes(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Decode base64 content, ignoring the whitespace GitHub wraps it at. */
export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Whether `value` is a plain record (an object that is not an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A lowercased `owner/name` key, so repository lookup is case-insensitive. */
export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
