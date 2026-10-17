/**
 * PureTavern remote backend — Cloudflare Workers entry point.
 *
 * Implements the `pure-tavern-generation-proxy` v1 contract that the PureTavern Web frontend expects:
 *
 *   GET  /v1/health  → protocol handshake, Bearer-authenticated
 *   POST /v1/proxy   → forward one fully-formed provider request, Bearer-authenticated
 *   OPTIONS *        → CORS preflight
 *
 * The Worker is transport-only. Provider selection, header/body construction and response parsing all
 * happen in the browser; nothing here knows what OpenAI or Anthropic look like. That keeps the
 * deployment a single edge script with no provider churn when upstream adds a new API.
 */

import { buildCorsHeaders, isAuthorized, parseAllowedOrigins, withCors } from './auth';
import { buildProxyResponse, executeProxyRequest } from './proxy';
import {
  InvalidProxyRequestError,
  MAX_ENVELOPE_BYTES,
  PROXY_ERROR_HEADER,
  PROXY_HEADER,
  REMOTE_BACKEND_PROTOCOL,
  REMOTE_BACKEND_PROTOCOL_VERSION,
  UpstreamProxyError,
  validateEnvelope,
} from './protocol';

export interface Env {
  /** Required. Bearer access key the frontend must present. Set with `wrangler secret put`. */
  PURE_TAVERN_PROXY_KEY: string;
  /** Optional. Comma-separated origin allowlist; empty or `*` allows any origin. */
  PURE_TAVERN_ALLOWED_ORIGINS?: string;
}

const HEALTH_BODY = {
  status: 'ok',
  service: 'pure-tavern-remote-backend',
  protocol: REMOTE_BACKEND_PROTOCOL,
  protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigins = parseAllowedOrigins(env.PURE_TAVERN_ALLOWED_ORIGINS);
    const cors = buildCorsHeaders(request, {
      allowedOrigins,
      proxyHeaderName: PROXY_HEADER,
      proxyErrorHeaderName: PROXY_ERROR_HEADER,
    });

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 200 }), cors);
    }

    // A missing secret is a deployment error, not a client error. Fail closed with 500 and say so,
    // because a Worker with an empty key would otherwise authenticate anyone who sends `Bearer `.
    const accessKey = String(env.PURE_TAVERN_PROXY_KEY ?? '').trim();
    if (!accessKey) {
      return withCors(
        jsonResponse(
          500,
          {
            error: {
              code: 'backend-misconfigured',
              message: 'PURE_TAVERN_PROXY_KEY is not configured on this deployment.',
            },
          },
          'configuration',
        ),
        cors,
      );
    }

    const authorized = await isAuthorized(request.headers.get('authorization'), accessKey);

    if (request.method === 'GET' && url.pathname === '/v1/health') {
      if (!authorized) return withCors(authenticationError(), cors);
      return withCors(jsonResponse(200, HEALTH_BODY), cors);
    }

    if (request.method === 'POST' && url.pathname === '/v1/proxy') {
      if (!authorized) return withCors(authenticationError(), cors);
      return withCors(await handleProxy(request), cors);
    }

    return withCors(
      jsonResponse(
        404,
        {
          error: {
            code: 'not-found',
            message: 'The requested remote backend route does not exist.',
          },
        },
        'request',
      ),
      cors,
    );
  },
} satisfies ExportedHandler<Env>;

async function handleProxy(request: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    return jsonResponse(
      413,
      {
        error: {
          code: 'payload-too-large',
          message: `The proxy envelope exceeds ${MAX_ENVELOPE_BYTES} bytes.`,
        },
      },
      'request',
    );
  }

  let target;
  try {
    target = validateEnvelope(JSON.parse(raw) as unknown);
  } catch {
    return jsonResponse(
      422,
      {
        error: {
          code: 'invalid-proxy-request',
          message: 'The proxy request does not match protocol version 1.',
        },
      },
      'request',
    );
  }

  // The client's own AbortSignal is surfaced by the runtime as request.signal, so a user hitting
  // "stop" in the UI cancels the upstream fetch instead of burning tokens to completion.
  const signal = request.signal;

  let upstream: Response;
  try {
    upstream = await executeProxyRequest(target, signal);
  } catch (error) {
    if (signal.aborted) {
      return jsonResponse(
        499,
        { error: { code: 'aborted', message: 'The client aborted the proxied request.' } },
        'aborted',
      );
    }
    if (error instanceof InvalidProxyRequestError) {
      return jsonResponse(
        422,
        {
          error: {
            code: 'invalid-proxy-request',
            message: 'The proxy request does not match protocol version 1.',
          },
        },
        'request',
      );
    }
    if (error instanceof UpstreamProxyError) {
      return jsonResponse(
        502,
        {
          error: {
            code: 'upstream-unreachable',
            message: 'The remote backend could not reach the upstream provider.',
          },
        },
        'upstream',
      );
    }
    return jsonResponse(
      502,
      {
        error: {
          code: 'upstream-unreachable',
          message: 'The remote backend could not reach the upstream provider.',
        },
      },
      'upstream',
    );
  }

  // `buildProxyResponse` hands back upstream.body untouched, so SSE frames are streamed to the client
  // as they arrive rather than buffered — this is what makes token-by-token output work.
  return buildProxyResponse(upstream, PROXY_HEADER);
}

/**
 * Reads the envelope with a hard byte ceiling. `arrayBuffer()` would buffer an unbounded body, so the
 * declared Content-Length is checked first and the streamed size is checked again while reading.
 */
async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) {
    throw new RangeError('declared content-length exceeds the envelope ceiling');
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ENVELOPE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('streamed envelope exceeds the ceiling');
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function authenticationError(): Response {
  const response = jsonResponse(
    401,
    { detail: 'Invalid remote backend access key.' },
    'authentication',
  );
  response.headers.set('WWW-Authenticate', 'Bearer');
  return response;
}

function jsonResponse(status: number, value: unknown, errorType: string | null = null): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    [PROXY_HEADER]: '1',
  });
  if (errorType) headers.set(PROXY_ERROR_HEADER, errorType);

  return new Response(JSON.stringify(value), { status, headers });
}
