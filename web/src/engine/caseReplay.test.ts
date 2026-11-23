import { describe, expect, test, vi } from 'vitest';
import { flagship_4tier, starter_2tier } from '../data/presets';
import { getStage1ReplayTrace, STAGE1_REPLAY_META } from '../data/stage1Replay';
import { MESSAGES } from '../i18n/messages';
import type { BatonCaseBundle, CaseRedactionReport, CaseReplayMeta, WorkflowGraph } from '../types/graph';
import goldenCase from './__fixtures__/goldenCase.json';
import {
  buildOfficialStage1Case,
  caseSummaryPill,
  detectTransferInput,
  isCaseBundleInput,
  OFFICIAL_STAGE1_CASE_ID,
  parseAndValidateCaseBundle,
  readSavedCases,
  SAVED_CASES_CAP,
  SAVED_CASES_KEY,
  upsertSavedCase,
  writeSavedCases,
} from './caseReplay';
import { validateGraph } from './localSimulator';
import { buildShareUrl, encodeRecipeHash } from './shareUrl';

const graphWithDanglingEdge: WorkflowGraph = {
  ...starter_2tier,
  edges: [...starter_2tier.edges, { id: 'broken', source: 'plan', target: 'missing-node' }],
};

function loadGoldenCase(): BatonCaseBundle {
  const result = parseAndValidateCaseBundle(goldenCase);
  if (!result.ok) throw new Error(result.errors.join(' '));
  return result.bundle;
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
}

describe('parseAndValidateCaseBundle', () => {
  test('imports the backend Golden Example as a typed frontend case', () => {
    const result = parseAndValidateCaseBundle(goldenCase);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join(' '));

    const bundle: BatonCaseBundle = result.bundle;
    const expectedMeta: CaseReplayMeta = {
      ...goldenCase.meta,
      models: ['deepseek-flash', 'plan-default', 'review-default', 'signoff'],
    };
    const expectedReport: CaseRedactionReport = goldenCase.redaction_report;
    expect(bundle).toEqual({ ...goldenCase, meta: expectedMeta, redaction_report: expectedReport });
    expect(result.warnings).toEqual([]);
    expect(parseAndValidateCaseBundle(bundle)).toEqual(result);
  });

  test.each([
    ['the wrong schema version', { ...goldenCase, schema_version: 'baton-case/v2' }, /schema_version/],
    ['a missing title', { ...goldenCase, title: undefined }, /title/],
    ['an empty trace', { ...goldenCase, trace: [] }, /at least one event/],
    ['a non-numeric seq', { ...goldenCase, trace: [{ ...goldenCase.trace[0], seq: '1' }] }, /numeric seq/],
    ['an invalid graph', { ...goldenCase, graph: graphWithDanglingEdge }, /dangling target 'missing-node'/],
    ['invalid run metrics', { ...goldenCase, meta: { ...goldenCase.meta, tasks_passed: '1' } }, /meta/],
    ['an invalid redaction report', { ...goldenCase, redaction_report: {} }, /redaction_report/],
  ])('rejects %s', (_label, input, error) => {
    expect(parseAndValidateCaseBundle(input)).toEqual({ ok: false, errors: [expect.stringMatching(error)] });
  });

  test.each([
    ['sk- token', 'sk-synthetic_example_123', /credential/i],
    ['ghp_ token', 'ghp_syntheticToken0123456789', /credential/i],
    ['github_pat_ token', 'github_pat_synthetic_token_0123456789', /credential/i],
    ['AIza token', 'AIzaSyntheticToken0123456789', /credential/i],
    ['Bearer token after whitespace', 'Bearer\nsynthetic-token-0123', /credential/i],
    ['email address', 'sample@example.test', /email/i],
  ])('warns about a residual %s and accepts the case', (_label, sample, warning) => {
    const trace = [{ ...goldenCase.trace[0], message: sample }];
    const result = parseAndValidateCaseBundle({ ...goldenCase, trace });
    expect(result).toMatchObject({
      ok: true,
      bundle: { trace, redaction_report: { clean: false } },
      warnings: [expect.stringMatching(warning)],
    });
    if (result.ok) expect(result.warnings.join(' ')).not.toContain(sample);
  });

  test('checks nested field names and model providers before normalizing', () => {
    const result = parseAndValidateCaseBundle({
      ...goldenCase,
      meta: {
        ...goldenCase.meta,
        models: [{ provider: 'sk-synthetic_example_123', model: 'sample-model' }],
        billing: { 'sample@example.test': 0 },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      bundle: { meta: { models: ['sample-model'] }, redaction_report: { clean: false } },
      warnings: [expect.stringMatching(/credential/i), expect.stringMatching(/email/i)],
    });
  });
});

