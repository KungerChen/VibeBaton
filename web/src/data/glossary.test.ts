import { describe, expect, test, vi } from 'vitest';
import {
  ALL_GLOSSARY_TERM_IDS,
  CATEGORY_LABELS,
  GLOSSARY,
  GLOSSARY_BY_CATEGORY,
  GLOSSARY_BY_ID,
  GLOSSARY_CATEGORIES,
  GLOSSARY_TERM_IDS,
  GLOSSARY_TEXT_FIELDS,
  findFirstOccurrences,
  searchGlossary,
} from './glossary';

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_PATTERN = /\p{Script=Han}/u;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONDESCENDING_PATTERN = /小白|菜鸟|傻瓜|笨蛋|noob|dummy/i;
const ALL_IDS = new Set(ALL_GLOSSARY_TERM_IDS);

describe('glossary categories', () => {
  // Field rules run before the manifest comparison, so while M2-T2..T7 are pending the only
  // failing assertion is "ids equal manifest".
  test.each(GLOSSARY_CATEGORIES)('category: %s', (category) => {
    const entries = GLOSSARY_BY_CATEGORY[category];
    expect(entries.length).toBeGreaterThanOrEqual(2);

    for (const entry of entries) {
      const where = `${category}/${entry.id}`;
      expect(entry.category, where).toBe(category);
      expect(entry.id, where).toMatch(KEBAB_ID);
      expect(entry.id.trim(), where).not.toBe('');
      expect(entry.term.trim(), where).not.toBe('');
      expect(entry.term, where).not.toMatch(CJK_PATTERN);
      for (const field of GLOSSARY_TEXT_FIELDS) {
        const text = entry[field];
        expect(text.trim(), `${where}.${field} is empty`).not.toBe('');
        if (field.endsWith('_zh')) expect(text, `${where}.${field} lacks Han`).toMatch(HAN_PATTERN);
        else expect(text, `${where}.${field} contains CJK`).not.toMatch(CJK_PATTERN);
      }
      expect(entry.related.length, `${where}.related`).toBeGreaterThan(0);
      expect(entry.related, `${where}.related includes itself`).not.toContain(entry.id);
      expect(new Set(entry.related).size, `${where}.related has duplicates`).toBe(entry.related.length);
      for (const related of entry.related) {
        expect(ALL_IDS.has(related), `${where}.related "${related}" is not a manifest id`).toBe(true);
      }
    }

    expect(entries.map(({ id }) => id), `${category}: ids equal manifest`).toEqual([...GLOSSARY_TERM_IDS[category]]);
  });
});

describe('glossary totals', () => {
  test('manifest lists at least 37 kebab-case ids per category and 222 overall', () => {
    for (const category of GLOSSARY_CATEGORIES) {
      expect(GLOSSARY_TERM_IDS[category].length, category).toBeGreaterThanOrEqual(37);
      for (const id of GLOSSARY_TERM_IDS[category]) expect(id).toMatch(KEBAB_ID);
    }
    expect(ALL_GLOSSARY_TERM_IDS.length).toBeGreaterThanOrEqual(222);
    expect(ALL_IDS.size).toBe(ALL_GLOSSARY_TERM_IDS.length);
  });

  test('glossary contains at least 220 entries', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(220);
  });

  test('glossary has no duplicate ids and indexes every entry', () => {
    const ids = GLOSSARY.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of GLOSSARY) expect(GLOSSARY_BY_ID[entry.id]).toBe(entry);
  });

  test('all six categories are present with bilingual labels', () => {
    expect([...GLOSSARY_CATEGORIES]).toEqual(['vibebaton', 'git', 'ai', 'engineering', 'web_http', 'errors']);
    expect(Object.keys(GLOSSARY_TERM_IDS).sort()).toEqual([...GLOSSARY_CATEGORIES].sort());
    expect(new Set(GLOSSARY.map(({ category }) => category))).toEqual(new Set(GLOSSARY_CATEGORIES));
    for (const category of GLOSSARY_CATEGORIES) {
      expect(CATEGORY_LABELS[category].en).not.toMatch(CJK_PATTERN);
      expect(CATEGORY_LABELS[category].zh).toMatch(HAN_PATTERN);
    }
  });

  test('condescension sweep: glossary, UI messages, and brainstorm prompts', async () => {
    for (const entry of GLOSSARY) {
      for (const field of ['term', ...GLOSSARY_TEXT_FIELDS] as const) {
        expect(entry[field], `${entry.id}.${field}`).not.toMatch(CONDESCENDING_PATTERN);
      }
    }
    // The frontend dependencies omit @types/node, so type only the Node API used here.
    const { readFileSync } = await vi.importActual<{
      readFileSync(path: URL, encoding: 'utf8'): string;
    }>('node:fs');
    for (const path of ['../i18n/messages.ts', '../../../src/vibebaton/brainstorm.py']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source.length, path).toBeGreaterThan(0);
      expect(source, path).not.toMatch(CONDESCENDING_PATTERN);
    }
  });
});

describe('glossary helpers', () => {
  test('searchGlossary ranks term matches first and searches localized text', () => {
    expect(searchGlossary('', 'en')).toHaveLength(GLOSSARY.length);
    expect(searchGlossary('  rfc ', 'en')[0]?.id).toBe('rfc');
    expect(searchGlossary('commit', 'en')[0]?.id).toBe('commit');
    expect(searchGlossary('时光机', 'zh').map(({ id }) => id)).toContain('repository');
    expect(searchGlossary('时光机', 'en')).toEqual([]);
    expect(searchGlossary('zzz-no-such-term', 'en')).toEqual([]);
  });

  test('findFirstOccurrences marks each term once per paragraph and prefers longer terms', () => {
    const text = 'The Plan DAG comes from the RFC. Edit the RFC first.\n\nEvery RFC is a commit away.';
    const hits = findFirstOccurrences(text, 'en');
    expect(hits.map(({ id }) => id)).toEqual(['plan-dag', 'rfc', 'rfc', 'commit']);
    expect(hits.map(({ start, end }) => text.slice(start, end))).toEqual(['Plan DAG', 'RFC', 'RFC', 'commit']);
    expect(hits[1].start).toBe(text.indexOf('RFC'));
  });

  test('findFirstOccurrences respects word boundaries, English plurals, and Chinese text', () => {
    expect(findFirstOccurrences('recommit tokenizer', 'en')).toEqual([]);
    expect(findFirstOccurrences('the rest of the rfc', 'en')).toEqual([]);
    expect(findFirstOccurrences('A REST API and two RFCs', 'en').map(({ id }) => id)).toEqual(['rest', 'api', 'rfc']);
    const plural = 'Two Commits landed.';
    expect(findFirstOccurrences(plural, 'en').map(({ start, end }) => plural.slice(start, end))).toEqual(['Commits']);
    const zh = '先写好RFC，再提交 Commit。';
    expect(findFirstOccurrences(zh, 'zh').map(({ start, end }) => zh.slice(start, end))).toEqual(['RFC', 'Commit']);
  });
});
