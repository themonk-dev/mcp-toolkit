import { defineResource } from '@mcp-toolkit/mcp';

/**
 * Small 1x1 PNG logo (base64 encoded). A minimal valid PNG file for
 * demonstration purposes — in production, load this from a CDN, KV, or
 * generate it dynamically.
 *
 * Format: 1x1 transparent PNG.
 */
const LOGO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Binary resource example: server logo image. Demonstrates blob (binary)
 * content support per MCP spec — the `blob` field carries base64-encoded
 * bytes alongside the MIME type.
 */
export const logoResource = defineResource({
  uri: 'logo://server',
  name: 'Server Logo',
  description: 'MCP server logo image (binary resource example)',
  mimeType: 'image/png',
  handler: async () => ({
    contents: [
      {
        uri: 'logo://server',
        mimeType: 'image/png',
        blob: LOGO_PNG_BASE64,
      },
    ],
  }),
});

const SVG_LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#4A90E2" />
  <text x="50" y="55" font-family="Arial" font-size="30" fill="white" text-anchor="middle">MCP</text>
</svg>`;

/**
 * Text-content variant of the same logo. SVG is XML so it can ride the
 * `text` field rather than `blob`. Pair this with `logoResource` if your
 * client wants to choose between raster and vector.
 */
export const logoSvgResource = defineResource({
  uri: 'logo://server/svg',
  name: 'Server Logo (SVG)',
  description: 'MCP server logo in SVG format (text resource example)',
  mimeType: 'image/svg+xml',
  handler: async () => ({
    contents: [
      {
        uri: 'logo://server/svg',
        mimeType: 'image/svg+xml',
        text: SVG_LOGO,
      },
    ],
  }),
});
