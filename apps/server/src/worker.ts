/**
 * Cloudflare Workers entry.
 *
 * Mirrors `main.ts` but for the Workers runtime. The `compose` layer is the
 * same — only the env loader, the stores, and the handler factory differ.
 *
 * **Strictly no `node:*` imports**, even transitively. The MCP server here
 * does not use `getContext` (Workers thread context explicitly through the
 * dispatcher), so we omit it.
 */

import { sharedLogger as logger } from '@mcp-toolkit/core';
import { MemorySessionStore } from '@mcp-toolkit/storage';
import { createEncryptor } from '@mcp-toolkit/storage/crypto';
import { KvSessionStore, KvTokenStore } from '@mcp-toolkit/storage/workers/kv';
import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';

import { compose } from './compose.ts';
import type { AppConfig } from './config.ts';
import { loadWorkersConfig } from './env-workers.ts';

/**
 * Workers binding shape. KV namespaces are optional — without `TOKENS` the
 * server falls back to in-memory token storage (fine for non-OAuth strategies
 * like `apikey` / `none` / `jwt`).
 */
export interface WorkersBindings {
  TOKENS?: KVNamespace;
  SESSIONS?: KVNamespace;
  [key: string]: unknown;
}

export default {
  async fetch(
    request: Request,
    bindings: WorkersBindings,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const config = loadWorkersConfig(bindings as Record<string, unknown>);

    // Wire AES-GCM encryption for KV-backed tokens when the operator
    // supplied a key. Without it, provider tokens (incl. refresh tokens)
    // sit in KV in cleartext — fine for dev, never for production.
    const encryptor = config.storage.tokensEncKey
      ? createEncryptor(config.storage.tokensEncKey)
      : undefined;
    if (!encryptor && config.server.nodeEnv === 'production') {
      logger.warning('worker', {
        message:
          'Token encryption disabled: STORAGE.tokensEncKey is empty. Provider tokens will be stored unencrypted in KV.',
      });
    }

    const tokenStore = bindings.TOKENS
      ? new KvTokenStore(
          bindings.TOKENS,
          encryptor
            ? { encrypt: encryptor.encrypt, decrypt: encryptor.decrypt }
            : undefined,
        )
      : undefined;
    const sessionStore = bindings.SESSIONS
      ? new KvSessionStore(bindings.SESSIONS)
      : new MemorySessionStore();

    const runtime = await compose({
      config,
      tokenStore,
      sessionStore,
      // Workers has no AsyncLocalStorage — context is threaded explicitly
      // through `dispatchMcpMethod` in the Workers transport.
      getContext: () => undefined,
    });

    const handler = buildWorkersHandler({
      auth: runtime.auth,
      tokenStore: runtime.tokenStore,
      sessionStore: runtime.sessionStore,
      registries: runtime.registries,
      policy: runtime.policy ?? undefined,
      audit: runtime.audit ?? undefined,
      config: buildWorkersHandlerConfigSlice(config),
    });

    return handler.fetch(request, bindings, _ctx);
  },
} satisfies ExportedHandler<WorkersBindings>;

/**
 * Build the `BuildWorkersHandlerConfig` slice from the validated nested
 * `AppConfig`. Workers handler serves OAuth AS from the same handler, so it
 * receives the full auth slice (unlike Node, which splits AS into a separate
 * handler).
 */
function buildWorkersHandlerConfigSlice(
  config: AppConfig,
): Parameters<typeof buildWorkersHandler>[0]['config'] {
  return {
    server: {
      nodeEnv: config.server.nodeEnv,
      allowedOrigins: config.server.allowedOrigins,
      port: config.server.port,
    },
    mcp: config.mcp,
    auth: config.auth,
  };
}
