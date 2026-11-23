import { expect, test } from 'vitest';
import goldenCase from './__fixtures__/goldenCase.json';
import { OFFICIAL_STAGE1_CASE_ID, parseAndValidateCaseBundle, SAVED_CASES_CAP } from './caseReplay';
import { caseReplayReducer, createCaseReplayState } from './caseReplayState';

const parsed = parseAndValidateCaseBundle(goldenCase);
if (!parsed.ok) throw new Error(parsed.errors.join(' '));
const bundle = parsed.bundle;

test('defaults to the tutorial and makes hydrated cases available for selection', () => {
  const state = createCaseReplayState([bundle]);
  expect(state).toEqual({
    activeCaseId: OFFICIAL_STAGE1_CASE_ID,
    savedCases: [bundle],
    replayActive: false,
    stepIndex: 0,
  });
  expect(caseReplayReducer(state, { type: 'select_case', caseId: bundle.case_id })).toEqual({
    ...state,
    activeCaseId: bundle.case_id,
    replayActive: true,
  });
  expect(caseReplayReducer(state, { type: 'select_case', caseId: 'missing' })).toBe(state);
});

test('loads the golden case from the beginning and replaces a previous import with the same ID', () => {
  const initial = createCaseReplayState([]);
  const loaded = caseReplayReducer(initial, { type: 'load_case', bundle });
  expect(loaded).toEqual({
    activeCaseId: goldenCase.case_id,
    savedCases: [bundle],
    replayActive: true,
    stepIndex: 0,
  });
  expect(loaded.savedCases[0].graph).toEqual(goldenCase.graph);
  expect(loaded.savedCases[0].trace).toEqual(goldenCase.trace);

  const inProgress = caseReplayReducer(loaded, { type: 'set_step', stepIndex: 5 });
  const updated = { ...bundle, title: 'Updated replay' };
  expect(caseReplayReducer(inProgress, { type: 'load_case', bundle: updated })).toEqual({
    ...loaded,
    savedCases: [updated],
  });
  expect(initial.savedCases).toEqual([]);
  expect(loaded.savedCases[0]).toBe(bundle);
});

test('resets to the tutorial and keeps the imported case history', () => {
  const loaded = caseReplayReducer(createCaseReplayState([]), { type: 'load_case', bundle });
  const inProgress = caseReplayReducer(loaded, { type: 'set_step', stepIndex: 3 });
  expect(caseReplayReducer(inProgress, { type: 'reset_tutorial' })).toEqual(createCaseReplayState([bundle]));
});

test.each([OFFICIAL_STAGE1_CASE_ID, bundle.case_id])('preserves the playhead for %s on locale change', (caseId) => {
  const selected = caseReplayReducer(createCaseReplayState([bundle]), { type: 'select_case', caseId });
  const inProgress = caseReplayReducer(selected, { type: 'set_step', stepIndex: 2 });
  expect(caseReplayReducer(inProgress, { type: 'locale_changed', locale: 'zh' })).toBe(inProgress);
});

test('keeps the official tutorial selectable when the oldest custom case is evicted', () => {
  const history = Array.from({ length: SAVED_CASES_CAP }, (_, index) => ({ ...bundle, case_id: `case-${index}` }));
  const loaded = caseReplayReducer(createCaseReplayState(history), { type: 'load_case', bundle });

  expect(loaded.savedCases).toEqual([bundle, ...history.slice(0, -1)]);
  const inProgress = caseReplayReducer(loaded, { type: 'set_step', stepIndex: 3 });
  expect(caseReplayReducer(inProgress, { type: 'select_case', caseId: OFFICIAL_STAGE1_CASE_ID })).toEqual({
    ...loaded,
    activeCaseId: OFFICIAL_STAGE1_CASE_ID,
    stepIndex: 0,
  });
});

test('reserves the tutorial ID across storage hydration and import', () => {
  const collision = { ...bundle, case_id: OFFICIAL_STAGE1_CASE_ID };
  const state = createCaseReplayState([collision, bundle]);
  expect(state.savedCases).toEqual([bundle]);
  expect(caseReplayReducer(state, { type: 'load_case', bundle: collision })).toEqual({
    ...state,
    replayActive: true,
  });
});

test('starting and stopping replay keeps the selected case', () => {
  const loaded = caseReplayReducer(createCaseReplayState([]), { type: 'load_case', bundle });
  const stopped = caseReplayReducer(loaded, { type: 'stop_replay' });
  expect(stopped).toEqual({ ...loaded, replayActive: false });
  expect(caseReplayReducer(stopped, { type: 'start_replay' })).toEqual({ ...loaded, stepIndex: 1 });
});
