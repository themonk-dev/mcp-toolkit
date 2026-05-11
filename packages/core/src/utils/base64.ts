/**
 * Unified base64 / base64url utilities for Node.js and Cloudflare Workers.
 *
 * Implementation uses only Web APIs (`atob`, `btoa`, `TextEncoder`,
 * `TextDecoder`, `Uint8Array`) — no `Buffer`, no `node:*` imports — so it
 * works identically in Node 18+, Bun, browsers, and Workers.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base64 Standard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a UTF-8 string to base64.
 */
export function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to UTF-8.
 */
export function base64Decode(input: string): string {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64URL (RFC 4648 §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode bytes to base64url (URL-safe, no padding).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode base64url string to bytes.
 */
export function base64UrlDecode(str: string): Uint8Array {
  // Convert base64url → base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLength);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a UTF-8 string to base64url.
 */
export function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

/**
 * Decode a base64url string to UTF-8.
 */
export function base64UrlDecodeString(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode an object to base64url JSON.
 */
export function base64UrlEncodeJson(obj: unknown): string {
  try {
    return base64UrlEncodeString(JSON.stringify(obj));
  } catch {
    return '';
  }
}

/**
 * Decode a base64url JSON string to an object.
 */
export function base64UrlDecodeJson<T = unknown>(value: string): T | null {
  try {
    return JSON.parse(base64UrlDecodeString(value)) as T;
  } catch {
    return null;
  }
}
