import { buildHttpApp } from '@mcp-toolkit/transport-http/node';
import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';
import { type ComposedRuntime, compose } from '../../src/compose.ts';
import type { AppConfig } from '../../src/config.ts';
import { envFor } from './env.ts';

/**
 * Common shape returned by the boot helpers. Both Node and Workers paths
 * expose the runtime alongside a `fetch(req)`-only handle so tests don't need
 * to know which transport they're exercising.
 */
export interface BootedApp {
  app: { fetch: (req: Request) => Promise<Response> };
  runtime: ComposedRuntime;
  config: AppConfig;
}

/**
 * Build the full set of HTTP-app config keys from a parsed {@link AppConfig}.
 * Both transports take a similar nested shape; the Workers handler takes the
 * full `AuthConfig` slice while the Node Hono builder picks fewer sub-objects.
 * The intersection holds because Workers' slice is a strict superset — Node
 * accepts the wider shape and only reads the fields it needs.
 *
 * The return type is the intersection of both transports' config shapes, so
 * TS catches drift on either side (a missing required field surfaces here
 * rather than at runtime).
 *
 * Renamed from `AppConfig` to `HarnessAppConfig` to avoid clashing with the
 * canonical `AppConfig` type re-exported from `apps/server/src/config.ts`.
 */
export type HarnessAppConfig = Parameters<typeof buildHttpApp>[0]['config'] &
  Parameters<typeof buildWorkersHandler>[0]['config'];

export function configFromEnv(config: AppConfig): HarnessAppConfig {
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

/** Boot apps/server through the Node Hono transport (`buildHttpApp`). */
export async function bootNode(
  overrides: Record<string, string | undefined> = {},
): Promise<BootedApp> {
  const config = envFor(overrides);
  const runtime = await compose({ config });
  const hono = buildHttpApp({
    buildServer: runtime.buildServer,
    liveServers: runtime.liveServers,
    auth: runtime.auth,
    policy: runtime.policy ?? undefined,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    config: configFromEnv(config),
  });
  // Hono's `fetch` returns `Response | Promise<Response>`; normalise to the
  // strict `Promise<Response>` shape the test helpers expect.
  const app = { fetch: async (req: Request) => hono.fetch(req) };
  return { app, runtime, config };
}

/** Boot apps/server through the Workers transport (`buildWorkersHandler`). */
export async function bootWorkers(
  overrides: Record<string, string | undefined> = {},
): Promise<BootedApp> {
  const config = envFor(overrides);
  const runtime = await compose({ config });
  const handler = buildWorkersHandler({
    auth: runtime.auth,
    tokenStore: runtime.tokenStore,
    sessionStore: runtime.sessionStore,
    registries: runtime.registries,
    policy: runtime.policy ?? undefined,
    config: configFromEnv(config),
  });
  return { app: handler, runtime, config };
}

/**
 * Boot table for parameterized tests. Drives the strategy-parity matrix:
 *
 *   for (const { name, boot } of runtimes) {
 *     describe(`${name} transport`, () => { … });
 *   }
 */
export const runtimes = [
  { name: 'node', boot: bootNode },
  { name: 'workers', boot: bootWorkers },
] as const;
