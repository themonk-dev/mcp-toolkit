import { describe, expect, it } from 'bun:test';
import { base64UrlEncode } from '@mcp-toolkit/core/utils';
import { createEncryptor, decrypt, encrypt, generateKey } from './aes-gcm.ts';

describe('storage/crypto/aes-gcm', () => {
  it('round-trips plaintext through encrypt/decrypt with a freshly generated key', async () => {
    const key = generateKey();
    const plaintext = 'the quick brown fox jumps over the lazy dog 🦊';

    const ciphertext = await encrypt(plaintext, key);
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toContain(plaintext);

    const recovered = await decrypt(ciphertext, key);
    expect(recovered).toBe(plaintext);
  });

  it('rejects keys whose decoded length is not 32 bytes', async () => {
    // 16 random bytes → 16 byte key, must be rejected.
    const shortKey = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    await expect(encrypt('payload', shortKey)).rejects.toThrow(/32 bytes/);

    // 64 random bytes → also rejected.
    const longKey = base64UrlEncode(crypto.getRandomValues(new Uint8Array(64)));
    await expect(encrypt('payload', longKey)).rejects.toThrow(/32 bytes/);
  });

  it('fails to decrypt when the ciphertext has been tampered with', async () => {
    const key = generateKey();
    const ciphertext = await encrypt('top secret', key);

    // Flip the last character (auth-tag area) to invalidate GCM tag.
    const flipped =
      ciphertext.slice(0, -1) + (ciphertext.slice(-1) === 'A' ? 'B' : 'A');

    await expect(decrypt(flipped, key)).rejects.toThrow();
  });

  it('produces a different ciphertext for two encrypts of the same plaintext (random IV)', async () => {
    const key = generateKey();
    const plaintext = 'identical-plaintext';

    const a = await encrypt(plaintext, key);
    const b = await encrypt(plaintext, key);

    expect(a).not.toBe(b);
    // Both must still decrypt back to the same plaintext.
    expect(await decrypt(a, key)).toBe(plaintext);
    expect(await decrypt(b, key)).toBe(plaintext);
  });

  it('round-trips an empty plaintext via createEncryptor', async () => {
    const enc = createEncryptor(generateKey());
    const ciphertext = await enc.encrypt('');
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(await enc.decrypt(ciphertext)).toBe('');
  });
});
