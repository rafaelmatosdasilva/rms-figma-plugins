import { describe, it, expect } from 'vitest';
import { parseCmykString, rgbToCmyk, rgbToHex } from '@rms/core';

describe('@rms/core — parseCmykString', () => {
  it('parses a plain comma string', () => {
    expect(parseCmykString('0, 100, 100, 0')).toEqual({ c: 0, m: 100, y: 100, k: 0 });
  });

  it('parses the labelled form', () => {
    expect(parseCmykString('C:10 M:20 Y:30 K:40')).toEqual({ c: 10, m: 20, y: 30, k: 40 });
  });

  it('returns null when it is not four numbers', () => {
    expect(parseCmykString('0,100,100')).toBeNull();
    expect(parseCmykString('nope')).toBeNull();
    expect(parseCmykString('')).toBeNull();
    expect(parseCmykString(null)).toBeNull();
  });

  it('clamps out-of-range channels to 0-100 so the export never ships invalid ink', () => {
    // Tags are hand-editable in the variable description, so this can happen.
    expect(parseCmykString('150, -20, 300, 0')).toEqual({ c: 100, m: 0, y: 100, k: 0 });
  });

  it('leaves in-range values exactly as they were', () => {
    expect(parseCmykString('0,0,0,0')).toEqual({ c: 0, m: 0, y: 0, k: 0 });
    expect(parseCmykString('100,100,100,100')).toEqual({ c: 100, m: 100, y: 100, k: 100 });
  });
});

describe('@rms/core — rgb helpers (unchanged, guarded)', () => {
  it('rgbToHex', () => {
    expect(rgbToHex(1, 0, 0)).toBe('#FF0000');
  });
  it('rgbToCmyk of pure red', () => {
    expect(rgbToCmyk(1, 0, 0)).toEqual({ c: 0, m: 100, y: 100, k: 0 });
  });
});
