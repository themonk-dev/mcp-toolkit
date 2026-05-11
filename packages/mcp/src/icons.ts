/**
 * MCP SEP-973-style `serverInfo.icons` from env (initialize handshake).
 */

export type McpIconDescriptor = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
};

export type McpIconEnv = {
  MCP_ICON_URL?: string;
  MCP_ICON_MIME?: string;
  MCP_ICON_SIZES: string[];
};

function inferMimeType(src: string): string {
  const lower = src.toLowerCase();
  if (lower.includes('format=svg') || /\.svg(\?|$)/i.test(src)) {
    return 'image/svg+xml';
  }
  if (lower.includes('format=webp') || /\.webp(\?|$)/i.test(src)) {
    return 'image/webp';
  }
  if (
    lower.includes('format=jpeg') ||
    lower.includes('format=jpg') ||
    /\.jpe?g(\?|$)/i.test(src)
  ) {
    return 'image/jpeg';
  }
  if (lower.includes('format=png') || /\.png(\?|$)/i.test(src)) {
    return 'image/png';
  }
  return 'image/png';
}

/**
 * Build a single-icon array for `Implementation.icons`, or `undefined` if URL unset.
 */
export function buildMcpIconsFromConfig(
  env: McpIconEnv,
): McpIconDescriptor[] | undefined {
  const src = env.MCP_ICON_URL?.trim();
  if (!src) return undefined;

  const icon: McpIconDescriptor = { src };
  const mime = env.MCP_ICON_MIME?.trim();
  icon.mimeType = mime || inferMimeType(src);

  if (env.MCP_ICON_SIZES.length > 0) {
    icon.sizes = env.MCP_ICON_SIZES;
  }

  return [icon];
}
