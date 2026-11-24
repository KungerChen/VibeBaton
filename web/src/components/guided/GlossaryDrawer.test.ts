import { describe, expect, test } from 'vitest';
import {
  GLOSSARY,
  GLOSSARY_BY_CATEGORY,
  GLOSSARY_BY_ID,
  GLOSSARY_CATEGORIES,
} from '../../data/glossary';
import { filterGlossary, nextRelated } from './GlossaryDrawer';

const LOCALES = ['en', 'zh'] as const;

describe('filterGlossary', () => {
  test('returns the whole glossary for an empty query in either locale', () => {
    for (const locale of LOCALES) {
      expect(filterGlossary('', 'all', locale)).toEqual([...GLOSSARY]);
      expect(filterGlossary('   ', 'all', locale)).toEqual([...GLOSSARY]);
    }
  });

  test('keeps matching terms first and drops entries without a match', () => {
    const matches = filterGlossary('repository', 'all', 'en');
    expect(matches[0]?.id).toBe('repository');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(GLOSSARY.length);
    expect(filterGlossary('zzz-no-such-term', 'all', 'en')).toEqual([]);
  });

  test('searches the one-liners of the active locale only', () => {
    expect(filterGlossary('时光机', 'all', 'zh').map(({ id }) => id)).toContain('repository');
    expect(filterGlossary('时光机', 'all', 'en')).toEqual([]);
  });

  test('restricts the results to every category in both locales', () => {
    for (const locale of LOCALES) {
      for (const category of GLOSSARY_CATEGORIES) {
        const matches = filterGlossary('', category, locale);
        expect(matches).toEqual([...GLOSSARY_BY_CATEGORY[category]]);
        expect(matches.every((entry) => entry.category === category)).toBe(true);
      }
    }
  });

  test('combines the query and category filters', () => {
    const target = GLOSSARY_BY_CATEGORY.git[0];
    for (const locale of LOCALES) {
      const matches = filterGlossary(target.term, 'git', locale);
      expect(matches.some(({ id }) => id === target.id)).toBe(true);
      expect(matches.every(({ category }) => category === 'git')).toBe(true);
    }
  });
});

describe('nextRelated', () => {
  test('returns the first related entry that exists, without repeating the current term', () => {
    for (const entry of GLOSSARY) {
      const expected = entry.related.find((relatedId) => GLOSSARY_BY_ID[relatedId]) ?? null;
      expect(nextRelated(entry.id)).toBe(expected);
      expect(nextRelated(entry.id)).not.toBe(entry.id);
    }
  });

  test('resolves a related chip target to a renderable term', () => {
    const next = nextRelated('rfc');
    expect(next).not.toBeNull();
    const target = GLOSSARY_BY_ID[next as string];
    expect(target).toBeDefined();
    expect(target?.term).not.toBe('');
    expect(GLOSSARY_BY_ID.rfc?.related).toContain(next);
  });

  test('returns null for ids that are not in the glossary', () => {
    expect(nextRelated('no-such-term')).toBeNull();
    expect(nextRelated('')).toBeNull();
  });
});
