/**
 * `oidc` strategy — full OAuth 2.1 + OIDC flow.
 *
 * Both `auth.strategy = 'oauth'` and `auth.strategy = 'oidc'` route here;
 * `oauth` was a historical misnomer and the underlying code path is
 * identical. When `auth.oidc.issuer` is set, endpoints are discovered via
 * `/.well-known/openid-configuration` and id_tokens are nonce-checked.
 * Otherwise endpoints fall back to `auth.oauth.authorizationUrl` /
 * `auth.oauth.tokenUrl` from the explicit config.
 *
 * The strategy:
 *   1. Mounts `/authorize`, `/oauth/callback`, `/token`, `/revoke`,
 *      `/register` on a Hono app via `mountAuthorizationServer(app)`.
 *   2. Verifies incoming RS bearer tokens by mapping them to provider
 *      tokens through the `TokenStore`.
 *   3. Exposes protected-resource metadata for the `.well-known` endpoint.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { TokenStore } from '@mcp-toolkit/storage';
import type { Hono } from 'hono';
import { extractIdentityFromProvider } from '../identity.ts';
import { handleRegister, handleRevoke } from '../oauth/endpoints.ts';
import { handleAuthorize, handleProviderCallback, handleToken } from '../oauth/flow.ts';
import {
  buildFlowOptions,
  buildOAuthConfig,
  buildTokenInput,
  type FlowConfigInput,
  parseAuthorizeInput,
  parseCallbackInput,
  parseTokenInput,
  resolveProviderConfigForFlow,
} from '../oauth/input-parsers.ts';
import type { AuthStrategy, AuthVerifyResult } from '../types.ts';

export interface OidcStrategyOptions {
  /** Resolved auth slice — `FlowConfigInput` already nests `requireRs`,
   *  `resourceUri`, `discoveryUrl`, and `cimd` (per C3a). */
  config: FlowConfigInput;
  /** Token store used for RS↔provider mapping. */
  tokenStore: TokenStore;
  /** Realm reported in the WWW-Authenticate challenge. */
  realm?: string;
  /** Override the strategy `kind` field (defaults to 'oidc'). */
  kind?: 'oidc' | 'oauth';
}

/**
 * Build a 401 challenge whose body is a JSON-RPC error envelope.
 *
 * Every other failure path on `/mcp` returns JSON-RPC; the auth challenge
 * must match so clients that parse the response body as JSON do not choke
 * on a bare error string. The `WWW-Authenticate` header still carries the
 * machine-readable OAuth error code (`invalid_token` etc.) for clients
 * that follow RFC 6750.
 */