describe('detectTransferInput', () => {
  test('uses the case format marker for identification', () => {
    expect(isCaseBundleInput({ schema_version: 'baton-case/v1' })).toBe(true);
    expect(isCaseBundleInput(starter_2tier)).toBe(false);
    expect(isCaseBundleInput(null)).toBe(false);
  });

  test('detects recipe JSON and case JSON', () => {
    expect(detectTransferInput(JSON.stringify(starter_2tier))).toEqual({ kind: 'recipe', graph: starter_2tier });
    expect(detectTransferInput(JSON.stringify(goldenCase))).toEqual({ kind: 'case', bundle: loadGoldenCase() });
  });

  test('normalizes legacy recipe edges into the canvas format', () => {
    const graph = {
      ...starter_2tier,
      edges: starter_2tier.edges.map(({ sourceHandle, targetHandle, max_loops, ...edge }) => ({
        ...edge, source_handle: sourceHandle, target_handle: targetHandle, maxLoops: max_loops,
      })),
    };
    for (const input of [JSON.stringify(graph), encodeRecipeHash(graph)]) {
      expect(detectTransferInput(input)).toEqual({ kind: 'recipe', graph: starter_2tier });
    }
  });

  test('decodes full recipe share URLs and standalone fragments', () => {
    const url = buildShareUrl(starter_2tier, 'https://studio.example.test/#previous');
    const hash = encodeRecipeHash(starter_2tier);
    for (const input of [`  ${url}\n`, hash]) {
      expect(detectTransferInput(input)).toEqual({ kind: 'recipe', graph: starter_2tier });
    }
  });

  test.each([
    ['plain text', 'unrecognized text', /Enter a recipe/],
    ['JSON null', 'null', /JSON object/],
    ['a malformed fragment', '#recipe=invalid+encoding', /Malformed recipe encoding/],
    ['an incomplete case', JSON.stringify({ schema_version: 'baton-case/v1' }), /case_id/],
    ['a future case version', JSON.stringify({ ...goldenCase, schema_version: 'baton-case/v2' }), /schema_version/],
    ['an invalid recipe graph', JSON.stringify(graphWithDanglingEdge), /dangling target 'missing-node'/],
    ['a non-string node role', JSON.stringify({
      ...starter_2tier,
      nodes: [{ ...starter_2tier.nodes[0], role: 17 }, ...starter_2tier.nodes.slice(1)],
    }), /nodes\[0\]\.role/],
  ])('rejects %s', (_label, input, error) => {
    expect(detectTransferInput(input)).toEqual({ kind: 'invalid', errors: [expect.stringMatching(error)] });
  });

  test('keeps redaction warnings visible on detected cases', () => {
    const input = JSON.stringify({ ...goldenCase, summary: 'Contact sample@example.test' });
    expect(detectTransferInput(input)).toMatchObject({ kind: 'case', bundle: { redaction_report: { clean: false } } });
  });
});

