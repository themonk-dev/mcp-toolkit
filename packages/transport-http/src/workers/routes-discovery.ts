/**
 * OAuth discovery routes for the Workers transport.
 *
 * Originally `src/adapters/http-workers/routes.discovery.ts`. Pure import
 * rewrites. Strictly no `node:*` imports.
 */

import {
  createDiscoveryHandlers,
  type DiscoveryConfigInput,
  workerDiscoveryStrategy,
} from '@mcp-toolkit/auth/oauth/discovery-handlers';
import { jsonResponse } from '@mcp-toolkit/core';

interface IttyRouter {
  get(path: string, handler: (request: Request) => Promise<Response>): void;
  post(path: string, handler: (request: Request) => Promise<Response>): void;
}

export function attachDiscoveryRoutes(
  router: IttyRouter,
  config: DiscoveryConfigInput,
): void {
  const { authorizationMetadata, protectedResourceMetadata } = createDiscoveryHandlers(
    config,
    workerDiscoveryStrategy,
  );

  router.get('/.well-known/oauth-authorization-server', async (request: Request) => {
    const metadata = authorizationMetadata(new URL(request.url));
    return jsonResponse(metadata);
  });

  router.get('/.well-known/oauth-protected-resource', async (request: Request) => {
    const here = new URL(request.url);
    const sid = here.searchParams.get('sid') ?? undefined;
    const metadata = protectedResourceMetadata(here, sid);
    return jsonResponse(metadata);
  });
}
