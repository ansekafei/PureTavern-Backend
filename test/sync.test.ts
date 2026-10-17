/**
 * Sync vault tests.
 *
 * These run against the real Worker handler with an in-memory R2 stand-in, so they cover the actual
 * routing, token verification and account isolation rather than a mock of them.
 */

import { describe, expect, it } from 'vitest';

import worker, { type Env } from '../src/index';
import { FakeR2Bucket } from './fake-r2';

const SYNC_SECRET = 'test-sync-secret-do-not-use-in-production';
const PROXY_KEY = 'test-proxy-key';

function makeEnv(bucket = new FakeR2Bucket()): Env {
  return {
    PURE_TAVERN_PROXY_KEY: PROXY_KEY,
    PURE_TAVERN_ALLOWED_ORIGINS: 'https://tavern.example.com',
    PURE_TAVERN_SYNC_SECRET: SYNC_SECRET,
    PURE_TAVERN_SYNC_BUCKET: bucket as unknown as R2Bucket,
  };
}

/** 64 lowercase hex chars, shaped like the client's verifier output. */
function verifier(seed: string): string {
  return seed
    .repeat(64)
    .slice(0, 64)
    .toLowerCase()
    .replace(/[^a-f0-9]/gu, 'a');
}

function post(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://backend.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
    ...init,
  });
}

function authed(
  path: string,
  method: string,
  token: string,
  body?: ArrayBuffer,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://backend.example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(body ? { body } : {}),
  });
}

