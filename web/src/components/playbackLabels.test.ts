import { describe, expect, test } from 'vitest';
import { MESSAGES } from '../i18n/messages';
import { CASE_OPTION_PREFIX, replayToggleLabel, switcherOptions } from './playbackLabels';

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const OPENCODE_PATTERN = /opencode/i;
const OFFICIAL_ID = 'official-stage1';
const savedCases = [
  { case_id: 'case-d34fcd56467b', title: 'Sanitized Run Case' },
  { case_id: '__import_case__', title: 'Imported Case' },
];

describe('replayToggleLabel', () => {
  test('reads the tutorial label while the official tutorial is active', () => {
    const label = { isCustomCaseActive: false, activeCaseTitle: 'Ignored title' };

    expect(replayToggleLabel(label, MESSAGES.en)).toBe('Tutorial: Stage 1 (60×)');
    expect(replayToggleLabel(label, MESSAGES.zh)).toBe('示范教程：一期真跑');
  });

  test('prefixes the start label with the active custom case title', () => {
    const label = { isCustomCaseActive: true, activeCaseTitle: 'Sanitized Run Case' };

    expect(replayToggleLabel(label, MESSAGES.en)).toBe('▶ Start: Sanitized Run Case');
    expect(replayToggleLabel(label, MESSAGES.zh)).toBe('▶ 开始回放：Sanitized Run Case');
  });
});

describe('switcherOptions', () => {
  const messages = MESSAGES.en;
  const copy = messages.transfer.playback;

  test('lists the official tutorial first, then every saved case', () => {
    const options = switcherOptions(savedCases, OFFICIAL_ID, messages);

    expect(options.map(({ kind }) => kind)).toEqual(['case', 'case', 'case', 'import', 'reset']);
    expect(options[0]).toEqual({
      kind: 'case',
      value: CASE_OPTION_PREFIX + OFFICIAL_ID,
      label: messages.playback.replayButton,
      caseId: OFFICIAL_ID,
    });
    expect(options.slice(1, 3)).toEqual(savedCases.map(({ case_id, title }) => ({
      kind: 'case',
      value: CASE_OPTION_PREFIX + case_id,
      label: title,
      caseId: case_id,
    })));
  });

  test('keeps the official tutorial first even when the saved list repeats it', () => {
    const options = switcherOptions([{ case_id: OFFICIAL_ID, title: 'Stale copy' }, ...savedCases], OFFICIAL_ID, messages);

    expect(options[0].label).toBe(messages.playback.replayButton);
    expect(options.filter((option) => option.kind === 'case' && option.caseId === OFFICIAL_ID)).toHaveLength(1);
  });

  test('appends the import and reset actions with stable action values', () => {
    const options = switcherOptions(savedCases, OFFICIAL_ID, messages);

    expect(options.at(-2)).toEqual({ kind: 'import', value: 'import', label: copy.importAnother });
    expect(options.at(-1)).toEqual({ kind: 'reset', value: 'reset', label: copy.resetTutorial });
  });

  test('prefixes case values so arbitrary case ids never collide with actions', () => {
    const options = switcherOptions(savedCases, OFFICIAL_ID, messages);
    const caseOptions = options.filter((option) => option.kind === 'case');

    expect(caseOptions.map((option) => option.caseId)).toEqual([OFFICIAL_ID, 'case-d34fcd56467b', '__import_case__']);
    for (const option of caseOptions) {
      expect(option.value).toBe(CASE_OPTION_PREFIX + option.caseId);
      expect(option.value).not.toBe('import');
      expect(option.value).not.toBe('reset');
    }
    expect(new Set(options.map(({ value }) => value)).size).toBe(options.length);
  });

  test('keeps every label free of provider names and the English labels free of CJK', () => {
    for (const locale of ['en', 'zh'] as const) {
      for (const { label } of switcherOptions(savedCases, OFFICIAL_ID, MESSAGES[locale])) {
        expect(label).not.toMatch(OPENCODE_PATTERN);
      }
    }

    const englishLabels = [
      replayToggleLabel({ isCustomCaseActive: false, activeCaseTitle: '' }, messages),
      replayToggleLabel({ isCustomCaseActive: true, activeCaseTitle: 'Sanitized Run Case' }, messages),
      ...switcherOptions(savedCases, OFFICIAL_ID, messages).map(({ label }) => label),
    ];
    for (const label of englishLabels) {
      expect(label).not.toMatch(CJK_PATTERN);
    }
  });
});
