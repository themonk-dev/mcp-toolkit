import { type AppConfig, appConfigSchema } from '../../src/config.ts';

/**
 * Test-only flat-overrides API.
 *
 * The runtime config surface is grouped JSON env vars (SERVER / AUTH /
 * AUTH_KEYS / AUTH_OAUTH / MCP / MCP_ICON / STORAGE / POLICY / RUNTIME) —
 * see `apps/server/src/env-loader.ts`. But threading a JSON-shaped override
 * into every smoke test would mean ~200 test-body rewrites for no win.
 *
 * This helper keeps the compact flat-key shorthand (`AUTH_STRATEGY=apikey`,
 * `API_KEY=secret`) but shape-rewrites internally onto the nested
 * `AppConfig` that the rest of the runtime consumes — purely a test
 * ergonomics affordance, not an operator API.
 *
 * Throws (with the zod field-error breakdown) on invalid input — tests that
 * deliberately probe invalid config should call `appConfigSchema.safeParse`
 * directly.
 */

type FlatEnv = Record<string, string | undefined>;

function flatOverridesToConfig(env: FlatEnv): Record<string, unknown> {
  return {
    server: {
      host: env.HOST,
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
      rpsLimit: env.RPS_LIMIT,
      concurrencyLimit: env.CONCURRENCY_LIMIT,
      allowedOrigins: env.ALLOWED_ORIGINS,
    },
    auth: {
      strategy: env.AUTH_STRATEGY,
      requireRs: env.AUTH_REQUIRE_RS,
      resourceUri: env.AUTH_RESOURCE_URI,
      discoveryUrl: env.AUTH_DISCOVERY_URL,
      apikey: {
        key: env.API_KEY,
        headerName: env.API_KEY_HEADER,
      },
      bearer: {
        token: env.BEARER_TOKEN,
      },
      custom: {
        headers: env.CUSTOM_HEADERS,
      },
      oauth: {
        clientId: env.OAUTH_CLIENT_ID,
        clientSecret: env.OAUTH_CLIENT_SECRET,
        scopes: env.OAUTH_SCOPES,
        authorizationUrl: env.OAUTH_AUTHORIZATION_URL,
        tokenUrl: env.OAUTH_TOKEN_URL,
        revocationUrl: env.OAUTH_REVOCATION_URL,
        redirectUri: env.OAUTH_REDIRECT_URI,
        redirectAllowlist: env.OAUTH_REDIRECT_ALLOWLIST,
        redirectAllowAll: env.OAUTH_REDIRECT_ALLOW_ALL,
        clientAuth: env.OAUTH_CLIENT_AUTH,
        extraAuthParams: env.OAUTH_EXTRA_AUTH_PARAMS,
      },
      oidc: {
        issuer: env.OIDC_ISSUER,
      },
      cimd: {
        enabled: env.CIMD_ENABLED,
        fetchTimeoutMs: env.CIMD_FETCH_TIMEOUT_MS,
        maxResponseBytes: env.CIMD_MAX_RESPONSE_BYTES,
        allowedDomains: env.CIMD_ALLOWED_DOMAINS,
      },
      provider: {
        clientId: env.PROVIDER_CLIENT_ID,
        clientSecret: env.PROVIDER_CLIENT_SECRET,
        accountsUrl: env.PROVIDER_ACCOUNTS_URL,
      },
      jwt: {
        jwksUrl: env.JWT_JWKS_URL,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
      },
    },
    mcp: {
      title: env.MCP_TITLE,
      version: env.MCP_VERSION,
      instructions: env.MCP_INSTRUCTIONS,
      protocolVersion: env.MCP_PROTOCOL_VERSION,
      icon: {
        url: env.MCP_ICON_URL,
        mime: env.MCP_ICON_MIME,
        sizes: env.MCP_ICON_SIZES,
      },
      userAuditOnList: env.MCP_USER_AUDIT_ON_LIST,
    },
    storage: {
      tokensFile: env.RS_TOKENS_FILE,
      tokensEncKey: env.RS_TOKENS_ENC_KEY,
    },
    policy: {
      content: env.MCP_POLICY,
    },
  };
}

export function envFor(overrides: Record<string, string | undefined> = {}): AppConfig {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === 'string') filtered[k] = v;
  }
  const result = appConfigSchema.safeParse(flatOverridesToConfig(filtered));
  if (!result.success) {
    throw new Error(
      `Test config invalid: ${JSON.stringify(result.error.flatten().fieldErrors)}`,
    );
  }
  return result.data;
}

export type { AppConfig };
