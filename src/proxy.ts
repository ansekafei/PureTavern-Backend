/**
 * Upstream request execution for the PureTavern proxy.
 *
 * The Worker is a *transport only*: it takes the final provider URL, headers and body that the Web
 * frontend already built, forwards them, and streams the response back. It never inspects, stores or
 * rewrites provider payloads — that is why provider adaptation stays in the frontend and this file
 * contains no provider-specific branches.
 */

import {
  CONTENT_HEADERS,
  CROSS_ORIGIN_SENSITIVE_HEADERS,
  InvalidProxyRequestError,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  REQUEST_BLOCKED_HEADERS,
  RESPONSE_BLOCKED_HEADERS,
  UpstreamProxyError,
  validateTargetUrl,
  type ProxyMethod,
  type ProxyTarget,
} from './protocol';

/**
 * Forwards one validated envelope upstream, following redirects manually so that credentials are not
 * leaked to a cross-origin redirect target.
 */
export async function executeProxyRequest(
  target: ProxyTarget,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let currentUrl = target.url;
  let method: ProxyMethod = target.method;
  // `null` is the Workers-compatible spelling of "no body"; `undefined` is rejected by
  // `exactOptionalPropertyTypes` in the RequestInit overload.
  let body: string | null = target.body;
  const headers = filterRequestHeaders(target.headers);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let upstream: Response;
    try {
      upstream = await fetchImpl(currentUrl.toString(), {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UpstreamProxyError('Upstream request failed.', { cause: error });
    }

    const location = upstream.headers.get('location');
    if (!REDIRECT_STATUSES.has(upstream.status) || !location) {
      return upstream;
    }

    if (redirectCount === MAX_REDIRECTS) {
      await cancelBody(upstream);
      throw new UpstreamProxyError('The upstream provider returned too many redirects.');
    }

    let nextUrl: URL;
    try {
      nextUrl = validateTargetUrl(new URL(location, currentUrl).toString());
    } catch (error) {
      await cancelBody(upstream);
      throw error instanceof InvalidProxyRequestError
        ? new UpstreamProxyError('The upstream provider redirected to an invalid URL.')
        : error;
    }

    // A cross-origin redirect must not carry the provider key to the new host. The frontend's own
    // keys are in these headers, so they are dropped rather than re-signed.
    if (currentUrl.origin !== nextUrl.origin) {
      for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
    }

    // 303 always degrades to GET; 301/302 degrade a POST to GET per browser convention. 307/308 keep
    // both method and body, which is why they are handled implicitly by falling through.
    if (
      upstream.status === 303 ||
      ((upstream.status === 301 || upstream.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = null;
      for (const name of CONTENT_HEADERS) headers.delete(name);
    }

    await cancelBody(upstream);
    currentUrl = nextUrl;
  }

  throw new UpstreamProxyError('The upstream provider returned too many redirects.');
}

export function filterRequestHeaders(input: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (!REQUEST_BLOCKED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // Cloudflare re-encodes bodies at the edge, so ask the upstream for an identity body and let the
  // edge apply its own compression to the client hop.
  headers.set('Accept-Encoding', 'identity');
  return headers;
}

/**
 * Builds the client-facing response: strips hop-by-hop and edge-managed headers, drops any
 * `Access-Control-*` the upstream tried to set (the Worker owns CORS), and tags the response so the
 * frontend can tell a proxied reply from a direct one.
 */
export function buildProxyResponse(upstream: Response, proxyHeaderName: string): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (RESPONSE_BLOCKED_HEADERS.has(lower) || lower.startsWith('access-control-')) continue;
    headers.append(name, value);
  }
  headers.set(proxyHeaderName, '1');

  return new Response(responseHasBody(upstream.status) ? upstream.body : null, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function responseHasBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect or error response may already have closed its body.
  }
}
