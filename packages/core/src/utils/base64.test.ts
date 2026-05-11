import { describe, expect, it } from 'bun:test';
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlDecodeJson,
  base64UrlDecodeString,
  base64UrlEncode,
  base64UrlEncodeJson,
  base64UrlEncodeString,
} from './base64.ts';

describe('core/utils/base64', () => {
  it('round-trips a UTF-8 string through base64url string helpers', () => {
    const input = 'hello world — æøå 🚀';
    const encoded = base64UrlEncodeString(input);
    // URL-safe alphabet only, no padding
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(base64UrlDecodeString(encoded)).toBe(input);
  });

  it('round-trips raw Uint8Array bytes including 0xFB/0xFF boundary values', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]);
    const encoded = base64UrlEncode(bytes);
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('decodes base64url inputs correctly regardless of trailing padding length', () => {
    // 1-byte payload → would normally be "AQ==" in base64; base64url strips '='.
    expect(Array.from(base64UrlDecode('AQ'))).toEqual([0x01]);
    // 2-byte payload → "AQI=" in base64; base64url strips trailing '='.
    expect(Array.from(base64UrlDecode('AQI'))).toEqual([0x01, 0x02]);
    // 3-byte payload → "AQID" with no padding either way.
    expect(Array.from(base64UrlDecode('AQID'))).toEqual([0x01, 0x02, 0x03]);
  });

  it('round-trips empty input through every encode/decode pair', () => {
    expect(base64Decode(base64Encode(''))).toBe('');
    expect(base64UrlDecodeString(base64UrlEncodeString(''))).toBe('');
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array())))).toEqual([]);
    const obj = { hello: 'world' };
    expect(base64UrlDecodeJson<{ hello: string }>(base64UrlEncodeJson(obj))).toEqual(
      obj,
    );
  });
});
