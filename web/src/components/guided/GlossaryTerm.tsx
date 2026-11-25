import './GlossaryTerm.css';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY_BY_ID, findFirstOccurrences } from '../../data/glossary';
import { useI18n } from '../../i18n';
import { MESSAGES, type Locale } from '../../i18n/messages';

/** A run of text; `termId` is set only on the first occurrence of a glossary term in its paragraph. */
export interface GlossarySegment {
  text: string;
  termId: string | null;
}

export interface GlossaryCardContent {
  id: string;
  term: string;
  oneLiner: string;
  plain: string;
  pro: string;
  related: { id: string; term: string }[];
}

/** Split `text` into plain runs and first-occurrence term runs, preserving every character. */
export function splitGlossarySegments(text: string, locale: Locale): GlossarySegment[] {
  const segments: GlossarySegment[] = [];
  let cursor = 0;
  for (const { id, start, end } of findFirstOccurrences(text, locale)) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), termId: null });
    segments.push({ text: text.slice(start, end), termId: id });
    cursor = end;
  }
  if (cursor < text.length || segments.length === 0) segments.push({ text: text.slice(cursor), termId: null });
  return segments;
}

/** Memoized `splitGlossarySegments` for rendering: map each segment to text or `<GlossaryTerm>`. */
export function useGlossaryHighlights(text: string, locale: Locale): GlossarySegment[] {
  return useMemo(() => splitGlossarySegments(text, locale), [text, locale]);
}

/** Localized popover content for a term, or null when the id is not in the glossary. */
export function glossaryCardContent(termId: string, locale: Locale): GlossaryCardContent | null {
  const entry = GLOSSARY_BY_ID[termId];
  if (!entry) return null;
  const zh = locale === 'zh';
  return {
    id: entry.id,
    term: entry.term,
    oneLiner: zh ? entry.oneLiner_zh : entry.oneLiner_en,
    plain: zh ? entry.plainExplain_zh : entry.plainExplain_en,
    pro: zh ? entry.proExplain_zh : entry.proExplain_en,
    // Related ids that are not written yet are skipped rather than rendered as dead links.
    related: entry.related.flatMap((id) => {
      const target = GLOSSARY_BY_ID[id];
      return target ? [{ id, term: target.term }] : [];
    }),
  };
}

export interface GlossaryTermProps {
  termId: string;
  children: ReactNode;
  /** Opens the popover on first render; intended for previews and tests. */
  defaultOpen?: boolean;
}

/**
 * Inline glossary term: dotted underline trigger plus a popover with the plain and technical
 * explanations. Related terms are clickable and swap the popover content in place.
 * Render it only for segments that `useGlossaryHighlights` marked (first occurrence per paragraph).
 */
export function GlossaryTerm({ termId, children, defaultOpen = false }: GlossaryTermProps) {
  const { locale } = useI18n();
  const labels = MESSAGES[locale].glossary;
  const [open, setOpen] = useState(defaultOpen);
  const [activeId, setActiveId] = useState(termId);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const card = glossaryCardContent(activeId, locale);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!glossaryCardContent(termId, locale)) return <>{children}</>;

  const toggle = () => {
    setActiveId(termId);
    setOpen((value) => !value);
  };

  return (
    <span className="glossary-term" ref={rootRef}>
      <button
        type="button"
        className="glossary-term__trigger"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggle}
      >
        {children}
      </button>
      {open && card ? (
        <span id={popoverId} className="glossary-term__popover" role="dialog" aria-label={card.term}>
          <span className="glossary-term__title">{card.term}</span>
          <span className="glossary-term__one-liner">{card.oneLiner}</span>
          <span className="glossary-term__label">{labels.plain}</span>
          <span className="glossary-term__text">{card.plain}</span>
          <span className="glossary-term__label">{labels.pro}</span>
          <span className="glossary-term__text glossary-term__text--pro">{card.pro}</span>
          {card.related.length > 0 ? (
            <>
              <span className="glossary-term__label">{labels.related}</span>
              <span className="glossary-term__related">
                {card.related.map(({ id, term }) => (
                  <button key={id} type="button" className="glossary-term__chip" onClick={() => setActiveId(id)}>
                    {term}
                  </button>
                ))}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
