/**
 * `@mcp-toolkit/proxy-tools` — public surface.
 *
 * Each configured downstream MCP server is exposed to the upstream client
 * as a single `ToolDefinition`. The factory wires three concerns together:
 *
 * - `CredentialResolver` — produces a `Credential` for a given `serverId`.
 *   `EnvCredentialResolver` reads from the validated env-supplied config;
 *   future implementations (e.g. a sealed vault) drop in unchanged.
 * - `buildAuthInject` — converts a `Credential` into the `AuthInject`
 *   transform used by `OutboundMcpClient` on every outbound request.
 * - `buildProxyTools` — for each configured server, returns one
 *   `ToolDefinition` whose handler lazily initializes, lists tools, validates
 *   the requested `action`, and forwards to the downstream.
 *
 * Future extensions (OAuth2 credentials, persistent vault, per-action policy
 * gating) plug in at the seams marked with `// TODO(oauth2)` /
 * `// TODO(persistent-vault)` without changing the factory contract.
 */

export { buildAuthInject } from './auth-inject.ts';
export {
  CONNECTED_AUTH_TYPES,
  type ConnectedAuthType,
  type ConnectedServer,
  connectedServerSchema,
  connectedServersSchema,
} from './config.ts';
export {
  type Credential,
  type CredentialResolver,
  EnvCredentialResolver,
} from './creds.ts';
export { type BuildProxyToolsOpts, buildProxyTools } from './factory.ts';
