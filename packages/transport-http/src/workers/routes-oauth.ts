/**
 * OAuth Authorization Server routes for the Workers transport.
 *
 * Originally `src/adapters/http-workers/routes.oauth.ts`. Pure import
 * rewrites. Strictly no `node:*` imports.
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
import {
  jsonResponse,
  sharedLogger as logger,
  oauthError,
  redirectResponse,
  textError,
} from '@mcp-toolkit/core';
import type { TokenStore } from '@mcp-toolkit/storage';

interface IttyRouter {
  get(path: string, handler: (request: Request) => Promise<Response>): void;
  post(path: string, handler: (request: Request) => Promise<Response>): void;
}

/**
 * Workers OAuth routes consume the full flow-config slice. Since
 * `FlowConfigInput` (post-C3a) already covers `oauth`, `oidc`, `provider`,
 * and `cimd` sub-slices, the redundant `CIMD_*` / `PROVIDER_*` flat fields
 * that used to live here are gone — everything reads from the nested shape.
 */
export type WorkersOAuthRoutesConfig = FlowConfigInput;

export function attachOAuthRoutes(
  router: IttyRouter,
  store: TokenStore,
  config: WorkersOAuthRoutesConfig,
): void {
  const oauthConfig = buildOAuthConfig(config);

  router.get('/authorize', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Authorize request received' });

    try {
      const url = new URL(request.url);
      const sessionId = request.headers.get('Mcp-Session-Id') ?? undefined;
      const input = parseAuthorizeInput(url, sessionId);
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

      logger.info('oauth_workers', { message: 'Authorize redirect' });
      return redirectResponse(result.redirectTo);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Authorize failed',
        error: (error as Error).message,
      });
      return textError((error as Error).message || 'Authorization failed');
    }
  });

  router.get('/oauth/callback', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Callback request received' });

    try {
      const url = new URL(request.url);
      const parsed = parseCallbackInput(url);

      if (parsed.oauthError) {
        const detail = [parsed.oauthError, parsed.oauthErrorDescription]
          .filter(Boolean)
          .join(' — ');
        logger.error('oauth_workers', {
          message: 'IdP callback error',
          idpOAuthError: parsed.oauthError,
          idpOAuthErrorDescription: parsed.oauthErrorDescription,
        });
        return textError(`idp_callback_error: ${detail}`);
      }

      const { code, state } = parsed;
      if (!code || !state) {
        return textError('invalid_callback: missing code or state');
      }

      if (!config.provider.clientId || !config.provider.clientSecret) {
        logger.error('oauth_workers', { message: 'Missing provider credentials' });
        return textError('Server misconfigured: Missing provider credentials', {
          status: 500,
        });
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

      logger.info('oauth_workers', { message: 'Callback success' });
      return redirectResponse(result.redirectTo);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Callback failed',
        error: (error as Error).message,
      });
      return textError((error as Error).message || 'Callback failed', { status: 500 });
    }
  });

  router.post('/token', async (request: Request) => {
    logger.debug('oauth_workers', { message: 'Token request received' });

    try {
      const form = await parseTokenInput(request);
      const tokenInput = buildTokenInput(form);

      if ('error' in tokenInput) {
        return oauthError(tokenInput.error);
      }

      const providerConfig = await resolveProviderConfigForFlow(config);
      const result = await handleToken(tokenInput, store, providerConfig);

      logger.info('oauth_workers', { message: 'Token exchange success' });
      return jsonResponse(result);
    } catch (error) {
      logger.error('oauth_workers', {
        message: 'Token exchange failed',
        error: (error as Error).message,
      });
      return oauthError((error as Error).message || 'invalid_grant');
    }
  });

  router.post('/revoke', async () => {
    const result = await handleRevoke();
    return jsonResponse(result);
  });

  router.post('/register', async (request: Request) => {
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const url = new URL(request.url);

      logger.debug('oauth_workers', { message: 'Register request' });

      const result = await handleRegister(
        {
          redirect_uris: Array.isArray(body.redirect_uris)
            ? (body.redirect_uris as string[])
            : undefined,
          grant_types: Array.isArray(body.grant_types)
            ? (body.grant_types as string[])
            : undefined,
          response_types: Array.isArray(body.response_types)
            ? (body.response_types as string[])
            : undefined,
          client_name:
            typeof body.client_name === 'string' ? body.client_name : undefined,
        },
        url.origin,
        config.oauth.redirectUri,
      );

      logger.info('oauth_workers', { message: 'Client registered' });
      return jsonResponse(result, { status: 201 });
    } catch (error) {
      return oauthError((error as Error).message);
    }
  });
}
