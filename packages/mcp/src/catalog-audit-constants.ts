/**
 * Catalog shapes for the audit-sink catalog-list event only.
 * When adding static resources, example template rows, or prompts, keep this in sync
 * with the registry packages (`@mcp-toolkit/resources`, `@mcp-toolkit/prompts`).
 */

export const MCP_AUDIT_RESOURCE_URIS = [
  'config://server',
  'docs://overview',
  'logo://server',
  'logo://server/svg',
  'status://server',
  'example://items/books/1',
  'example://items/books/2',
  'example://items/movies/1',
] as const;

export const MCP_AUDIT_PROMPT_NAMES = ['greeting', 'analysis', 'multimodal'] as const;
