import type { Locale } from '../i18n/messages';
import { AI_TERMS } from './glossary/ai';
import { ENGINEERING_TERMS } from './glossary/engineering';
import { ERRORS_TERMS } from './glossary/errors';
import { GIT_TERMS } from './glossary/git';
import type { GlossaryCategory, GlossaryEntry } from './glossary/types';
import { VIBEBATON_TERMS } from './glossary/vibebaton';
import { WEB_HTTP_TERMS } from './glossary/web_http';

export { ALL_GLOSSARY_TERM_IDS, GLOSSARY_TERM_IDS } from './glossary/manifest';
export { GLOSSARY_CATEGORIES, GLOSSARY_TEXT_FIELDS } from './glossary/types';
export type { GlossaryCategory, GlossaryEntry } from './glossary/types';

export const GLOSSARY_BY_CATEGORY: Readonly<Record<GlossaryCategory, readonly GlossaryEntry[]>> = {
  vibebaton: VIBEBATON_TERMS,
  git: GIT_TERMS,
  ai: AI_TERMS,
  engineering: ENGINEERING_TERMS,
  web_http: WEB_HTTP_TERMS,
  errors: ERRORS_TERMS,
};

export const GLOSSARY: readonly GlossaryEntry[] = Object.values(GLOSSARY_BY_CATEGORY).flat();

export const GLOSSARY_BY_ID: Readonly<Record<string, GlossaryEntry | undefined>> = Object.fromEntries(
  GLOSSARY.map((entry) => [entry.id, entry]),
);

export const CATEGORY_LABELS: Readonly<Record<GlossaryCategory, Record<Locale, string>>> = {
  vibebaton: { en: 'VibeBaton', zh: 'VibeBaton 概念' },
  git: { en: 'Git', zh: 'Git 版本管理' },
  ai: { en: 'AI & Models', zh: 'AI 与模型' },
  engineering: { en: 'Engineering', zh: '软件工程' },
  web_http: { en: 'Web & HTTP', zh: 'Web 与 HTTP' },
  errors: { en: 'Errors', zh: '常见错误' },
};

/** Entries whose term, aliases, id, or localized text contains `query`; term matches rank first. */
export function searchGlossary(query: string, locale: Locale): GlossaryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...GLOSSARY];
  const rank = (entry: GlossaryEntry): number => {
    const term = entry.term.toLowerCase();
    const aliases = (entry.aliases ?? []).map((item) => item.toLowerCase());
    if (term === needle || entry.id === needle || aliases.includes(needle)) return 0;
    if (term.startsWith(needle) || aliases.some((item) => item.startsWith(needle))) return 1;
    if (term.includes(needle) || entry.id.includes(needle) || aliases.some((item) => item.includes(needle))) return 2;
    const text = locale === 'zh'
      ? `${entry.oneLiner_zh}\n${entry.plainExplain_zh}`
      : `${entry.oneLiner_en}\n${entry.plainExplain_en}`;
    return text.toLowerCase().includes(needle) ? 3 : -1;
  };
  return GLOSSARY
    .map((entry, index) => ({ entry, index, score: rank(entry) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ entry }) => entry);
}

export interface GlossaryOccurrence {
  id: string;
  /** Offsets into the full text passed to findFirstOccurrences (end is exclusive). */
  start: number;
  end: number;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface TermMatcher {
  id: string;
  termLength: number;
  pattern: RegExp;
}

const matcherCache = new Map<Locale, TermMatcher[]>();

function termMatchers(locale: Locale): TermMatcher[] {
  let matchers = matcherCache.get(locale);
  if (!matchers) {
    matchers = GLOSSARY.flatMap((entry) => {
      const phrases = [entry.term, ...(entry.aliases ?? [])];
      return phrases.map((phrase) => {
        const isHan = /[\p{Script=Han}]/u.test(phrase);
        if (isHan) {
          return { id: entry.id, termLength: phrase.length, pattern: new RegExp(escapeRegExp(phrase), 'g') };
        }
        // English prose also matches simple plurals ("commits", "RFCs"); Chinese has none.
        const plural = locale === 'en' && /[a-z]$/i.test(phrase) ? '(?:e?s)?' : '';
        const source = `(?<![A-Za-z0-9])${escapeRegExp(phrase)}${plural}(?![A-Za-z0-9])`;
        // Acronyms and flagged common words (`matchCase`) match case-sensitively so everyday verbs do not mis-trigger.
        const acronym = /[A-Z]/.test(phrase) && phrase === phrase.toUpperCase();
        const caseSensitive = Boolean(entry.matchCase) || acronym;
        return { id: entry.id, termLength: phrase.length, pattern: new RegExp(source, caseSensitive ? 'g' : 'gi') };
      });
    });
    matcherCache.set(locale, matchers);
  }
  return matchers;
}

/**
 * Glossary terms to highlight in `text`: each term at most once per paragraph (its first
 * occurrence), longer matches win over shorter overlapping ones ("Plan DAG" beats "DAG").
 * Results are sorted by `start`.
 */
export function findFirstOccurrences(text: string, locale: Locale): GlossaryOccurrence[] {
  const matchers = termMatchers(locale);
  const result: GlossaryOccurrence[] = [];
  let offset = 0;
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    const base = text.indexOf(paragraph, offset);
    offset = base + paragraph.length;
    const candidates: (GlossaryOccurrence & { termLength: number })[] = [];
    for (const { id, termLength, pattern } of matchers) {
      for (const match of paragraph.matchAll(pattern)) {
        candidates.push({ id, termLength, start: base + match.index, end: base + match.index + match[0].length });
      }
    }
    candidates.sort((left, right) => right.termLength - left.termLength || left.start - right.start);
    const used = new Set<string>();
    const taken: GlossaryOccurrence[] = [];
    for (const { id, start, end } of candidates) {
      if (used.has(id)) continue;
      if (taken.some((other) => start < other.end && other.start < end)) continue;
      used.add(id);
      taken.push({ id, start, end });
    }
    result.push(...taken.sort((left, right) => left.start - right.start));
  }
  return result;
}
