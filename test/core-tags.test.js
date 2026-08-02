import { describe, it, expect } from 'vitest';
import { parseDescTag, setDescTag, removeDescTag } from '@rms/core';

describe('@rms/core — description tags', () => {
  it('sets a tag on an empty description', () => {
    expect(setDescTag('', 'cmyk', '0,100,100,0')).toBe('[cmyk:0,100,100,0]');
  });

  it('appends a tag, keeping existing text', () => {
    expect(setDescTag('Brand red', 'pantone', '485 C')).toBe('Brand red [pantone:485 C]');
  });

  it('upserts an existing tag without touching others', () => {
    const desc = 'x [cmyk:0,0,0,0] [pantone:100 C]';
    expect(setDescTag(desc, 'cmyk', '10,20,30,40')).toBe('x [cmyk:10,20,30,40] [pantone:100 C]');
  });

  it('parses and removes a tag', () => {
    const desc = setDescTag('note', 'ral', '5010');
    expect(parseDescTag(desc, 'ral')).toBe('5010');
    expect(removeDescTag(desc, 'ral')).toBe('note');
  });

  it('strips brackets from the value so the tag stays parseable and removable', () => {
    // A value like "485]C" would otherwise produce [pantone:485]C], corrupting the
    // description with junk that removeDescTag can never clean.
    const desc = setDescTag('', 'pantone', '485]C');
    expect(desc).toBe('[pantone:485C]');
    expect(parseDescTag(desc, 'pantone')).toBe('485C');
    expect(removeDescTag(desc, 'pantone')).toBe('');
  });

  it('handles a value with a stray opening bracket too', () => {
    const desc = setDescTag('', 'vinyl', 'Oracal [751]');
    expect(desc).toBe('[vinyl:Oracal 751]');
    expect(removeDescTag(desc, 'vinyl')).toBe('');
  });
});
