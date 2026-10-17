/**
 * Sync vault HTTP surface.
 *
 * Seven routes, all under `/v1/sync`. Registration and login are the only unauthenticated ones;
 * everything else requires a session token from `token.ts`.
 *
 * The server never sees a passphrase and never sees plaintext. It stores:
 *   - a verifier hash (proves the caller knows the passphrase, cannot be replayed into a decryption)
 *   - opaque ciphertext blobs
 *
 * Because the encryption key is derived from the passphrase on the device, an attacker who obtains a
 * valid session token can overwrite or delete a vault, but cannot read it. That is the trade the user
 * asked for: "别让别人拿到我的数据".
 */

import { issueToken, verifyToken } from './token';
import {
  createSyncStore,
  isValidObjectId,
  sha256Hex,
  type AccountRecord,
  type SyncStore,
} from './store';

export const SYNC_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/u;
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SyncEnv {
  PURE_TAVERN_SYNC_SECRET?: string;
  PURE_TAVERN_SYNC_BUCKET?: R2Bucket;
}

interface SyncContext {
  request: Request;
  url: URL;
  env: SyncEnv;
  cors: Headers;
}

/** Returns `null` when the path is not a sync route, so the caller can fall through to 404. */
export async function handleSyncRoute(context: SyncContext): Promise<Response | null> {
  const { request, url, env } = context;
  const path = url.pathname;

  if (!path.startsWith('/v1/sync/')) return null;

  const secret = env.PURE_TAVERN_SYNC_SECRET ?? '';
  const bucket = env.PURE_TAVERN_SYNC_BUCKET;

  if (!secret || !bucket) {
    return json(500, {
      error: { code: 'sync-not-configured', message: 'Sync storage or signing secret is missing.' },
    });
  }

  const store = createSyncStore(bucket);

  if (request.method === 'POST' && path === '/v1/sync/register') {
    return register(request, store, secret);
  }

  if (request.method === 'POST' && path === '/v1/sync/login') {
    return login(request, store, secret);
  }

  // Everything below needs a session.
  const authorization = request.headers.get('authorization');
  const bearer = /^Bearer (.+)$/iu.exec(authorization ?? '')?.[1];
  const claims = await verifyToken(bearer, secret);
  if (!claims) {
    return json(
      401,
      { error: { code: 'unauthorized', message: 'A valid sync session token is required.' } },
      { 'WWW-Authenticate': 'Bearer' },
    );
  }

  if (path === '/v1/sync/index') {
    if (request.method === 'GET') {
      const body = await store.getIndex(claims.sub);
      if (!body) return new Response(null, { status: 404 });
      return ciphertext(body);
    }
    if (request.method === 'PUT') {
      const body = await readLimited(request, SYNC_MAX_OBJECT_BYTES);
      if (!body) return payloadTooLarge();
      await store.putIndex(claims.sub, body);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed('GET, PUT, OPTIONS');
  }

  const objectMatch = /^\/v1\/sync\/objects\/([^/]+)$/u.exec(path);
  if (objectMatch) {
    const objectId = objectMatch[1]!;
    if (!isValidObjectId(objectId)) {
      return json(400, {
        error: { code: 'invalid-object-id', message: 'Object ids are 8-64 URL-safe characters.' },
      });
    }

    if (request.method === 'GET') {
      const body = await store.getObject(claims.sub, objectId);
      if (!body) return new Response(null, { status: 404 });
      return ciphertext(body);
    }
    if (request.method === 'PUT') {
      const body = await readLimited(request, SYNC_MAX_OBJECT_BYTES);
      if (!body) return payloadTooLarge();
      await store.putObject(claims.sub, objectId, body);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE') {
      const removed = await store.deleteObject(claims.sub, objectId);
      return new Response(null, { status: removed ? 204 : 404 });
    }
    return methodNotAllowed('GET, PUT, DELETE, OPTIONS');
  }

  return json(404, {
    error: { code: 'not-found', message: 'The requested sync route does not exist.' },
  });
}

async function register(request: Request, store: SyncStore, secret: string): Promise<Response> {
  const credentials = await readCredentials(request);
  if (credentials instanceof Response) return credentials;

  const { username, verifier } = credentials;
  const accountId = await accountIdFor(username);

  const record: AccountRecord = {
    accountId,
    username,
    verifier: await sha256Hex(verifier),
    createdAt: new Date().toISOString(),
  };

  const created = await store.createAccount(record);
  if (!created) {
    return json(409, {
      error: { code: 'account-exists', message: 'That username is already registered.' },
    });
  }

  const token = await issueToken({ sub: accountId, name: username }, secret, {
    ttlSeconds: TOKEN_TTL_SECONDS,
  });
  return json(201, { token, username, accountId });
}

async function login(request: Request, store: SyncStore, secret: string): Promise<Response> {
  const credentials = await readCredentials(request);
  if (credentials instanceof Response) return credentials;

  const { username, verifier } = credentials;
  const accountId = await accountIdFor(username);
  const record = await store.getAccount(accountId);

  // Same response for "no such account" and "wrong verifier" so the endpoint is not a username oracle.
  const expected = record?.verifier ?? '';
  const supplied = await sha256Hex(verifier);
  if (!expected || !constantTimeEqual(expected, supplied)) {
    return json(401, {
      error: { code: 'invalid-credentials', message: 'Incorrect username or passphrase.' },
    });
  }

  const token = await issueToken({ sub: accountId, name: username }, secret, {
    ttlSeconds: TOKEN_TTL_SECONDS,
  });
  return json(200, { token, username, accountId });
}

type Credentials = { username: string; verifier: string };

async function readCredentials(request: Request): Promise<Credentials | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Body must be JSON.');
  }
  if (typeof body !== 'object' || body === null) return badRequest('Body must be a JSON object.');

  const record = body as Record<string, unknown>;
  const username = typeof record.username === 'string' ? record.username.trim().toLowerCase() : '';
  const verifier = typeof record.verifier === 'string' ? record.verifier.trim().toLowerCase() : '';

  if (!USERNAME_PATTERN.test(username)) {
    return badRequest('Username must be 3-32 chars: a-z, 0-9, dot, dash or underscore.');
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    return badRequest('Verifier must be 64 lowercase hex characters.');
  }
  return { username, verifier };
}

async function accountIdFor(username: string): Promise<string> {
  return sha256Hex(`pure-tavern-sync-account:v1:${username}`);
}

async function readLimited(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > limit) return null;

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) return null;
  return buffer;
}

function ciphertext(body: ArrayBuffer): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function badRequest(message: string): Response {
  return json(400, { error: { code: 'invalid-credentials', message } });
}

function payloadTooLarge(): Response {
  return json(413, {
    error: {
      code: 'payload-too-large',
      message: `Encrypted objects are limited to ${SYNC_MAX_OBJECT_BYTES} bytes.`,
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return json(405, { error: { code: 'method-not-allowed', message: 'Method not allowed.' } }, { allow });
}