test.each(['en', 'zh'] as const)('builds the official Stage 1 replay in %s', (locale) => {
  const bundle = buildOfficialStage1Case(locale);
  expect(bundle.case_id).toBe('official-stage1');
  expect(bundle.case_id).toBe(OFFICIAL_STAGE1_CASE_ID);
  expect(bundle.isOfficialTutorial).toBe(true);
  expect(bundle.graph).toEqual(flagship_4tier);
  expect(validateGraph(bundle.graph).valid).toBe(true);
  expect(bundle.trace).toEqual(getStage1ReplayTrace(locale));
  expect(bundle.meta).toMatchObject({
    source_run_id: STAGE1_REPLAY_META.runId,
    elapsed_sec: STAGE1_REPLAY_META.elapsedSec,
    milestones_passed: 3,
    milestones_total: 3,
    tasks_passed: 9,
    tasks_total: 9,
  });
  expect(bundle.redaction_report.clean).toBe(true);
  expect(parseAndValidateCaseBundle(bundle)).toEqual({ ok: true, bundle, warnings: [] });
});

test('formats localized replay pills and reflects a redaction warning', () => {
  const bundle = loadGoldenCase();
  expect(caseSummaryPill(bundle, 'en')).toBe('9.0s · 1/1 tasks · sanitized replay');
  expect(caseSummaryPill(bundle, 'zh')).toBe('9.0秒 · 1/1 项任务 · 脱敏回放');
  const flagged = { ...bundle, redaction_report: { ...bundle.redaction_report, clean: false } };
  expect(caseSummaryPill(flagged, 'en')).toBe('9.0s · 1/1 tasks · review redaction');
});

test('uses ASCII for English transfer message copy', () => {
  const { transfer } = MESSAGES.en;
  expect(JSON.stringify(transfer)).toMatch(/^[\x00-\x7f]+$/);
  expect(transfer.playback.summaryPill('2m', 3, 4)).toMatch(/^[\x00-\x7f]+$/);
});

describe('saved replay cases', () => {
  test('upserts by case ID and persists the ten most recently imported cases', () => {
    const storage = memoryStorage();
    const bundle = loadGoldenCase();
    const oversized = Array.from({ length: SAVED_CASES_CAP + 2 }, (_, index) => (
      { ...bundle, case_id: `case-${index}` }
    ));
    const revised = { ...oversized[1], title: 'Reimported', created_at: '2021-01-01T00:00:00Z' };
    const expected = [revised, oversized[0], ...oversized.slice(2, 10)];

    const cases = upsertSavedCase(oversized, revised);
    expect(cases).toEqual(expected);
    expect(cases).toHaveLength(10);
    expect(oversized[1].title).toBe(bundle.title);

    writeSavedCases([revised, ...oversized], storage);
    expect(SAVED_CASES_KEY).toBe('vibebaton.importedCases.v1');
    expect(storage.getItem(SAVED_CASES_KEY)).toBe(JSON.stringify(expected));
    expect(readSavedCases(storage)).toEqual(expected);
  });

  test('validates saved entries and removes duplicates from older stored data', () => {
    const storage = memoryStorage();
    const revised = { ...goldenCase, title: 'Newer import' };
    storage.setItem(SAVED_CASES_KEY, JSON.stringify([revised, { ...goldenCase, trace: [] }, goldenCase]));
    expect(readSavedCases(storage)).toEqual([{ ...loadGoldenCase(), title: 'Newer import' }]);
  });

  test('uses browser localStorage when no storage is supplied', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    try {
      const bundle = loadGoldenCase();
      writeSavedCases([bundle]);
      expect(readSavedCases()).toEqual([bundle]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('returns an empty history for unreadable or corrupt storage', () => {
    const storage = memoryStorage();
    expect(readSavedCases(storage)).toEqual([]);
    storage.setItem(SAVED_CASES_KEY, '{unreadable');
    expect(readSavedCases(storage)).toEqual([]);
    expect(readSavedCases({
      getItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
    })).toEqual([]);
  });

  test('quota-exceeded writes let replay continue', () => {
    expect(() => writeSavedCases([loadGoldenCase()], {
      setItem: () => { throw new DOMException('Storage full', 'QuotaExceededError'); },
    })).not.toThrow();
  });
});
