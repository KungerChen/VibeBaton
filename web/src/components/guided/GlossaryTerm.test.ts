import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { I18nProvider } from '../../i18n';
import { GlossaryTerm, glossaryCardContent, splitGlossarySegments } from './index';

function render(termId: string, defaultOpen = false): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, { children: createElement(GlossaryTerm, { termId, defaultOpen, children: 'the RFC' }) }),
  );
}

describe('splitGlossarySegments', () => {
  test('marks only the first occurrence per paragraph and preserves all text', () => {
    const text = 'Write the RFC, then refine the RFC.\n\nThe RFC drives the Plan DAG.';
    const segments = splitGlossarySegments(text, 'en');
    expect(segments.map(({ text: run }) => run).join('')).toBe(text);
    expect(segments.filter(({ termId }) => termId !== null)).toEqual([
      { text: 'RFC', termId: 'rfc' },
      { text: 'RFC', termId: 'rfc' },
      { text: 'Plan DAG', termId: 'plan-dag' },
    ]);
    expect(segments[0]).toEqual({ text: 'Write the ', termId: null });
  });

  test('returns one plain segment when nothing matches, including empty text', () => {
    expect(splitGlossarySegments('Nothing to explain here.', 'en')).toEqual([
      { text: 'Nothing to explain here.', termId: null },
    ]);
    expect(splitGlossarySegments('', 'zh')).toEqual([{ text: '', termId: null }]);
  });
});

describe('glossaryCardContent', () => {
  test('localizes the card and keeps only written related terms', () => {
    const en = glossaryCardContent('commit', 'en');
    const zh = glossaryCardContent('commit', 'zh');
    expect(en).toMatchObject({ id: 'commit', term: 'Commit' });
    expect(en?.plain).toContain('save');
    expect(zh?.plain).toMatch(/\p{Script=Han}/u);
    for (const { id } of en?.related ?? []) expect(glossaryCardContent(id, 'en')).not.toBeNull();
    expect(glossaryCardContent('no-such-term', 'en')).toBeNull();
  });
});

describe('GlossaryTerm', () => {
  test('renders a closed dotted-underline trigger around its children', () => {
    const html = render('rfc');
    expect(html).toContain('class="glossary-term__trigger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('the RFC');
    expect(html).not.toContain('glossary-term__popover');
  });

  test('open popover shows plain and technical explanations plus related chips', () => {
    const html = render('rfc', true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('In plain words');
    expect(html).toContain('Technical detail');
    expect(html).toContain('Related terms');
    expect(html).toContain('.baton/00_RFC.md');
    expect(html).toContain('class="glossary-term__chip"');
    expect(html).toContain('>Plan DAG</button>');
  });

  test('renders unknown terms as plain children', () => {
    expect(render('no-such-term', true)).toBe('the RFC');
  });
});
