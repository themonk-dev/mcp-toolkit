/**
 * Node entry — `bun run dev` / `bun run start` invoke this file.
 *
 * Loads config via `loadNodeConfig`, calls `compose` to build the runtime,
 * then binds the resulting Hono app to `@hono/node-server`. Wires graceful
 * shutdown on SIGINT / SIGTERM. The Workers entry (`worker.ts`) follows the
 * same skeleton with `loadWorkersConfig` + KV stores.
 */

import { type ServerType, serve } from '@hono/node-server';
import { sharedLogger as logger } from '@mcp-toolkit/core';
import { getCurrentContext } from '@mcp-toolkit/mcp/runtime/als-node';
import { MemorySessionStore } from '@mcp-toolkit/storage';
import { FileTokenStore } from '@mcp-toolkit/storage/node/file';
import { buildHttpApp, buildOAuthServerApp } from '@mcp-toolkit/transport-http/node';

import { compose } from './compose.ts';
import type { AppConfig } from './config.ts';
import { loadNodeConfig } from './env-node.ts';

async function main(): Promise<void> {
  const config = loadNodeConfig();

  const tokenStore = new FileTokenStore(
    config.storage.tokensFile,
    config.storage.tokensEncKey,
  );
  const sessionStore = new MemorySessionStore();

  const runtime = await compose({
    config,
    tokenStore,
    sessionStore,
    getContext: getCurrentContext,
  });

  const app = buildHttpApp({
    buildServer: runtime.buildServer,
    liveServers: runtime.liveServers,
    auth: runtime.auth,
    policy: runtime.policy ?? undefined,
    audit: runtime.audit ?? undefined,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    config: buildHttpAppConfigSlice(config),
  });

  const mcpServer: ServerType = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  });

  logger.info('main', {
    message: 'MCP server listening',
    host: config.server.host,
    port: config.server.port,
    auth: runtime.auth.kind,
    policy: runtime.policy?.isEnforced() ?? false,
  });

  let oauthServer: ServerType | undefined;
  if (config.auth.strategy === 'oidc' || config.auth.strategy === 'oauth') {
    const oauthApp = buildOAuthServerApp({
      tokenStore: runtime.tokenStore,
      config: buildOAuthServerConfigSlice(config),
    });
    oauthServer = serve({
      fetch: oauthApp.fetch,
      port: config.server.port + 1,
      hostname: config.server.host,
    });
    logger.info('main', {
      message: 'OAuth Authorization Server listening',
      port: config.server.port + 1,
    });
  }

  const shutdown = (signal: string): void => {
    logger.info('main', { message: `Received ${signal}, shutting down` });
    try {
      runtime.shutdown();
    } catch (error) {
      logger.error('main', {
        message: 'runtime.shutdown failed',
        error: (error as Error).message,
      });
    }
    try {
      tokenStore.flush();
    } catch (error) {
      logger.error('main', {
        message: 'tokenStore.flush failed',
        error: (error as Error).message,
      });
    }
    try {
      tokenStore.stopCleanup();
    } catch {
      // best-effort
    }
    try {
      sessionStore.stopCleanup();
    } catch {
      // best-effort
    }
    try {
      mcpServer.close();
    } catch {
      // best-effort
    }
    try {
      oauthServer?.close();
    } catch {
      // best-effort
    }
    // Give in-flight requests a beat, then exit.
    setTimeout(() => process.exit(0), 100).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Build the `BuildHttpAppConfig` slice from the validated nested `AppConfig`.
 * Names exactly the sub-objects the Node transport consumes.
 */
function buildHttpAppConfigSlice(
  config: AppConfig,
): Parameters<typeof buildHttpApp>[0]['config'] {
  return {
    server: {
      nodeEnv: config.server.nodeEnv,
      allowedOrigins: config.server.allowedOrigins,
      port: config.server.port,
    },
    mcp: config.mcp,
    auth: {
      strategy: config.auth.strategy,
      apikey: config.auth.apikey,
      discoveryUrl: config.auth.discoveryUrl,
      oauth: config.auth.oauth,
      oidc: config.auth.oidc,
      cimd: config.auth.cimd,
      provider: config.auth.provider,
    },
  };
}

function buildOAuthServerConfigSlice(
  config: AppConfig,
): Parameters<typeof buildOAuthServerApp>[0]['config'] {
  return {
    server: {
      nodeEnv: config.server.nodeEnv,
      allowedOrigins: config.server.allowedOrigins,
      port: config.server.port,
    },
    auth: {
      strategy: config.auth.strategy,
      oauth: config.auth.oauth,
      oidc: config.auth.oidc,
      cimd: config.auth.cimd,
      provider: config.auth.provider,
      discoveryUrl: config.auth.discoveryUrl,
    },
  };
}

main().catch((error) => {
  logger.error('main', {
    message: 'Fatal startup error',
    error: (error as Error).message,
  });
  process.exit(1);
});
