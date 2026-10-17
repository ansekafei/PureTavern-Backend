/**
 * Minimal stateless session tokens for the sync API.
 *
 * Format is a JWS-compact-shaped string (`header.payload.signature`) signed with HMAC-SHA-256.
 * We deliberately avoid a JWT library: the only algorithm we ever accept is HS256, the payload is
 * three fields, and a hand-rolled verifier that refuses `alg: none` is smaller than the dependency.
 *
 * The signing key is `PURE_TAVERN_SYNC_SECRET`. Rotating it invalidates every session, which is the
 * intended "log out everywhere" mechanism.
 */

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface TokenClaims {
  /** Stable, non-guessable account identifier. Used as the R2 key prefix. */
  sub: string;
  /** Username, echoed for UI convenience only. Never used for authorization. */
  name: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export interface TokenIssueOptions {
  ttlSeconds?: number;
  now?: number;
}

export async function issueToken(
  claims: Omit<TokenClaims, 'exp'>,
  secret: string,
  options: TokenIssueOptions = {},
): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const payload: TokenClaims = {
    ...claims,
    exp: now + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const body = `${TOKEN_VERSION}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await hmacSign(body, secret);
  return `${body}.${signature}`;
}

/**
 * Verifies signature and expiry. Returns `null` for anything malformed — callers must treat `null`
 * as "unauthenticated" and never fall back to a default account.
 */
export async function verifyToken(
  token: string | null | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenClaims | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [version, payloadPart, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return null;

  const body = `${version}.${payloadPart}`;
  const expected = await hmacSign(body, secret);
  if (!timingSafeEqualStrings(signature, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    return null;
  }
  if (!isTokenClaims(claims)) return null;
  if (claims.exp <= now) return null;
  return claims;
}

function isTokenClaims(value: unknown): value is TokenClaims {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === 'string' &&
    record.sub.length > 0 &&
    typeof record.name === 'string' &&
    typeof record.exp === 'number' &&
    Number.isFinite(record.exp)
  );
}

async function hmacSign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

/** Constant-time over equal-length inputs; length mismatch short-circuits (length is not secret). */
function timingSafeEqualStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