function challenge(realm: string, error?: string): AuthVerifyResult['challenge'] {
  const params = [`realm="${realm}"`];
  if (error) params.push(`error="${error}"`);
  const message = error ?? 'unauthorized';
  return {
    status: 401,
    headers: {
      'www-authenticate': `Bearer ${params.join(', ')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message,
        ...(error ? { data: { error_description: message } } : {}),
      },
      id: null,
    }),
  };
}

export function oidcStrategy(opts: OidcStrategyOptions): AuthStrategy {
  const { config, tokenStore } = opts;
  const realm = opts.realm ?? 'mcp';
  const kind = opts.kind ?? 'oidc';

  return {
    kind,

    /**
     * Verify an incoming Bearer RS token by mapping it to a provider token
     * via the token store. The strategy intentionally allows requests with
     * no authorization header through when `AUTH_REQUIRE_RS` is false — the
     * caller (e.g. transport-http) decides whether that surfaces as 401.
     */
    async verify(req): Promise<AuthVerifyResult> {
      const auth = req.headers.get('authorization') ?? '';
      const match = auth.match(/^\s*Bearer\s+(.+)$/i);
      const rsToken = match?.[1];

      if (!rsToken) {
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: challenge(realm),
        };
      }

      try {
        const record = await tokenStore.getByRsAccess(rsToken);
        if (!record?.provider?.access_token) {
          // No RS→provider mapping for this Bearer. The strategy always
          // returns an `invalid_token` challenge here; downstream (transport)
          // decides whether to surface it based on AUTH_ENABLED / AUTH_REQUIRE_RS.
          return {
            ok: false,
            resolvedHeaders: {},
            challenge: challenge(realm, 'invalid_token'),
          };
        }

        const now = Date.now();
        const expiresAt = record.provider.expires_at ?? 0;
        if (expiresAt && now >= expiresAt - 60_000) {
          logger.warning('oidc_strategy', {
            message: 'Provider token expired or expiring soon',
            expiresAt,
            now,
          });
        }

        const identity = extractIdentityFromProvider(record.provider);

        return {
          ok: true,
          provider: record.provider,
          identity: identity ?? undefined,
          resolvedHeaders: {
            authorization: `Bearer ${record.provider.access_token}`,
          },
        };
      } catch (error) {
        logger.error('oidc_strategy', {
          message: 'RS token lookup failed',
          error: (error as Error).message,
        });
        return {
          ok: false,
          resolvedHeaders: {},
          challenge: challenge(realm, 'server_error'),
        };
      }
    },

    /**
     * Mount the OAuth 2.1 Authorization Server endpoints on the given Hono
     * app. Routes are identical to the legacy `routes.oauth.ts` so existing
     * IdP integrations continue to work unchanged.
     */
    mountAuthorizationServer(app: Hono): void {
      const oauthConfig = buildOAuthConfig(config);

      app.get('/authorize', async (c) => {
        logger.debug('oauth_strategy', { message: 'Authorize request received' });
        try {
          const url = new URL(c.req.url);
          const input = parseAuthorizeInput(url);
          const providerConfig = await resolveProviderConfigForFlow(config);
          const options = {
            ...buildFlowOptions(url, config),
            cimd: {
              enabled: config.cimd?.enabled ?? true,
              timeoutMs: config.cimd?.fetchTimeoutMs,
              maxBytes: config.cimd?.maxResponseBytes,
              allowedDomains: config.cimd?.allowedDomains,
            },
          };

          const result = await handleAuthorize(
            input,
            tokenStore,
            providerConfig,
            oauthConfig,
            options,
          );

          logger.info('oauth_strategy', { message: 'Authorize redirect' });
          return c.redirect(result.redirectTo, 302);
        } catch (error) {
          logger.error('oauth_strategy', {
            message: 'Authorize failed',
            error: (error as Error).message,
          });
          return c.text((error as Error).message || 'Authorization failed', 400);
        }
      });

      app.get('/oauth/callback', async (c) => {
        logger.debug('oauth_strategy', { message: 'Callback request received' });
        try {
          const url = new URL(c.req.url);
          const parsed = parseCallbackInput(url);

          if (parsed.oauthError) {
            const detail = [parsed.oauthError, parsed.oauthErrorDescription]
              .filter(Boolean)
              .join(' — ');
            logger.error('oauth_strategy', {
              message: 'IdP callback error',
              idpOAuthError: parsed.oauthError,
              idpOAuthErrorDescription: parsed.oauthErrorDescription,
            });
            return c.text(`idp_callback_error: ${detail}`, 400);
          }

          const { code, state } = parsed;
          if (!code || !state) {
            return c.text('invalid_callback: missing code or state', 400);
          }

          const options = buildFlowOptions(url, config);
          const providerConfig = await resolveProviderConfigForFlow(config);

          const result = await handleProviderCallback(
            { callbackUrl: url },
            tokenStore,
            providerConfig,
            oauthConfig,
            options,
          );

          logger.info('oauth_strategy', { message: 'Callback success' });
          return c.redirect(result.redirectTo, 302);
        } catch (error) {
          logger.error('oauth_strategy', {
            message: 'Callback failed',
            error: (error as Error).message,
          });
          return c.text((error as Error).message || 'Callback failed', 500);
        }
      });

      app.post('/token', async (c) => {
        logger.debug('oauth_strategy', { message: 'Token request received' });
        try {
          const form = await parseTokenInput(c.req.raw);
          const tokenInput = buildTokenInput(form);

          if ('error' in tokenInput) {
            return c.json({ error: tokenInput.error }, 400);
          }

          const providerConfig = await resolveProviderConfigForFlow(config);
          const result = await handleToken(tokenInput, tokenStore, providerConfig);

          logger.info('oauth_strategy', { message: 'Token exchange success' });
          return c.json(result);
        } catch (error) {
          logger.error('oauth_strategy', {
            message: 'Token exchange failed',
            error: (error as Error).message,
          });
          return c.json({ error: (error as Error).message || 'invalid_grant' }, 400);
        }
      });

      app.post('/revoke', async (c) => {
        const result = await handleRevoke();
        return c.json(result);
      });

      app.post('/register', async (c) => {
        try {
          const body = (await c.req.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const url = new URL(c.req.url);

          logger.debug('oauth_strategy', { message: 'Register request' });

          const result = await handleRegister(
            {
              redirect_uris: Array.isArray(body.redirect_uris)
                ? (body.redirect_uris as string[])
                : undefined,
            },
            url.origin,
            config.oauth.redirectUri,
          );

          logger.info('oauth_strategy', { message: 'Client registered' });
          return c.json(result, 201);
        } catch (error) {
          return c.json({ error: (error as Error).message }, 400);
        }
      });
    },

    /**
     * Metadata served at `/.well-known/oauth-protected-resource`. The actual
     * `authorization_servers` and `resource` URLs are computed by transport-
     * http using the request URL; here we surface the discovery override
     * (`auth.discoveryUrl`) and the resource URI (`auth.resourceUri`) when
     * configured statically.
     */
    protectedResourceMetadata() {
      const authServer = config.discoveryUrl?.trim();
      const resource = config.resourceUri?.trim();
      if (!authServer || !resource) {
        return null;
      }
      return {
        authorization_servers: [authServer],
        resource,
      };
    },
  };
}
