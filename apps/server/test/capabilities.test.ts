/**
 * End-to-end capability derivation tests.
 *
 * Capabilities are conditional on each registry being non-empty: empty `tools`
 * → no `tools` capability advertised on initialize, etc. These tests probe
 * the slot presence by issuing `initialize` over the live Workers transport
 * and inspecting `result.capabilities` from the dispatcher's response.
 *
 * Constructed without going through `compose()` because `compose()` calls
 * `buildServer()` which unconditionally registers an SDK `tools/list` handler
 * — and the SDK throws if the capability isn't advertised. The Workers
 * handler is registry-driven and never touches the SDK server, so we wire
 * the auth strategy + storage + registries directly.
 */

import { describe, expect, it } from 'bun:test';
import { noneStrategy } from '@mcp-toolkit/auth/none';
import type {
  PromptDefinition,
  ResourceDefinition,
  ToolDefinition,
} from '@mcp-toolkit/mcp';
import { examplePrompts } from '@mcp-toolkit/prompts/examples';
import { exampleResources } from '@mcp-toolkit/resources/examples';
import { MemorySessionStore, MemoryTokenStore } from '@mcp-toolkit/storage';
import { exampleTools } from '@mcp-toolkit/tools/examples';
import { buildWorkersHandler } from '@mcp-toolkit/transport-http/workers';
import { envFor } from './__helpers__/env.ts';
import { INIT_BODY, jsonReq, readJson } from './__helpers__/mcp.ts';

interface InitCaps {
  tools?: unknown;
  prompts?: unknown;
  resources?: unknown;
  logging?: unknown;
}

interface RegistryOverrides {
  tools?: ToolDefinition[];
  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
}

const defaultTools: ToolDefinition[] = [...exampleTools];
const defaultPrompts: PromptDefinition[] = [...examplePrompts];
const defaultResources: ResourceDefinition[] = [...exampleResources];

function bootWith(overrides: RegistryOverrides): {
  fetch: (req: Request) => Promise<Response>;
} {
  const config = envFor({ AUTH_STRATEGY: 'none', AUTH_ENABLED: 'false' });
  const tokenStore = new MemoryTokenStore();
  const sessionStore = new MemorySessionStore();
  return buildWorkersHandler({
    auth: noneStrategy(),
    tokenStore,
    sessionStore,
    registries: {
      tools: overrides.tools ?? defaultTools,
      prompts: overrides.prompts ?? defaultPrompts,
      resources: overrides.resources ?? defaultResources,
    },
    config: {
      server: {
        nodeEnv: config.server.nodeEnv,
        allowedOrigins: config.server.allowedOrigins,
        port: config.server.port,
      },
      mcp: config.mcp,
      auth: config.auth,
    },
  });
}

async function getInitCapabilities(app: {
  fetch: (req: Request) => Promise<Response>;
}): Promise<InitCaps> {
  const res = await app.fetch(jsonReq('http://localhost/mcp', INIT_BODY));
  const body = (await readJson(res)) as
    | { result?: { capabilities?: InitCaps } }
    | undefined;
  return body?.result?.capabilities ?? {};
}

describe('capabilities: derived from registries', () => {
  it('omits tools capability when the registry is empty', async () => {
    const app = bootWith({ tools: [] });
    const caps = await getInitCapabilities(app);
    expect(caps.tools).toBeUndefined();
    // Default prompts + resources still present.
    expect(caps.prompts).toBeDefined();
    expect(caps.resources).toBeDefined();
  });

  it('omits prompts capability when the registry is empty', async () => {
    const app = bootWith({ prompts: [] });
    const caps = await getInitCapabilities(app);
    expect(caps.prompts).toBeUndefined();
    expect(caps.tools).toBeDefined();
    expect(caps.resources).toBeDefined();
  });

  it('omits resources capability when the registry is empty', async () => {
    const app = bootWith({ resources: [] });
    const caps = await getInitCapabilities(app);
    expect(caps.resources).toBeUndefined();
    expect(caps.tools).toBeDefined();
    expect(caps.prompts).toBeDefined();
  });

  it('advertises all three slots with the bundled example registries', async () => {
    const app = bootWith({});
    const caps = await getInitCapabilities(app);
    expect(caps.tools).toBeDefined();
    expect(caps.prompts).toBeDefined();
    expect(caps.resources).toBeDefined();
    // logging capability is always advertised.
    expect(caps.logging).toBeDefined();
  });
});
