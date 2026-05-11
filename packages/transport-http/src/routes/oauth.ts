/**
 * OAuth Authorization Server routes (Hono).
 *
 * Originally `src/adapters/http-hono/routes.oauth.ts`. The only structural
 * change is that the route factory now takes an explicit `tokenStore` +
 * `flowConfig` (no singleton lookup, no `import { config } from '@/config/env'`).
 *
 * Config shape: `OAuthRoutesConfig` is the nested `FlowConfigInput` from
 * `@mcp-toolkit/auth/oauth/input-parsers` directly (post-C3a). `FlowConfigInput`
 * already includes the optional `cimd` sub-object, so there is no separate
 * `OAuthCimdConfig` intersection to thread.
 *
 * No `node:*` imports.
 */

import { handleRegister, handleRevoke } from '@mcp-toolkit/auth/oauth/endpoints';
import {
  handleAuthorize,
  handleProviderCallback,
  handleToken,
} from '@mcp-toolkit/auth/oauth/flow';
import {
  buildFlowOptions,
  buildOAuthConfig,
  buildTokenInput,
  type FlowConfigInput,
  parseAuthorizeInput,
  parseCallbackInput,
  parseTokenInput,
  resolveProviderConfigForFlow,
} from '@mcp-toolkit/auth/oauth/input-parsers';
import { sharedLogger as logger } from '@mcp-toolkit/core';
import type { TokenStore } from '@mcp-toolkit/storage';
import { Hono } from 'hono';

/**
 * Config slice consumed by the OAuth Authorization Server routes. This is
 * exactly the nested `FlowConfigInput` from `@mcp-toolkit/auth/oauth/input-parsers`
 * — no intersection. CIMD knobs live at `config.cimd.*`.
 */
export type OAuthRoutesConfig = FlowConfigInput;

export function buildOAuthRoutes(store: TokenStore, config: OAuthRoutesConfig): Hono {
  const app = new Hono();
  const oauthConfig = buildOAuthConfig(config);

  app.get('/authorize', async (c) => {
    logger.debug('oauth_hono', { message: 'Authorize request received' });

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
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_hono', { message: 'Authorize redirect' });
      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      logger.error('oauth_hono', {
        message: 'Authorize failed',
        error: (error as Error).message,
      });
      return c.text((error as Error).message || 'Authorization failed', 400);
    }
  });

  app.get('/oauth/callback', async (c) => {
    logger.debug('oauth_hono', { message: 'Callback request received' });

    try {
      const url = new URL(c.req.url);
      const parsed = parseCallbackInput(url);

      if (parsed.oauthError) {
        const detail = [parsed.oauthError, parsed.oauthErrorDescription]
          .filter(Boolean)
          .join(' — ');
        logger.error('oauth_hono', {
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
        store,
        providerConfig,
        oauthConfig,
        options,
      );

      logger.info('oauth_hono', { message: 'Callback success' });
      return c.redirect(result.redirectTo, 302);
    } catch (error) {
      logger.error('oauth_hono', {
        message: 'Callback failed',
        error: (error as Error).message,
      });
      return c.text((error as Error).message || 'Callback failed', 500);
    }
  });

  app.post('/token', async (c) => {
    logger.debug('oauth_hono', { message: 'Token request received' });

    try {
      const form = await parseTokenInput(c.req.raw);
      const tokenInput = buildTokenInput(form);

      if ('error' in tokenInput) {
        return c.json({ error: tokenInput.error }, 400);
      }

      const providerConfig = await resolveProviderConfigForFlow(config);
      const result = await handleToken(tokenInput, store, providerConfig);

      logger.info('oauth_hono', { message: 'Token exchange success' });
      return c.json(result);
    } catch (error) {
      logger.error('oauth_hono', {
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
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const url = new URL(c.req.url);

      logger.debug('oauth_hono', { message: 'Register request' });

      const result = await handleRegister(
        {
          redirect_uris: Array.isArray(body.redirect_uris)
            ? (body.redirect_uris as string[])
            : undefined,
        },
        url.origin,
        config.oauth.redirectUri,
      );

      logger.info('oauth_hono', { message: 'Client registered' });
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  return app;
}
