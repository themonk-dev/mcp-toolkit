/**
 * Build the `AuthInject` transform applied to every outbound request to a
 * downstream MCP server. Pure sync function — no I/O, no allocation beyond
 * a single new `Request` with copied headers.
 *
 * Future `oauth2` variant will require an async resolve-and-maybe-refresh
 * path; when that lands, `AuthInject` itself flips to `(req) => Promise<Request>`
 * and `OutboundMcpClient.send` adds one `await` at the inject site.
 */

import type { AuthInject } from '@mcp-toolkit/mcp-client';
import type { Credential } from './creds.ts';

export function buildAuthInject(cred: Credential): AuthInject {
  switch (cred.authType) {
    case 'none':
      return (req) => req;
    case 'api_key': {
      const { headerName, key } = cred;
      return (req) => {
        const headers = new Headers(req.headers);
        headers.set(headerName, key);
        return new Request(req, { headers });
      };
    }
    case 'bearer': {
      const value = `Bearer ${cred.token}`;
      return (req) => {
        const headers = new Headers(req.headers);
        headers.set('Authorization', value);
        return new Request(req, { headers });
      };
    }
  }
}
