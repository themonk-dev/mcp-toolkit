import type { ResourceDefinition } from '@mcp-toolkit/mcp';
import { configResource } from './example-1-config/resource.ts';
import { docsResource } from './example-2-docs/resource.ts';
import { logoResource, logoSvgResource } from './example-3-logo/resource.ts';
import { startStatusUpdates } from './example-4-status/lifecycle.ts';
import {
  incrementRequestCount,
  serverStatus,
  statusResource,
} from './example-4-status/resource.ts';

export {
  configResource,
  docsResource,
  incrementRequestCount,
  logoResource,
  logoSvgResource,
  serverStatus,
  startStatusUpdates,
  statusResource,
};

/**
 * The bundled example resources. Cast is local to this file (see the tools
 * package's `examples/index.ts` for the rationale on handler variance).
 */
export const exampleResources = [
  configResource,
  docsResource,
  logoResource,
  logoSvgResource,
  statusResource,
] as unknown as ResourceDefinition[];
