/**
 * Protocol constants and envelope validation for the PureTavern remote backend.
 *
 * These rules are a deliberate mirror of `apps/web/src/features/generation/domain/remote-backend-protocol.ts`
 * in the upstream PureTavern repository, and of `apps/remote-server/nodejs/app.mjs`. The Cloudflare
 * Worker must accept exactly the envelopes the Web client emits and reject everything else, so the
 * validation here is intentionally strict: unknown keys, wrong types and non-http(s) targets all fail
 * with the same `422 invalid-proxy-request` response instead of being coerced.
 */

export const REMOTE_BACKEND_PROTOCOL = 'pure-tavern-generation-proxy';
export const REMOTE_BACKEND_PROTOCOL_VERSION = 1;

export const PROXY_HEADER = 'X-Pure-Tavern-Proxy';
export const PROXY_ERROR_HEADER = 'X-Pure-Tavern-Proxy-Error';

/** Hard ceiling for one proxy envelope. Matches the Node.js reference implementation. */
export const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;

export const MAX_REDIRECTS = 10;

export type ProxyMethod = 'GET' | 'POST';

export interface ProxyTarget {
  url: URL;
  method: ProxyMethod;
  headers: Record<string, string>;
  body: string | null;
}

export class InvalidProxyRequestError extends Error {
  constructor(message = 'The proxy request does not match protocol version 1.') {
    super(message);
    this.name = 'InvalidProxyRequestError';
  }
}

export class UpstreamProxyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamProxyError';
  }
}

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers the Worker refuses to forward upstream. `accept-encoding` is stripped because the
 * Cloudflare edge already negotiates compression and re-encodes the body, so forwarding the client's
 * value would make the upstream send a body we then mis-declare. `host` and `content-length` are
 * managed by the edge and cannot be set by a Worker subrequest at all.
 */
export const REQUEST_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'accept-encoding',
  'content-length',
  'host',
]);

/**
 * Headers the Worker refuses to copy back to the client. `content-encoding` is dropped because the
 * edge decompresses upstream bodies; `set-cookie` is dropped because the proxy is a stateless
 * transport and must never hand a provider cookie to the browser origin.
 */
export const RESPONSE_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length',
  'set-cookie',
  'set-cookie2',
]);

export const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
];

export const CONTENT_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
];

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Validates one decoded proxy envelope.
 *
 * The Web client always sends `{ protocol, protocolVersion, request: { url, method, headers, body } }`
 * with `body` present but possibly `null`. Extra keys are rejected rather than ignored so a future
 * client protocol bump fails loudly instead of being silently half-honoured.
 */
export function validateEnvelope(value: unknown): ProxyTarget {
  assertExactObject(value, ['protocol', 'protocolVersion', 'request']);

  const envelope = value as Record<string, unknown>;
  if (envelope.protocol !== REMOTE_BACKEND_PROTOCOL) throw new InvalidProxyRequestError();
  if (envelope.protocolVersion !== REMOTE_BACKEND_PROTOCOL_VERSION) {
    throw new InvalidProxyRequestError();
  }

  const request = envelope.request;
  assertExactObject(request, ['url', 'method'], ['headers', 'body']);

  const requestRecord = request as Record<string, unknown>;
  const method = requestRecord.method;
  if (method !== 'GET' && method !== 'POST') throw new InvalidProxyRequestError();

  const url = validateTargetUrl(requestRecord.url);
  const headers = validateHeaders(requestRecord.headers ?? {});
  const body = requestRecord.body ?? null;

  if (body !== null && typeof body !== 'string') throw new InvalidProxyRequestError();
  if (method === 'GET' && body !== null) throw new InvalidProxyRequestError();

  return { url, method, headers, body };
}

/**
 * Accepts only absolute http(s) URLs with a host, and rejects embedded credentials, query strings
 * are allowed here (providers use them) but fragments are not, because a fragment never reaches a
 * server and would silently vanish from the forwarded request.
 */
export function validateTargetUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidProxyRequestError();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidProxyRequestError();
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new InvalidProxyRequestError();
  }

  return url;
}

export function validateHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxyRequestError();
  }

  const headers: Record<string, string> = {};
  try {
    for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof headerValue !== 'string') throw new InvalidProxyRequestError();
      // Constructing a Headers instance is the cheapest way to reuse the platform's own header-name
      // and header-value grammar instead of hand-rolling a byte-class check.
      new Headers({ [name]: headerValue });
      headers[name] = headerValue;
    }
  } catch {
    throw new InvalidProxyRequestError();
  }

  return headers;
}

export function assertExactObject(
  value: unknown,
  requiredKeys: string[],
  optionalKeys: string[] = [],
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxyRequestError();
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const record = value as Record<string, unknown>;

  if (requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new InvalidProxyRequestError();
  }
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new InvalidProxyRequestError();
  }
}
