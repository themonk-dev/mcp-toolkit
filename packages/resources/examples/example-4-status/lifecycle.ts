import { logger } from '@mcp-toolkit/core';
import { getServerWithInternals } from '@mcp-toolkit/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serverStatus } from './resource.ts';

/**
 * Opt-in background updater for {@link statusResource}. Mutates the shared
 * `serverStatus` snapshot every 10s, then fires a `notifications/resources/updated`
 * notification on every live MCP server so any subscribed client re-reads.
 *
 * Accepts a `Set<McpServer>` rather than a single instance because the Node
 * transport now allocates one `McpServer` per session (each holds its own
 * transport binding — the SDK's `Protocol.connect` is one-shot per server
 * lifetime). The transport mutates the set as sessions come and go; this
 * loop just iterates the current membership on each tick.
 *
 * Returns a cleanup function — the caller (typically `apps/server`'s
 * `compose.ts`) is responsible for invoking it on shutdown to clear the
 * interval.
 */
export function startStatusUpdates(servers: Set<McpServer>): () => void {
  let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
    serverStatus.uptime += 10;
    serverStatus.requestCount += Math.floor(Math.random() * 5);
    const statuses: Array<'running' | 'idle' | 'busy'> = ['running', 'idle', 'busy'];
    serverStatus.status = statuses[Math.floor(Math.random() * 3)] ?? 'running';
    serverStatus.lastUpdated = new Date().toISOString();

    for (const server of servers) {
      try {
        getServerWithInternals(server).sendResourceUpdated?.({
          uri: 'status://server',
        });
      } catch (error) {
        logger.error('status_resource', {
          message: 'Failed to send resource update notification',
          error: (error as Error).message,
        });
      }
    }
    logger.debug('status_resource', {
      message: 'Status updated, notification sent',
      status: serverStatus.status,
      uptime: serverStatus.uptime,
      sessions: servers.size,
    });
  }, 10_000);

  logger.info('status_resource', {
    message: 'Status update notifications started (every 10s)',
  });

  return () => {
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
      logger.info('status_resource', {
        message: 'Status update notifications stopped',
      });
    }
  };
}
