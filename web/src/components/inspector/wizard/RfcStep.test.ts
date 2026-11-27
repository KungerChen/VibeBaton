import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { MESSAGES } from '../../../i18n/messages';
import { droppedFileProblem, MAX_DROPPED_RFC_BYTES, RfcStep, type useRfcDraft } from './RfcStep';

function draft(markdown: string, extra: Partial<ReturnType<typeof useRfcDraft>> = {}): ReturnType<typeof useRfcDraft> {
  return { markdown, checking: false, edit: vi.fn(), readiness: undefined, checkError: false, ...extra };
}

describe('dropping a file onto the RFC box', () => {
  test('takes text files and refuses anything else or anything too large', () => {
    expect(droppedFileProblem({ name: 'plan.md', type: 'text/markdown', size: 1200 })).toBeNull();
    expect(droppedFileProblem({ name: 'plan.MD', type: '', size: 1200 })).toBeNull();
    expect(droppedFileProblem({ name: 'notes.txt', type: 'text/plain', size: MAX_DROPPED_RFC_BYTES })).toBeNull();
    expect(droppedFileProblem({ name: 'shot.png', type: 'image/png', size: 1200 })).toBe('not_text');
    expect(droppedFileProblem({ name: 'spec.docx', type: '', size: 1200 })).toBe('not_text');
    expect(droppedFileProblem({ name: 'huge.md', type: 'text/markdown', size: MAX_DROPPED_RFC_BYTES + 1 })).toBe('too_large');
  });
});

describe('RfcStep', () => {
  test('keeps the readiness score, missing sections and warnings of the old launch wizard', () => {
    const html = renderToStaticMarkup(createElement(RfcStep, {
      rfc: draft('# RFC\n## Goal\nShort', { readiness: {
        score: 45, safe_for_overnight: false, missing_sections: ['constraints', 'acceptance'],
        warnings: ['Goal is shorter than 40 characters.'], detected_commands: [],
      } }),
      onChange: vi.fn(),
    }));
    const wizard = MESSAGES.en.wizard;
    expect(html).toContain(wizard.readinessScore(45));
    expect(html).toContain(`${wizard.warnings.missingSections} · Constraints, Acceptance Criteria`);
    expect(html).toContain(wizard.warnings.shortGoal);
    expect(html).toContain(wizard.warnings.missingVerificationCommand);
    expect(html).toContain(MESSAGES.en.inspector.rfcMarkdownOption);
    expect(html).not.toContain('Generate RFC');
  });

  test('shows the pasted text as plain text and says when it is being checked', () => {
    const html = renderToStaticMarkup(createElement(RfcStep, {
      rfc: draft('<b>not html</b>', { checking: true }), onChange: vi.fn(), readOnly: true,
    }));
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('Checking RFC');
  });
});
