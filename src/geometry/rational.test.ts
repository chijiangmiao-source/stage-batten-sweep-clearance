import { describe, expect, it } from 'vitest';
import { formatRat, rat, ratFromNumber } from './rational';

describe('ratFromNumber', () => {
  it('parses ordinary decimals and integers exactly', () => {
    expect(formatRat(ratFromNumber(0.25))).toBe('1/4');
    expect(formatRat(ratFromNumber(-7))).toBe('-7');
  });

  it('parses scientific notation, including sub-microsecond times produced by the playback slider', () => {
    // 1e-9 ms is earlier than one millionth of a millisecond; jumping to it must
    // not throw while converting the float playhead to an exact rational.
    expect(() => ratFromNumber(1e-9)).not.toThrow();
    expect(formatRat(ratFromNumber(1e-9))).toBe('1/1000000000');
    expect(formatRat(ratFromNumber(2.5e6))).toBe('2500000');
    expect(formatRat(ratFromNumber(1.25e-3))).toBe('1/800');
  });

  it('stays compatible with rational arithmetic', () => {
    const tiny = ratFromNumber(1e-9);
    expect(formatRat(tiny)).toBe('1/1000000000');
    expect(formatRat({ n: tiny.n, d: tiny.d })).toBe(formatRat(rat(1n, 1_000_000_000n)));
  });
});
