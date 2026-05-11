import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey } from '../crypto/aes-gcm.ts';
import { FileTokenStore } from './file.ts';

const tmpRoots: string[] = [];

function newTmpDir(): string {
  const dir = join(tmpdir(), `mcp-toolkit-file-store-${randomUUID()}`);
  tmpRoots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tmpRoots) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('storage/node/FileTokenStore', () => {
  it('round-trips a token through tmpdir: write, then re-load via a fresh instance', async () => {
    const dir = newTmpDir();
    const path = join(dir, 'tokens.json');

    const writer = new FileTokenStore(path);
    try {
      await writer.storeRsMapping(
        'rs-access-roundtrip',
        {
          access_token: 'upstream',
          refresh_token: 'upstream-refresh',
          expires_at: Date.now() + 60_000,
        },
        'rs-refresh-roundtrip',
      );
      // Force the debounced save to flush immediately.
      await writer.flush();
    } finally {
      writer.stopCleanup();
    }

    const reader = new FileTokenStore(path);
    try {
      // Constructor schedules an async load — give the microtask queue a tick.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const got = await reader.getByRsAccess('rs-access-roundtrip');
      expect(got).not.toBeNull();
      expect(got?.rs_refresh_token).toBe('rs-refresh-roundtrip');
      expect(got?.provider.access_token).toBe('upstream');
    } finally {
      reader.stopCleanup();
    }
  });

  it('writes encrypted bytes (not plaintext JSON) when an encryption key is supplied', async () => {
    const dir = newTmpDir();
    const path = join(dir, 'tokens.enc');
    const key = generateKey();

    const store = new FileTokenStore(path, key);
    try {
      await store.storeRsMapping(
        'rs-encrypted-1',
        { access_token: 'super-secret-upstream-token' },
        'rs-encrypted-refresh',
      );
      await store.flush();
    } finally {
      store.stopCleanup();
    }

    const raw = readFileSync(path, 'utf8');
    // Plaintext JSON would contain the upstream token and the rs_access_token verbatim.
    expect(raw).not.toContain('super-secret-upstream-token');
    expect(raw).not.toContain('rs-encrypted-1');
    expect(raw).not.toContain('"records"');
    // Should not be valid JSON either.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });

  it('loads a legacy on-disk file whose records lack the expiresAt augmentation', async () => {
    // Pre-snapshot-API code paths could land files whose record entries didn't
    // carry `expiresAt` (e.g. third-party tooling, or a JSON.stringify on a
    // typed-stripped record). The loader must backfill from provider.expires_at
    // or the default RS-token TTL so existing tokens.json files keep working.
    const dir = newTmpDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'tokens.json');

    const futureExp = Date.now() + 60_000;
    const legacy = {
      version: 1,
      encrypted: false,
      records: [
        {
          rs_access_token: 'rs-legacy-access',
          rs_refresh_token: 'rs-legacy-refresh',
          provider: { access_token: 'legacy-up', expires_at: futureExp },
          created_at: Date.now(),
          // NOTE: no `expiresAt` key — this is the legacy shape.
        },
      ],
    };
    writeFileSync(path, JSON.stringify(legacy, null, 2), 'utf8');

    const reader = new FileTokenStore(path);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const got = await reader.getByRsAccess('rs-legacy-access');
      expect(got).not.toBeNull();
      expect(got?.rs_refresh_token).toBe('rs-legacy-refresh');
      expect(got?.provider.access_token).toBe('legacy-up');

      const byRefresh = await reader.getByRsRefresh('rs-legacy-refresh');
      expect(byRefresh?.rs_access_token).toBe('rs-legacy-access');
    } finally {
      reader.stopCleanup();
    }
  });

  it('preserves on-disk record shape: snapshot round-trips access + refresh + provider + expiresAt', async () => {
    const dir = newTmpDir();
    const path = join(dir, 'tokens.json');

    const writer = new FileTokenStore(path);
    try {
      await writer.storeRsMapping(
        'rs-shape-access',
        {
          access_token: 'shape-up',
          refresh_token: 'shape-up-refresh',
          expires_at: Date.now() + 60_000,
        },
        'rs-shape-refresh',
      );
      await writer.flush();
    } finally {
      writer.stopCleanup();
    }

    // Inspect the file directly: the persisted record must carry every field
    // that subsequent loads rely on, including the augmented `expiresAt`.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      encrypted: boolean;
      records: Array<Record<string, unknown>>;
    };
    expect(raw.version).toBe(1);
    expect(raw.encrypted).toBe(false);
    expect(raw.records.length).toBe(1);
    const rec = raw.records[0];
    expect(rec.rs_access_token).toBe('rs-shape-access');
    expect(rec.rs_refresh_token).toBe('rs-shape-refresh');
    expect((rec.provider as { access_token?: string }).access_token).toBe('shape-up');
    expect(typeof rec.expiresAt).toBe('number');
  });

  it('does not crash when stopCleanup is called and the tmpdir is removed afterwards', async () => {
    const dir = newTmpDir();
    const path = join(dir, 'tokens.json');

    const store = new FileTokenStore(path);
    await store.storeRsMapping(
      'rs-cleanup',
      { access_token: 'x' },
      'rs-cleanup-refresh',
    );
    await store.flush();

    // Tear down without throwing.
    expect(() => store.stopCleanup()).not.toThrow();
    // A second call must also be a safe no-op.
    expect(() => store.stopCleanup()).not.toThrow();
  });
});
