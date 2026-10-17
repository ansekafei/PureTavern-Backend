/**
 * Access-key authentication and CORS for the PureTavern proxy Worker.
 *
 * The access key is compared in constant time by hashing both sides with SHA-256 first, so the
 * comparison itself is fixed-length and cannot be used as an oracle for the real key's prefix.
 */

/** Hashes both values and compares the digests byte-by-byte without early exit. */
export async function isAuthorized(
  authorization: string | null | undefined,
  expectedKey: string,
): Promise<boolean> {
  if (typeof authorization !== 'string') return false;

  const match = /^Bearer (.+)$/iu.exec(authorization);
  const supplied = match?.[1];
  if (!supplied) return false;

  const [expectedDigest, suppliedDigest] = await Promise.all([
    sha256(expectedKey),
    sha256(supplied),
  ]);

  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index]! ^ suppliedDigest[index]!;
  }
  return difference === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/**
 * Parses the `PURE_TAVERN_ALLOWED_ORIGINS` var. An empty value or a lone `*` means "any origin",
 * which is the correct default for this transport: the proxy carries no ambient credentials, and the
 * browser origin calling it is the user's own deployment.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = String(value ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 0 || origins.includes('*') ? ['*'] : [...new Set(origins)];
}

export interface CorsHeadersInit {
  allowedOrigins: string[];
  proxyHeaderName: string;
  proxyErrorHeaderName: string;
  /** Defaults to the proxy surface's `GET, POST, OPTIONS`. The sync vault adds PUT and DELETE. */
  allowMethods?: string;
}

/**
 * Returns the CORS headers for one request. `Vary: Origin` is emitted whenever a specific origin is
 * echoed back, so shared caches cannot serve one origin's allow header to another.
 */
export function buildCorsHeaders(
  request: Request,
  {
    allowedOrigins,
    proxyHeaderName,
    proxyErrorHeaderName,
    allowMethods = 'GET, POST, OPTIONS',
  }: CorsHeadersInit,
): Headers {
  const headers = new Headers();
  const origin = request.headers.get('origin') ?? '';

  if (origin && allowedOrigins.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }

  headers.set('Access-Control-Allow-Methods', allowMethods);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set(
    'Access-Control-Expose-Headers',
    `${proxyHeaderName}, ${proxyErrorHeaderName}, Content-Type`,
  );
  headers.set('Access-Control-Max-Age', '600');

  if (request.headers.get('access-control-request-private-network') === 'true') {
    headers.set('Access-Control-Allow-Private-Network', 'true');
  }

  return headers;
}

/** Merges CORS headers onto an already-built response without mutating the original headers object. */
export function withCors(response: Response, cors: Headers): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of cors.entries()) headers.set(name, value);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
