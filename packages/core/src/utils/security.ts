/**
 * Sensitive-data redaction helper.
 *
 * The only public export here is {@link redactSensitiveData}, used by
 * resource implementations that surface env / config snapshots over MCP
 * without leaking credentials. Other security helpers (origin /
 * protocol-version validation, session-id minting) live alongside their
 * real callers in `@mcp-toolkit/mcp`'s `security.ts`.
 */

export const redactSensitiveData = (
  obj: Record<string, unknown>,
): Record<string, unknown> => {
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'apikey',
    'api_key',
    'access_token',
    'refresh_token',
  ];

  const redacted = { ...obj };

  for (const [key, value] of Object.entries(redacted)) {
    if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value as Record<string, unknown>);
    }
  }

  return redacted;
};
