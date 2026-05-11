/**
 * OAuth discovery routes (Hono).
 *
 * `.well-known/oauth-protected-resource` is always served — the metadata
 * is safe to publish regardless of which auth strategy is wired. Clients
 * need it to complete the 401 → metadata loop when an `oidc` deployment
 * challenges them.
 *
 * No `node:*` imports.
 */

import {
  createDiscoveryHandlers,
  type DiscoveryConfigInput,
  nodeDiscoveryStrategy,
} from '@mcp-toolkit/auth/oauth/discovery-handlers';
import { Hono } from 'hono';

export type DiscoveryRoutesConfig = DiscoveryConfigInput;

export function buildDiscoveryRoutes(config: DiscoveryRoutesConfig): Hono {
  const app = new Hono();
  const { authorizationMetadata, protectedResourceMetadata } = createDiscoveryHandlers(
    config,
    nodeDiscoveryStrategy,
  );

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const here = new URL(c.req.url);
    const sid = here.searchParams.get('sid') ?? undefined;
    const metadata = protectedResourceMetadata(here, sid);
    return c.json(metadata);
  });

  app.get('/mcp/.well-known/oauth-protected-resource', (c) => {
    const here = new URL(c.req.url);
    const sid = here.searchParams.get('sid') ?? undefined;
    const metadata = protectedResourceMetadata(here, sid);
    return c.json(metadata);
  });

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const metadata = authorizationMetadata(here);
    return c.json(metadata);
  });

  app.get('/mcp/.well-known/oauth-authorization-server', (c) => {
    const here = new URL(c.req.url);
    const metadata = authorizationMetadata(here);
    return c.json(metadata);
  });

  return app;
}
