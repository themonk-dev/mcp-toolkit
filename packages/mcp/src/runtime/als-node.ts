/**
 * Node-only AsyncLocalStorage adapter for the MCP request context.
 *
 * This is the **only** file in `@mcp-toolkit/mcp` allowed to import `node:*`.
 * Workers callers import the sibling `als-workers.ts` instead.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from '@mcp-toolkit/core';

export const authContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  authContextStorage.run(ctx, fn);

export const getCurrentContext = (): RequestContext | undefined =>
  authContextStorage.getStore();
