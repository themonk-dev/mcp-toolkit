/**
 * Scoped `globalThis.fetch` monkey-patch. The fetch is restored unconditionally
 * (success or throw) via the `try { … } finally { … }` returned by `.finally()`,
 * so it's safe in either an `it` block or a top-level `await`.
 *
 *   const result = await withMockFetch(
 *     (req) => req.url === jwksUrl
 *       ? Response.json(jwks)
 *       : new Response('not found', { status: 404 }),
 *     async () => { … run code that calls fetch … },
 *   );
 *
 * Avoid using this for code that caches across calls — also call the
 * relevant cache-reset helper (e.g. `resetOidcDiscoveryCacheForTests()`).
 */
export function withMockFetch<T>(
  responder: (req: Request) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return Promise.resolve(responder(req));
  }) as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

/**
 * Convenience wrapper for the common "respond JSON for one URL, 404 everything
 * else" pattern. Use when a test only needs a single endpoint stubbed.
 */
export function respondJson(
  url: string,
  body: unknown,
  status = 200,
): (req: Request) => Response {
  return (req) =>
    req.url === url
      ? Response.json(body, { status })
      : new Response(`unexpected fetch: ${req.url}`, { status: 404 });
}