async function register(username: string, ver: string, env: Env) {
  const response = await worker.fetch(
    post('/v1/sync/register', { username, verifier: ver }),
    env,
  );
  return { response, payload: (await response.json()) as { token: string; accountId: string } };
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('sync vault', () => {
  it('reports not-configured when the bucket binding is absent', async () => {
    const env = makeEnv();
    delete env.PURE_TAVERN_SYNC_BUCKET;
    const response = await worker.fetch(post('/v1/sync/login', { username: 'abc', verifier: verifier('a') }), env);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'sync-not-configured',
    );
  });

  it('registers an account and returns a usable session token', async () => {
    const env = makeEnv();
    const { response, payload } = await register('coffee', verifier('a'), env);
    expect(response.status).toBe(201);
    expect(payload.token.split('.')).toHaveLength(3);
    expect(payload.accountId).toMatch(/^[a-f0-9]{64}$/u);

    const index = await worker.fetch(authed('/v1/sync/index', 'GET', payload.token), env);
    expect(index.status).toBe(404);
  });

  it('rejects a duplicate username', async () => {
    const env = makeEnv();
    await register('coffee', verifier('a'), env);
    const second = await worker.fetch(
      post('/v1/sync/register', { username: 'coffee', verifier: verifier('b') }),
      env,
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('account-exists');
  });

  it('normalises username case so Coffee and coffee collide', async () => {
    const env = makeEnv();
    await register('coffee', verifier('a'), env);
    const second = await worker.fetch(
      post('/v1/sync/register', { username: 'COFFEE', verifier: verifier('a') }),
      env,
    );
    expect(second.status).toBe(409);
  });

  it('logs in with the matching verifier and refuses a wrong one', async () => {
    const env = makeEnv();
    await register('coffee', verifier('a'), env);

    const ok = await worker.fetch(post('/v1/sync/login', { username: 'coffee', verifier: verifier('a') }), env);
    expect(ok.status).toBe(200);

    const bad = await worker.fetch(post('/v1/sync/login', { username: 'coffee', verifier: verifier('b') }), env);
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid-credentials');
  });

  it('gives the same 401 for an unknown account as for a wrong verifier', async () => {
    const env = makeEnv();
    const unknown = await worker.fetch(
      post('/v1/sync/login', { username: 'nobody', verifier: verifier('a') }),
      env,
    );
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'invalid-credentials',
    );
  });

  it('refuses every vault route without a token', async () => {
    const env = makeEnv();
    for (const [method, path] of [
      ['GET', '/v1/sync/index'],
      ['PUT', '/v1/sync/index'],
      ['GET', '/v1/sync/objects/abcdefgh'],
      ['DELETE', '/v1/sync/objects/abcdefgh'],
    ] as const) {
      const response = await worker.fetch(new Request(`https://backend.example.com${path}`, { method }), env);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const env = makeEnv();
    const { payload } = await register('coffee', verifier('a'), env);

    // Same bucket, different HMAC key — i.e. the operator rotated PURE_TAVERN_SYNC_SECRET.
    const rotated: Env = { ...env, PURE_TAVERN_SYNC_SECRET: 'a-different-signing-secret' };
    const response = await worker.fetch(authed('/v1/sync/index', 'GET', payload.token), rotated);
    expect(response.status).toBe(401);
  });

  it('round-trips the encrypted index', async () => {
    const env = makeEnv();
    const { payload } = await register('coffee', verifier('a'), env);

    const put = await worker.fetch(
      authed('/v1/sync/index', 'PUT', payload.token, bytes('ciphertext-index')),
      env,
    );
    expect(put.status).toBe(204);

    const get = await worker.fetch(authed('/v1/sync/index', 'GET', payload.token), env);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(await get.text()).toBe('ciphertext-index');
  });

  it('round-trips an encrypted object and deletes it', async () => {
    const env = makeEnv();
    const { payload } = await register('coffee', verifier('a'), env);

    const put = await worker.fetch(
      authed('/v1/sync/objects/backup-0001', 'PUT', payload.token, bytes('sealed-archive')),
      env,
    );
    expect(put.status).toBe(204);

    const get = await worker.fetch(authed('/v1/sync/objects/backup-0001', 'GET', payload.token), env);
    expect(await get.text()).toBe('sealed-archive');

    const del = await worker.fetch(
      authed('/v1/sync/objects/backup-0001', 'DELETE', payload.token),
      env,
    );
    expect(del.status).toBe(204);

    const gone = await worker.fetch(authed('/v1/sync/objects/backup-0001', 'GET', payload.token), env);
    expect(gone.status).toBe(404);

    const delAgain = await worker.fetch(
      authed('/v1/sync/objects/backup-0001', 'DELETE', payload.token),
      env,
    );
    expect(delAgain.status).toBe(404);
  });

  it('keeps two accounts fully isolated', async () => {
    const bucket = new FakeR2Bucket();
    const env = makeEnv(bucket);

    const alice = await register('alice', verifier('a'), env);
    const bob = await register('bob', verifier('b'), env);

    await worker.fetch(authed('/v1/sync/objects/backup-0001', 'PUT', alice.payload.token, bytes('alice-data')), env);
    await worker.fetch(authed('/v1/sync/objects/backup-0001', 'PUT', bob.payload.token, bytes('bob-data')), env);

    const aliceRead = await worker.fetch(
      authed('/v1/sync/objects/backup-0001', 'GET', alice.payload.token),
      env,
    );
    expect(await aliceRead.text()).toBe('alice-data');

    const bobRead = await worker.fetch(
      authed('/v1/sync/objects/backup-0001', 'GET', bob.payload.token),
      env,
    );
    expect(await bobRead.text()).toBe('bob-data');

    // The two blobs live under different prefixes rather than overwriting each other.
    expect(bucket.keys().filter((key) => key.endsWith('obj/backup-0001.enc'))).toHaveLength(2);
  });

  it('rejects object ids that could escape the account prefix', async () => {
    const env = makeEnv();
    const { payload } = await register('coffee', verifier('a'), env);

    for (const bad of ['..%2F..%2Fauth', 'short', 'a'.repeat(65), 'has/slash']) {
      const response = await worker.fetch(
        authed(`/v1/sync/objects/${encodeURIComponent(bad)}`, 'GET', payload.token),
        env,
      );
      expect([400, 404], `id=${bad}`).toContain(response.status);
    }
  });

  it('validates registration payloads', async () => {
    const env = makeEnv();
    const cases: Array<[string, unknown]> = [
      ['too short', { username: 'ab', verifier: verifier('a') }],
      ['illegal chars', { username: 'cof fee', verifier: verifier('a') }],
      ['short verifier', { username: 'coffee', verifier: 'abc' }],
      ['non-hex verifier', { username: 'coffee', verifier: 'z'.repeat(64) }],
      ['missing verifier', { username: 'coffee' }],
    ];

    for (const [label, body] of cases) {
      const response = await worker.fetch(post('/v1/sync/register', body), env);
      expect(response.status, label).toBe(400);
    }
  });

  it('exposes PUT and DELETE in CORS preflight for sync routes only', async () => {
    const env = makeEnv();

    const syncPreflight = await worker.fetch(
      new Request('https://backend.example.com/v1/sync/index', {
        method: 'OPTIONS',
        headers: { origin: 'https://tavern.example.com' },
      }),
      env,
    );
    expect(syncPreflight.headers.get('access-control-allow-methods')).toBe('GET, PUT, DELETE, OPTIONS');
    expect(syncPreflight.headers.get('access-control-allow-origin')).toBe('https://tavern.example.com');

    const proxyPreflight = await worker.fetch(
      new Request('https://backend.example.com/v1/proxy', {
        method: 'OPTIONS',
        headers: { origin: 'https://tavern.example.com' },
      }),
      env,
    );
    expect(proxyPreflight.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  it('does not leak sync responses to an unlisted origin', async () => {
    const env = makeEnv();
    const response = await worker.fetch(
      new Request('https://backend.example.com/v1/sync/login', {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'coffee', verifier: verifier('a') }),
      }),
      env,
    );
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the proxy contract working alongside sync', async () => {
    const env = makeEnv();
    const health = await worker.fetch(
      new Request('https://backend.example.com/v1/health', {
        headers: { authorization: `Bearer ${PROXY_KEY}` },
      }),
      env,
    );
    expect(health.status).toBe(200);
    expect(((await health.json()) as { protocol: string }).protocol).toBe(
      'pure-tavern-generation-proxy',
    );
  });
});
