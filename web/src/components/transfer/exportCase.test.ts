import { expect, test } from 'vitest';
import goldenCase from '../../engine/__fixtures__/goldenCase.json';
import { parseAndValidateCaseBundle } from '../../engine/caseReplay';
import { MESSAGES } from '../../i18n/messages';
import { caseFileName, checklistRows, serializeCase } from './exportCase';

const goldenResult = parseAndValidateCaseBundle(goldenCase);
if (!goldenResult.ok) throw new Error(goldenResult.errors.join(' '));
const { bundle } = goldenResult;

test.each(['en', 'zh'] as const)('localizes all six Golden Example counters in order in %s', (locale) => {
  const copy = MESSAGES[locale].transfer.exportCaseModal;
  expect(checklistRows(goldenCase.redaction_report, locale)).toEqual({
    rows: [
      { key: 'secrets', label: copy.secrets, count: 4 },
      { key: 'paths', label: copy.paths, count: 4 },
      { key: 'emails', label: copy.emails, count: 1 },
      { key: 'ips', label: copy.ips, count: 1 },
      { key: 'diffs', label: copy.diffs, count: 1 },
      { key: 'stacks', label: copy.stacks, count: 1 },
    ],
    verifiedClean: true,
  });
});

test('reads the matching report field for each counter', () => {
  const report = {
    ...goldenCase.redaction_report,
    secrets_redacted: 0,
    paths_anonymized: 2,
    emails_redacted: 3,
    ips_redacted: 4,
    raw_diff_stripped: 5,
    raw_stack_stripped: 6,
  };
  expect(checklistRows(report, 'en').rows.map(({ count }) => count)).toEqual([0, 2, 3, 4, 5, 6]);
});

test.each([true, false])('maps clean=%s directly to verifiedClean', (clean) => {
  const report = { ...goldenCase.redaction_report, clean };
  expect(checklistRows(report, 'en').verifiedClean).toBe(clean);
});

test.each([
  [bundle.title, 'sanitized-run-case'],
  ['  Case / One: Replay!  ', 'case-one-replay'],
  ['运行 案例', '运行-案例'],
  [' /? ', 'run-case'],
])('uses the title %s to create a safe case filename', (title, slug) => {
  expect(caseFileName({ ...bundle, title })).toBe(`${slug}.baton-case.json`);
});

test('pretty-prints a case that can be imported again', () => {
  const json = serializeCase(bundle);
  expect(json).toMatch(/^\{\n {2}"schema_version": "baton-case\/v1",\n/);
  expect(parseAndValidateCaseBundle(JSON.parse(json))).toEqual({ ok: true, bundle, warnings: [] });
});
