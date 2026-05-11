import { describe, expect, it } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startStatusUpdates } from './lifecycle.ts';
import { statusResource } from './resource.ts';

describe('resources/examples/status', () => {
  it('returns a JSON snapshot from the status resource handler', async () => {
    const result = await statusResource.handler();
    expect(result.contents).toHaveLength(1);
    const entry = result.contents[0];
    expect(entry?.uri).toBe('status://server');
    expect(entry?.mimeType).toBe('application/json');
    const parsed = JSON.parse(entry?.text ?? '{}') as Record<string, unknown>;
    expect(typeof parsed.status).toBe('string');
    expect(typeof parsed.uptime).toBe('number');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('startStatusUpdates returns a cleanup function that does not throw', () => {
    const sendResourceUpdated = () => {};
    // McpServer is duck-typed inside lifecycle; we only need the surface
    // getServerWithInternals expects.
    const stub = { sendResourceUpdated } as unknown as McpServer;
    const servers = new Set<McpServer>([stub]);

    const cleanup = startStatusUpdates(servers);
    expect(typeof cleanup).toBe('function');
    // Idempotent: calling cleanup once and again should both be safe.
    cleanup();
    cleanup();
  });
});
