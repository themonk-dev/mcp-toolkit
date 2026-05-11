import { describe, expect, it } from 'bun:test';
import { createCursor, paginateArray, parseCursor } from './pagination.ts';

describe('core/utils/pagination', () => {
  it('returns an empty page with no nextCursor for an empty input', () => {
    const result = paginateArray<number>([]);
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns the entire array as one page when items fit under the limit', () => {
    const items = [1, 2, 3];
    const result = paginateArray(items, undefined, 50);
    expect(result.data).toEqual(items);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns successive pages via cursor round-trip when items exceed limit', () => {
    const items = Array.from({ length: 5 }, (_, i) => i); // [0,1,2,3,4]
    const first = paginateArray(items, undefined, 2);
    expect(first.data).toEqual([0, 1]);
    expect(first.nextCursor).toBeDefined();
    expect(parseCursor(first.nextCursor)).toBe(2);

    const second = paginateArray(items, first.nextCursor, 2);
    expect(second.data).toEqual([2, 3]);
    expect(parseCursor(second.nextCursor)).toBe(4);

    const third = paginateArray(items, second.nextCursor, 2);
    expect(third.data).toEqual([4]);
    expect(third.nextCursor).toBeUndefined();

    // createCursor → parseCursor is symmetric.
    expect(parseCursor(createCursor(42))).toBe(42);
    // A malformed cursor decodes to offset 0 rather than throwing.
    expect(parseCursor('not-a-real-cursor')).toBe(0);
  });
});
