// CIMD (Client ID Metadata Document) support
// Fetches and validates client metadata from HTTPS URLs per SEP-991

import { sharedLogger as logger } from '@mcp-toolkit/core';
import { z } from 'zod';
import { assertSsrfSafe } from './ssrf.ts';

/**
 * Client metadata document schema (RFC 7591 compatible)
 */
export const ClientMetadataSchema = z.object({
  client_id: z.string().url(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
  jwks_uri: z.string().url().optional(),
  software_statement: z.string().optional(),
});

export type ClientMetadata = z.infer<typeof ClientMetadataSchema>;

export type CimdConfig = {
  /** Fetch timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /** Maximum response size in bytes (default: 65536) */
  maxBytes?: number;
  /** List of allowed domains (if set, only these domains are allowed) */
  allowedDomains?: string[];
};

export type CimdFetchResult =
  | { success: true; metadata: ClientMetadata }
  | { success: false; error: string };

/**
 * Check if a client_id is a CIMD URL (HTTPS with non-root path)
 */
export function isClientIdUrl(clientId: string): boolean {
  if (!clientId.startsWith('https://')) {
    return false;
  }

  try {
    const url = new URL(clientId);
    return url.pathname !== '/' && url.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * Check if the client_id domain is in the allowed list
 */
function isDomainAllowed(clientIdUrl: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return true;
  }

  try {
    const url = new URL(clientIdUrl);
    const hostname = url.hostname.toLowerCase();
    return allowedDomains.some((domain) => {
      const d = domain.toLowerCase();
      return hostname === d || hostname.endsWith(`.${d}`);
    });
  } catch {
    return false;
  }
}

/**
 * Fetch and validate client metadata from a CIMD URL
 */
export async function fetchClientMetadata(
  clientIdUrl: string,
  config?: CimdConfig,
): Promise<CimdFetchResult> {
  const timeoutMs = config?.timeoutMs ?? 5000;
  const maxBytes = config?.maxBytes ?? 65536;
  const allowedDomains = config?.allowedDomains;

  logger.debug('cimd', {
    message: 'Fetching client metadata',
    url: clientIdUrl,
  });

  // Validate SSRF safety
  try {
    assertSsrfSafe(clientIdUrl, { requireNonRootPath: true });
  } catch (error) {
    logger.warning('cimd', {
      message: 'SSRF check failed',
      url: clientIdUrl,
      error: (error as Error).message,
    });
    return { success: false, error: (error as Error).message };
  }

  // Check domain allowlist
  if (!isDomainAllowed(clientIdUrl, allowedDomains)) {
    logger.warning('cimd', {
      message: 'Domain not in allowlist',
      url: clientIdUrl,
    });
    return { success: false, error: 'domain_not_allowed' };
  }

  // Fetch with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(clientIdUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MCP-Server/1.0 CIMD-Fetcher',
      },
      redirect: 'error', // Don't follow redirects (potential SSRF vector)
    });

    if (!response.ok) {
      logger.warning('cimd', {
        message: 'Fetch failed',
        url: clientIdUrl,
        status: response.status,
      });
      return { success: false, error: `fetch_failed: ${response.status}` };
    }

    // Pre-read sanity check on advertised Content-Length. Honest servers
    // short-circuit here; the streaming reader below is the real defense
    // against servers that omit or lie about Content-Length.
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      logger.warning('cimd', {
        message: 'Response too large',
        url: clientIdUrl,
        contentLength,
      });
      return { success: false, error: 'metadata_too_large' };
    }

    // Check content type
    const contentType = response.headers.get('content-type') || '';
    if (
      !contentType.includes('application/json') &&
      !contentType.includes('text/json')
    ) {
      logger.warning('cimd', {
        message: 'Invalid content type',
        url: clientIdUrl,
        contentType,
      });
      return { success: false, error: 'invalid_content_type' };
    }

    // Read body via a streaming reader so we can abort mid-stream as soon as
    // the accumulated byte count crosses `maxBytes`. A server that omits
    // Content-Length and streams gigabytes would otherwise be buffered whole
    // by `response.text()` before the post-read check fires.
    const reader = response.body?.getReader();
    if (!reader) {
      logger.warning('cimd', {
        message: 'Response body unreadable',
        url: clientIdUrl,
      });
      return { success: false, error: 'metadata_unreadable' };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          logger.warning('cimd', {
            message: 'Response too large (streamed)',
            url: clientIdUrl,
            bytesRead: total,
          });
          return { success: false, error: 'metadata_too_large' };
        }
        chunks.push(value);
      }
    } finally {
      // Some runtimes (Workers, undici) raise if releaseLock() is called on
      // an already-released reader; guard with optional-chain + try/catch.
      try {
        reader.releaseLock?.();
      } catch {
        /* noop */
      }
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder().decode(bytes);

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { success: false, error: 'invalid_json' };
    }

    // Validate schema
    const parsed = ClientMetadataSchema.safeParse(data);
    if (!parsed.success) {
      logger.warning('cimd', {
        message: 'Invalid metadata schema',
        url: clientIdUrl,
        errors: parsed.error.errors,
      });
      return { success: false, error: `invalid_metadata: ${parsed.error.message}` };
    }

    // Verify client_id matches URL
    if (parsed.data.client_id !== clientIdUrl) {
      logger.warning('cimd', {
        message: 'client_id mismatch',
        url: clientIdUrl,
        metadataClientId: parsed.data.client_id,
      });
      return { success: false, error: 'client_id_mismatch' };
    }

    logger.info('cimd', {
      message: 'Client metadata fetched',
      url: clientIdUrl,
      clientName: parsed.data.client_name,
      redirectUrisCount: parsed.data.redirect_uris.length,
    });

    return { success: true, metadata: parsed.data };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warning('cimd', {
        message: 'Fetch timeout',
        url: clientIdUrl,
      });
      return { success: false, error: 'fetch_timeout' };
    }

    logger.error('cimd', {
      message: 'Fetch error',
      url: clientIdUrl,
      error: (error as Error).message,
    });
    return { success: false, error: `fetch_error: ${(error as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate that a redirect_uri is allowed by the client metadata
 */
export function validateRedirectUri(
  metadata: ClientMetadata,
  redirectUri: string,
): boolean {
  return metadata.redirect_uris.includes(redirectUri);
}
