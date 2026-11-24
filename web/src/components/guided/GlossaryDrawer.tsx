import './GlossaryDrawer.css';
import '../ui/ui.css';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CATEGORY_LABELS,
  GLOSSARY,
  GLOSSARY_BY_ID,
  GLOSSARY_CATEGORIES,
  searchGlossary,
  type GlossaryCategory,
  type GlossaryEntry,
} from '../../data/glossary';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type GlossaryCategoryFilter = GlossaryCategory | 'all';
export type GlossaryDetailTab = 'plain' | 'pro';

const DETAIL_TABS: readonly GlossaryDetailTab[] = ['plain', 'pro'];

/** Glossary entries matching `query` in `locale`, narrowed to `category` when one is chosen. */
export function filterGlossary(
  query: string,
  category: GlossaryCategoryFilter,
  locale: Locale,
): GlossaryEntry[] {
  const matches = searchGlossary(query, locale);
  return category === 'all' ? matches : matches.filter((entry) => entry.category === category);
}

/**
 * The term a reader reaches by following the first related link of `id` that exists in the
 * glossary. Unknown ids and entries whose related targets are not written yet return null.
 */
export function nextRelated(id: string): string | null {
  const entry = GLOSSARY_BY_ID[id];
  if (!entry) return null;
  for (const relatedId of entry.related) {
    if (GLOSSARY_BY_ID[relatedId]) return relatedId;
  }
  return null;
}

export interface GlossaryDrawerProps {
  open: boolean;
  onClose: () => void;
  initialTermId?: string;
  locale: Locale;
}

/**
 * Searchable glossary drawer: category chips and a result list on the left, the selected
 * term's plain/technical explanations and related chips on the right.
 */
export function GlossaryDrawer({ open, onClose, initialTermId, locale }: GlossaryDrawerProps) {
  const labels = MESSAGES[locale].glossary;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GlossaryCategoryFilter>('all');
  const [activeId, setActiveId] = useState<string | null>(initialTermId ?? GLOSSARY[0]?.id ?? null);
  const [tab, setTab] = useState<GlossaryDetailTab>('plain');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const detailId = useId();

  const results = useMemo(
    () => filterGlossary(query, category, locale),
    [query, category, locale],
  );
  const active = (activeId ? GLOSSARY_BY_ID[activeId] : undefined) ?? GLOSSARY[0] ?? null;
  const related = active
    ? active.related.flatMap((relatedId) => {
        const target = GLOSSARY_BY_ID[relatedId];
        return target ? [{ id: relatedId, term: target.term }] : [];
      })
    : [];

  useEffect(() => {
    if (!open) return;
    setActiveId(initialTermId && GLOSSARY_BY_ID[initialTermId] ? initialTermId : GLOSSARY[0]?.id ?? null);
    setQuery('');
    setCategory('all');
    setTab('plain');
  }, [open, initialTermId]);

  function showRelated(id: string) {
    setActiveId(id);
    setQuery('');
    setCategory('all');
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (!dialog.open) dialog.showModal();
    searchRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="glossary-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="glossary-drawer__panel">
        <header className="glossary-drawer__header">
          <h2 className="glossary-drawer__title" id={titleId}>{labels.title}</h2>
          <Button variant="ghost" size="icon-sm" aria-label={labels.close} onClick={onClose}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </header>

        <div className="glossary-drawer__body">
          <div className="glossary-drawer__sidebar">
            <Input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={labels.search}
              aria-label={labels.search}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />

            <div className="glossary-drawer__filters" role="group" aria-label={labels.title}>
              <Button
                type="button"
                variant={category === 'all' ? 'default' : 'outline'}
                size="xs"
                aria-pressed={category === 'all'}
                onClick={() => setCategory('all')}
              >
                {labels.all}
              </Button>
              {GLOSSARY_CATEGORIES.map((item) => (
                <Button
                  key={item}
                  type="button"
                  variant={category === item ? 'default' : 'outline'}
                  size="xs"
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
                >
                  {CATEGORY_LABELS[item][locale]}
                </Button>
              ))}
            </div>

            {results.length === 0 ? (
              <p className="glossary-drawer__empty" role="status">{labels.empty}</p>
            ) : (
              <ul className="glossary-drawer__results" aria-label={labels.title}>
                {results.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="glossary-drawer__result"
                      aria-current={active?.id === entry.id ? 'true' : undefined}
                      onClick={() => setActiveId(entry.id)}
                    >
                      <span className="glossary-drawer__result-term">{entry.term}</span>
                      <span className="glossary-drawer__result-one-liner">
                        {locale === 'zh' ? entry.oneLiner_zh : entry.oneLiner_en}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {active ? (
            <article className="glossary-drawer__detail" aria-live="polite">
              <div className="glossary-drawer__detail-head">
                <h3 className="glossary-drawer__term">{active.term}</h3>
                <Badge variant="outline">{CATEGORY_LABELS[active.category][locale]}</Badge>
              </div>
              <p className="glossary-drawer__one-liner">
                {locale === 'zh' ? active.oneLiner_zh : active.oneLiner_en}
              </p>

              <div className="glossary-drawer__tabs" role="tablist" aria-label={labels.title}>
                {DETAIL_TABS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`${detailId}-${key}-tab`}
                    aria-selected={tab === key}
                    aria-controls={`${detailId}-${key}-panel`}
                    tabIndex={tab === key ? 0 : -1}
                    className="glossary-drawer__tab"
                    onClick={() => setTab(key)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const nextTab: GlossaryDetailTab = key === 'plain' ? 'pro' : 'plain';
                      setTab(nextTab);
                      event.currentTarget.ownerDocument
                        .getElementById(`${detailId}-${nextTab}-tab`)
                        ?.focus();
                    }}
                  >
                    {key === 'plain' ? labels.plain : labels.pro}
                  </button>
                ))}
              </div>

              {DETAIL_TABS.map((key) => (
                <div
                  key={key}
                  className="glossary-drawer__explain"
                  role="tabpanel"
                  id={`${detailId}-${key}-panel`}
                  aria-labelledby={`${detailId}-${key}-tab`}
                  hidden={tab !== key}
                >
                  {key === 'plain'
                    ? (locale === 'zh' ? active.plainExplain_zh : active.plainExplain_en)
                    : (locale === 'zh' ? active.proExplain_zh : active.proExplain_en)}
                </div>
              ))}

              {related.length > 0 ? (
                <section className="glossary-drawer__related" aria-label={labels.related}>
                  <h4 className="glossary-drawer__label">{labels.related}</h4>
                  <div className="glossary-drawer__chips">
                    {related.map(({ id, term }) => (
                      <Button
                        key={id}
                        type="button"
                        variant="secondary"
                        size="xs"
                        className="rounded-full"
                        onClick={() => showRelated(id)}
                      >
                        {term}
                      </Button>
                    ))}
                  </div>
                </section>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
