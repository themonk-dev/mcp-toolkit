import { describe, expect, it } from 'bun:test';
import { assertSsrfSafe } from './ssrf.ts';

describe('auth/oauth/ssrf', () => {
  it('assertSsrfSafe accepts a public HTTPS URL with a non-root path', () => {
    expect(() =>
      assertSsrfSafe('https://idp.example.com/.well-known/openid-configuration'),
    ).not.toThrow();
  });

  it('assertSsrfSafe rejects localhost, loopback, RFC1918 ranges, and HTTP', () => {
    // localhost / loopback
    expect(() => assertSsrfSafe('https://localhost/path')).toThrow(/ssrf_blocked/);
    expect(() => assertSsrfSafe('https://127.0.0.1/path')).toThrow(/ssrf_blocked/);
    // RFC1918 private ranges
    expect(() => assertSsrfSafe('https://10.0.0.5/path')).toThrow(/ssrf_blocked/);
    expect(() => assertSsrfSafe('https://172.16.1.1/path')).toThrow(/ssrf_blocked/);
    expect(() => assertSsrfSafe('https://192.168.1.10/path')).toThrow(/ssrf_blocked/);
    // Link-local
    expect(() => assertSsrfSafe('https://169.254.169.254/latest')).toThrow(
      /ssrf_blocked/,
    );
    // Internal-domain heuristics
    expect(() => assertSsrfSafe('https://service.internal/path')).toThrow(
      /ssrf_blocked/,
    );
    // HTTP scheme rejected
    expect(() => assertSsrfSafe('http://idp.example.com/path')).toThrow(/ssrf_blocked/);
  });
});
