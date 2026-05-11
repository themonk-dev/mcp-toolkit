import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { fetchClientMetadata, isClientIdUrl, validateRedirectUri } from './cimd.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Response whose body is a ReadableStream emitting chunks of zero
 * bytes (filler) without a Content-Length header. Used to simulate a server
 * that streams gigabytes past the configured maxBytes cap — the regression
 * Fix 4 was written to close.
 */
function streamingResponse(opts: {
  totalBytes: number;
  chunkBytes: number;
  contentType?: string;
  withContentLength?: boolean;
  /**
   * If true, the chunks emit so fast that the test should observe `cancel()`
   * before all bytes are produced. We track this via the abortObservedSignal.
   */
  onCancel?: () => void;
}): Response {
  const { totalBytes, chunkBytes, contentType = 'application/json' } = opts;
  let emitted = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - emitted);
      controller.enqueue(new Uint8Array(size));
      emitted += size;
    },
    cancel() {
      cancelled = true;
      opts.onCancel?.();
    },
  });

  const headers: Record<string, string> = { 'content-type': contentType };
  if (opts.withContentLength) {
    headers['content-length'] = String(totalBytes);
  }

  return new Response(stream, { status: 200, headers });
}

/**
 * Build a Response carrying a tiny well-formed CIMD JSON document.
 */
function smallJsonResponse(clientId: string): Response {
  const body = JSON.stringify({
    client_id: clientId,
    client_name: 'Test Client',
    redirect_uris: [`${clientId}/callback`],
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('auth/oauth/cimd: isClientIdUrl', () => {
  it('accepts an https URL with a non-root path', () => {
    expect(isClientIdUrl('https://example.com/clients/abc')).toBe(true);
  });

  it('rejects http and root-path URLs', () => {
    expect(isClientIdUrl('http://example.com/clients/abc')).toBe(false);
    expect(isClientIdUrl('https://example.com/')).toBe(false);
    expect(isClientIdUrl('not-a-url')).toBe(false);
  });
});

describe('auth/oauth/cimd: validateRedirectUri', () => {
  it('only allows redirect_uris listed in the metadata', () => {
    const metadata = {
      client_id: 'https://example.com/clients/a',
      redirect_uris: ['https://app.example/cb'],
    };
    expect(validateRedirectUri(metadata, 'https://app.example/cb')).toBe(true);
    expect(validateRedirectUri(metadata, 'https://attacker.example/cb')).toBe(false);
  });
});

describe('auth/oauth/cimd: streaming Content-Length bypass (Fix 4)', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('aborts mid-stream when the body grows past maxBytes (no Content-Length)', async () => {
    let cancelCalled = false;
    fetchSpy?.mockImplementation((async () =>
      streamingResponse({
        totalBytes: 1_000_000, // would be 1 MB
        chunkBytes: 4096,
        // No content-length: this is the bypass vector.
        withContentLength: false,
        onCancel: () => {
          cancelCalled = true;
        },
      })) as unknown as typeof fetch);

    const result = await fetchClientMetadata('https://idp.example.com/cimd/clients/1', {
      maxBytes: 8192,
    });

    expect(result).toEqual({ success: false, error: 'metadata_too_large' });
    expect(cancelCalled).toBe(true);
  });

  it('still short-circuits via the pre-read Content-Length check when honestly advertised', async () => {
    fetchSpy?.mockImplementation((async () =>
      streamingResponse({
        totalBytes: 1_000_000,
        chunkBytes: 4096,
        withContentLength: true,
      })) as unknown as typeof fetch);

    const result = await fetchClientMetadata('https://idp.example.com/cimd/clients/2', {
      maxBytes: 8192,
    });

    expect(result).toEqual({ success: false, error: 'metadata_too_large' });
  });

  it('reads a well-formed body that stays under maxBytes', async () => {
    const clientId = 'https://idp.example.com/cimd/clients/3';
    fetchSpy?.mockImplementation((async () =>
      smallJsonResponse(clientId)) as unknown as typeof fetch);

    const result = await fetchClientMetadata(clientId, { maxBytes: 65536 });
    if (!result.success) {
      throw new Error(`expected success, got ${result.error}`);
    }
    expect(result.metadata.client_id).toBe(clientId);
    expect(result.metadata.redirect_uris).toContain(`${clientId}/callback`);
  });

  it('rejects bodies whose declared content-type is not JSON', async () => {
    fetchSpy?.mockImplementation(
      (async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    );

    const result = await fetchClientMetadata('https://idp.example.com/cimd/clients/4', {
      maxBytes: 65536,
    });
    expect(result).toEqual({ success: false, error: 'invalid_content_type' });
  });

  it('returns metadata_unreadable when the response has no body', async () => {
    fetchSpy?.mockImplementation((async () => {
      // A 200 OK Response whose body is null. response.body?.getReader() === undefined.
      const res = new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      return res;
    }) as unknown as typeof fetch);

    const result = await fetchClientMetadata('https://idp.example.com/cimd/clients/5', {
      maxBytes: 65536,
    });
    expect(result).toEqual({ success: false, error: 'metadata_unreadable' });
  });
});
