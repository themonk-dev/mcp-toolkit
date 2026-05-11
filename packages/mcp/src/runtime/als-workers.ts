/**
 * Workers-safe stub for the AsyncLocalStorage adapter.
 *
 * Mirrors the API of `als-node.ts` so the Workers entry point can import
 * `runWithContext` / `getCurrentContext` without dragging in `node:*`.
 * The Workers transport threads `RequestContext` explicitly through the
 * dispatcher, so context lookup always returns `undefined` here.
 */

import type { RequestContext } from '@mcp-toolkit/core';

export const authContextStorage = null as unknown as never;

export const runWithContext = <T>(_ctx: RequestContext, fn: () => T): T => fn();

export const getCurrentContext = (): RequestContext | undefined => undefined;
