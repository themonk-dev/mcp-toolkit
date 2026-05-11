// MCP security: origin validation, protocol version, and challenge builder
// From Spotify MCP

/**
 * Validate the incoming `Origin` header.
 *
 * - When no `Origin` header is present, the request is treated as a
 *   non-browser caller and accepted.
 * - In development (`isDev=true`), only the literal loopback hosts
 *   (`localhost`, `127.0.0.1`, `[::1]`) are accepted. LAN ranges (`192.168.*`,
 *   `10.*`) and `.local` mDNS hostnames are explicitly rejected per the
 *   F3 hardening note — relying on private-network membership for trust is
 *   not a security boundary.
 * - In production, the origin must appear in `allowedOrigins`. The caller
 *   passes the parsed `ALLOWED_ORIGINS` env var; an empty allowlist means
 *   "browser callers are rejected".
 */
export function validateOrigin(
  headers: Headers,
  isDev: boolean,
  allowedOrigins: readonly string[] = [],
): void {
  const origin = headers.get('Origin') || headers.get('origin');

  if (!origin) {
    return; // non-browser callers
  }

  if (isDev) {
    if (!isLoopbackOrigin(origin)) {
      throw new Error(
        `Invalid origin: ${origin}. Only loopback origins (localhost / 127.0.0.1 / [::1]) allowed in development`,
      );
    }
    return;
  }

  if (!allowedOrigins.includes(origin)) {
    throw new Error(`Invalid origin: ${origin}`);
  }
}

// Supported protocol versions - accept both current and previous versions
// to maintain compatibility with clients that may not have updated yet
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25', // Latest
  '2025-06-18', // Previous (widely used)
  '2025-03-26', // Legacy
  '2024-11-05', // Legacy
];

export function validateProtocolVersion(headers: Headers, _expected: string): void {
  const header =
    headers.get('Mcp-Protocol-Version') || headers.get('MCP-Protocol-Version');

  if (!header) {
    return; // Allow requests without version header for backwards compatibility
  }

  const clientVersions = header
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  // Accept if client sends any supported version
  const hasSupported = clientVersions.some((v) =>
    SUPPORTED_PROTOCOL_VERSIONS.includes(v),
  );

  if (!hasSupported) {
    throw new Error(
      `Unsupported MCP protocol version: ${header}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
    );
  }
}

/**
 * Predicate: is `origin` a loopback origin?
 *
 * Only `localhost`, `127.0.0.1`, and `[::1]` (IPv6 loopback) qualify. LAN
 * IP ranges and mDNS `.local` hostnames are deliberately excluded — being
 * on the same network does not establish trust.
 *
 * Exported for tests and for the CORS middleware, which mirrors this
 * predicate when deciding whether to reflect an origin in development.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export type UnauthorizedChallenge = {
  status: 401;
  headers: Record<string, string>;
  body: {
    jsonrpc: '2.0';
    error: {
      code: -32000;
      message: string;
    };
    id: null;
  };
};

/**
 * Build a 401 Unauthorized challenge response for MCP
 */
export function buildUnauthorizedChallenge(args: {
  origin: string;
  sid: string;
  resourcePath?: string;
  message?: string;
}): UnauthorizedChallenge {
  const resourcePath = args.resourcePath || '/.well-known/oauth-protected-resource';
  const resourceMd = `${args.origin}${resourcePath}?sid=${encodeURIComponent(args.sid)}`;

  return {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="MCP", authorization_uri="${resourceMd}"`,
      'Mcp-Session-Id': args.sid,
    },
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: args.message || 'Unauthorized',
      },
      id: null,
    },
  };
}
