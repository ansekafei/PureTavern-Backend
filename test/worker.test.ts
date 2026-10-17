/**
 * Contract tests for the PureTavern Cloudflare Worker proxy.
 *
 * The assertions mirror the frontend's expectations in
 * `apps/web/src/features/generation/infrastructure/remote-backend-client.ts`: the health handshake must
 * identify protocol `pure-tavern-generation-proxy` v1, the proxy endpoint must accept exactly the
 * envelope the client builds, and SSE bodies must stream through unbuffered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import { REMOTE_BACKEND_PROTOCOL, REMOTE_BACKEND_PROTOCOL_VERSION } from '../src/protocol';

const ACCESS_KEY = 'test-access-key-0123456789';

const env: Env = {
  PURE_TAVERN_PROXY_KEY: ACCESS_KEY,
  PURE_TAVERN_ALLOWED_ORIGINS: '*',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: REMOTE_BACKEND_PROTOCOL,
    protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
    request: {
      url: 'https://api.example.com/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer provider-key' },
      body: JSON.stringify({ model: 'test', stream: true }),
    },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://proxy.example.workers.dev/v1/proxy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function health(headers: Record<string, string> = {}): Request {
  return new Request('https://proxy.example.workers.dev/v1/health', {
    method: 'GET',
    headers: { Authorization: `Bearer ${ACCESS_KEY}`, ...headers },
  });
}

describe('GET /v1/health', () => {
  it('returns the protocol handshake the frontend requires', async () => {
    const response = await worker.fetch(health(), env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      service: 'pure-tavern-remote-backend',
      protocol: 'pure-tavern-generation-proxy',
      protocolVersion: 1,
    });
    expect(response.headers.get('X-Pure-Tavern-Proxy')).toBe('1');
  });

  it('rejects a wrong access key with 401 and a Bearer challenge', async () => {
    const response = await worker.fetch(
      health({ Authorization: 'Bearer definitely-wrong' }),
      env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(response.headers.get('X-Pure-Tavern-Proxy-Error')).toBe('authentication');
  });

  it('rejects a missing Authorization header', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/health');
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const response = await worker.fetch(health({ Authorization: `Basic ${ACCESS_KEY}` }), env);
    expect(response.status).toBe(401);
  });

  it('fails closed when the deployment secret is missing', async () => {
    const response = await worker.fetch(health(), { PURE_TAVERN_PROXY_KEY: '' });
    expect(response.status).toBe(500);
    expect(response.headers.get('X-Pure-Tavern-Proxy-Error')).toBe('configuration');
  });
});

describe('CORS', () => {
  it('answers preflight without authentication', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/proxy', {
      method: 'OPTIONS',
      headers: { Origin: 'https://tavern.example.com' },
    });
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
      'X-Pure-Tavern-Proxy-Error',
    );
  });

  it('echoes a specific allowed origin and varies on it', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/health', {
      method: 'GET',
      headers: { Origin: 'https://tavern.example.com', Authorization: `Bearer ${ACCESS_KEY}` },
    });
    const response = await worker.fetch(request, {
      ...env,
      PURE_TAVERN_ALLOWED_ORIGINS: 'https://tavern.example.com',
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://tavern.example.com',
    );
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('omits the allow-origin header for an origin outside the allowlist', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/health', {
      method: 'GET',
      headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${ACCESS_KEY}` },
    });
    const response = await worker.fetch(request, {
      ...env,
      PURE_TAVERN_ALLOWED_ORIGINS: 'https://tavern.example.com',
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('POST /v1/proxy — envelope validation', () => {
  const invalid: Array<[string, unknown]> = [
    ['wrong protocol name', envelope({ protocol: 'something-else' })],
    ['wrong protocol version', envelope({ protocolVersion: 2 })],
    ['missing protocolVersion', { protocol: REMOTE_BACKEND_PROTOCOL, request: {} }],
    ['extra top-level key', envelope({ extra: true })],
    [
      'unsupported method',
      envelope({ request: { url: 'https://a.example.com', method: 'DELETE', headers: {} } }),
    ],
    [
      'non-http scheme',
      envelope({ request: { url: 'file:///etc/passwd', method: 'GET', headers: {} } }),
    ],
    [
      'embedded credentials',
      envelope({
        request: { url: 'https://user:pw@a.example.com', method: 'GET', headers: {} },
      }),
    ],
    [
      'fragment in url',
      envelope({ request: { url: 'https://a.example.com/#frag', method: 'GET', headers: {} } }),
    ],
    [
      'GET with a body',
      envelope({ request: { url: 'https://a.example.com', method: 'GET', headers: {}, body: 'x' } }),
    ],
    [
      'non-string header value',
      envelope({ request: { url: 'https://a.example.com', method: 'GET', headers: { a: 1 } } }),
    ],
    [
      'invalid header name',
      envelope({
        request: { url: 'https://a.example.com', method: 'GET', headers: { 'bad name': 'v' } },
      }),
    ],
    ['malformed JSON', '{not json'],
  ];

  it.each(invalid)('rejects %s with 422', async (_label, payload) => {
    const response = await worker.fetch(post(payload), env);
    expect(response.status).toBe(422);
    expect(response.headers.get('X-Pure-Tavern-Proxy-Error')).toBe('request');
  });

  it('rejects an unauthenticated proxy call before validating the envelope', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope()),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/proxy — forwarding', () => {
  it('forwards the exact upstream URL, method and body, then relays the JSON response', async () => {
    const seen: Array<{ url: string; method: string; body: string | undefined }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body as string | undefined,
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body!)).toEqual({ model: 'test', stream: true });
    expect(response.headers.get('X-Pure-Tavern-Proxy')).toBe('1');
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'hi' } }] });
  });

  it('streams an SSE body through without buffering it whole', async () => {
    const encoder = new TextEncoder();
    const frames = ['data: {"delta":"a"}\n\n', 'data: {"delta":"b"}\n\n', 'data: [DONE]\n\n'];

    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const text = await response.text();
    expect(text).toBe(frames.join(''));
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('strips hop-by-hop and edge-managed headers from the relayed response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'provider=session; Path=/',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': 'https://not-our-origin.example',
          },
        }),
    ) as typeof fetch;

    const response = await worker.fetch(
      post(envelope(), { Origin: 'https://tavern.example.com' }),
      env,
    );
    expect(response.headers.get('Set-Cookie')).toBeNull();
    // The upstream's own Access-Control-Allow-Origin is dropped and the Worker's own CORS value wins,
    // so a provider cannot widen access to the proxy deployment.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Transfer-Encoding')).toBeNull();
  });

  it('does not forward a client-supplied Host, Content-Length or Accept-Encoding', async () => {
    let forwarded: Headers | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const payload = envelope({
      request: {
        url: 'https://api.example.com/v1/chat/completions',
        method: 'POST',
        headers: {
          Host: 'attacker.example.com',
          'Content-Length': '999',
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    });

    await worker.fetch(post(payload), env);

    expect(forwarded!.get('host')).toBeNull();
    expect(forwarded!.get('content-length')).toBeNull();
    expect(forwarded!.get('accept-encoding')).toBe('identity');
    expect(forwarded!.get('content-type')).toBe('application/json');
  });

  it('follows a same-origin redirect and keeps the provider key', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://api.example.com/v2/chat/completions' },
        });
      }
      const headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ auth: headers.get('authorization') }), { status: 200 });
    }) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe('https://api.example.com/v2/chat/completions');
    expect(await response.json()).toMatchObject({ auth: 'Bearer provider-key' });
  });

  it('drops credentials when a redirect crosses origins', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.example.com')) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://cdn.other.example/v2/chat' },
        });
      }
      const headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          authorization: headers.get('authorization'),
          cookie: headers.get('cookie'),
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const payload = envelope({
      request: {
        url: 'https://api.example.com/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: 'Bearer provider-key', Cookie: 'session=1' },
        body: '{}',
      },
    });

    const response = await worker.fetch(post(payload), env);
    expect(await response.json()).toEqual({ authorization: null, cookie: null });
  });

  it('degrades a POST to GET on a 302 redirect', async () => {
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (String(input).includes('/v1/chat')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://api.example.com/final' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await worker.fetch(post(envelope()), env);
    expect(methods).toEqual(['POST', 'GET']);
  });

  it('returns 502 when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);
    expect(response.status).toBe(502);
    expect(response.headers.get('X-Pure-Tavern-Proxy-Error')).toBe('upstream');
  });

  it('gives up after too many redirects', async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      count += 1;
      return new Response(null, {
        status: 307,
        headers: { Location: `${String(input)}?hop=${count}` },
      });
    }) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);
    expect(response.status).toBe(502);
    expect(count).toBe(11); // initial attempt + 10 redirects
  });

  it('relays a provider error status verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'bad model' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch;

    const response = await worker.fetch(post(envelope()), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'bad model' } });
  });

  it('returns 204 with no body for a bodyless upstream status', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const response = await worker.fetch(post(envelope()), env);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe('routing', () => {
  it('returns 404 for an unknown route', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/nope', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACCESS_KEY}` },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
  });

  it('does not accept GET on the proxy route', async () => {
    const request = new Request('https://proxy.example.workers.dev/v1/proxy', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACCESS_KEY}` },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(404);
  });
});
