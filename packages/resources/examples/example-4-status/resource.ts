import { defineResource } from '@mcp-toolkit/mcp';

/**
 * Mutable server status snapshot. Shared with `./lifecycle.ts` so the
 * background updater (when started) can mutate it in place.
 *
 * Exported so consumers can wire their own real-metric updater instead of
 * `startStatusUpdates` if they prefer.
 */
export const serverStatus: {
  status: 'running' | 'idle' | 'busy';
  uptime: number;
  requestCount: number;
  lastUpdated: string;
} = {
  status: 'running',
  uptime: 0,
  requestCount: 0,
  lastUpdated: new Date().toISOString(),
};

/**
 * Increment the request count. Call from your dispatcher / middleware when
 * you want this resource to expose a real request counter.
 */
export function incrementRequestCount(): void {
  serverStatus.requestCount += 1;
  serverStatus.lastUpdated = new Date().toISOString();
}

/**
 * Dynamic status resource — subscribable, with update notifications when
 * paired with `startStatusUpdates`. Read-time the handler returns a
 * current snapshot of {@link serverStatus}.
 */
export const statusResource = defineResource({
  uri: 'status://server',
  name: 'Server Status',
  description:
    'Dynamic server status (subscribable resource with update notifications)',
  mimeType: 'application/json',
  handler: async () => {
    const snapshot = {
      ...serverStatus,
      timestamp: new Date().toISOString(),
    };
    return {
      contents: [
        {
          uri: 'status://server',
          mimeType: 'application/json',
          text: JSON.stringify(snapshot, null, 2),
        },
      ],
    };
  },
});
