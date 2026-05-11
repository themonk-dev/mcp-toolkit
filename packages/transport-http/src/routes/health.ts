// Health check route. Originally `src/http/routes/health.ts`; moved to
// `@mcp-toolkit/transport-http` during D5. The `HttpBindings` generic from
// `@hono/node-server` was dropped — the health route is runtime-agnostic.

import { Hono } from 'hono';

export function healthRoutes() {
  const app = new Hono();
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      endpoints: { mcp: '/mcp', health: '/health' },
    });
  });
  return app;
}
