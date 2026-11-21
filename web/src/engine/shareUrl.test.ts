import { describe, expect, test } from 'vitest';
import { flagship_4tier } from '../data/presets/flagship_4tier';
import { starter_2tier } from '../data/presets/starter_2tier';
import {
  buildShareUrl,
  decodeRecipeHash,
  encodeRecipeHash,
  MAX_RECIPE_HASH_CHARS,
  RECIPE_HASH_PREFIX,
} from './shareUrl';

describe('shareUrl', () => {
  test.each([flagship_4tier, starter_2tier])(
    'round-trips preset $id including Unicode metadata through URL hash',
    (graph) => {
      const hash = encodeRecipeHash(graph);
      expect(hash.startsWith(RECIPE_HASH_PREFIX)).toBe(true);
      expect(hash.length).toBeLessThan(MAX_RECIPE_HASH_CHARS);

      const decoded = decodeRecipeHash(hash);
      expect(decoded).toStrictEqual({ graph });
    },
  );

  test('returns null for empty or unrelated hashes', () => {
    expect(decodeRecipeHash('')).toBeNull();
    expect(decodeRecipeHash('#other=123')).toBeNull();
    expect(decodeRecipeHash('#top')).toBeNull();
  });

  test('returns error object for malformed base64 or invalid workflow graphs', () => {
    expect(decodeRecipeHash('#recipe=')).toEqual({ error: 'Empty recipe payload' });
    expect(decodeRecipeHash('#recipe=not!valid')).toEqual({ error: 'Malformed recipe encoding' });

    const badBytes = btoa('{"id":"only_id"}').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decodedBad = decodeRecipeHash(`#recipe=${badBytes}`);
    expect(decodedBad).not.toBeNull();
    expect('error' in decodedBad!).toBe(true);
  });

  test('buildShareUrl strips any existing hash before appending #recipe=', () => {
    const url = buildShareUrl(starter_2tier, 'https://example.github.io/VibeBaton/#old-hash');
    const [base, fragment] = url.split('#');
    expect(base).toBe('https://example.github.io/VibeBaton/');
    expect(`#${fragment}`).toBe(encodeRecipeHash(starter_2tier));
  });

  test('rejects oversized graphs beyond MAX_RECIPE_HASH_CHARS', () => {
    const huge = {
      ...starter_2tier,
      description: 'x'.repeat(MAX_RECIPE_HASH_CHARS),
    };
    expect(() => encodeRecipeHash(huge)).toThrow(/too large/i);
  });
});
