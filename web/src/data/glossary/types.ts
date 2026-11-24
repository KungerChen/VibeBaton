export const GLOSSARY_CATEGORIES = ['vibebaton', 'git', 'ai', 'engineering', 'web_http', 'errors'] as const;

export type GlossaryCategory = (typeof GLOSSARY_CATEGORIES)[number];

/**
 * One glossary term. Every text field is required and written for a capable reader who is
 * new to the topic: `oneLiner` is a single sentence, `plainExplain` uses an everyday
 * analogy, `proExplain` gives the precise technical meaning and how VibeBaton relies on it.
 */
export interface GlossaryEntry {
  /** Kebab-case id; must appear in GLOSSARY_TERM_IDS for `category`. */
  id: string;
  /** Display name shown in both locales and matched in running text (e.g. "RFC", "Commit"). */
  term: string;
  category: GlossaryCategory;
  oneLiner_en: string;
  oneLiner_zh: string;
  plainExplain_en: string;
  plainExplain_zh: string;
  proExplain_en: string;
  proExplain_zh: string;
  /** Ids of other manifest terms worth reading next; never includes `id` itself. */
  related: string[];
}

export const GLOSSARY_TEXT_FIELDS = [
  'oneLiner_en',
  'oneLiner_zh',
  'plainExplain_en',
  'plainExplain_zh',
  'proExplain_en',
  'proExplain_zh',
] as const satisfies readonly (keyof GlossaryEntry)[];
