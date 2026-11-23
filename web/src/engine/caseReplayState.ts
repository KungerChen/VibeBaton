import type { Locale } from '../i18n/messages';
import type { BatonCaseBundle } from '../types/graph';
import { OFFICIAL_STAGE1_CASE_ID, upsertSavedCase } from './caseReplay';

export interface CaseReplayState {
  activeCaseId: string;
  /** The built-in tutorial is available independently of the saved case history. */
  savedCases: BatonCaseBundle[];
  replayActive: boolean;
  stepIndex: number;
}

export type CaseReplayAction =
  | { type: 'load_case'; bundle: BatonCaseBundle }
  | { type: 'select_case'; caseId: string }
  | { type: 'reset_tutorial' }
  | { type: 'locale_changed'; locale: Locale }
  | { type: 'start_replay' }
  | { type: 'stop_replay' }
  | { type: 'set_step'; stepIndex: number };

export function createCaseReplayState(savedCases: BatonCaseBundle[]): CaseReplayState {
  return {
    activeCaseId: OFFICIAL_STAGE1_CASE_ID,
    savedCases: savedCases.filter(({ case_id }) => case_id !== OFFICIAL_STAGE1_CASE_ID),
    replayActive: false,
    stepIndex: 0,
  };
}

export function caseReplayReducer(state: CaseReplayState, action: CaseReplayAction): CaseReplayState {
  switch (action.type) {
    case 'load_case':
      return {
        activeCaseId: action.bundle.case_id,
        savedCases: action.bundle.case_id === OFFICIAL_STAGE1_CASE_ID
          ? state.savedCases
          : upsertSavedCase(state.savedCases, action.bundle),
        replayActive: true,
        stepIndex: 0,
      };
    case 'select_case':
      if (action.caseId !== OFFICIAL_STAGE1_CASE_ID && !state.savedCases.some(({ case_id }) => case_id === action.caseId)) {
        return state;
      }
      return { ...state, activeCaseId: action.caseId, replayActive: true, stepIndex: 0 };
    case 'reset_tutorial':
      return { ...state, activeCaseId: OFFICIAL_STAGE1_CASE_ID, replayActive: false, stepIndex: 0 };
    case 'locale_changed':
      // The workspace derives the localized tutorial bundle without resetting the playhead.
      return state;
    case 'start_replay':
      return { ...state, replayActive: true, stepIndex: 1 };
    case 'stop_replay':
      return { ...state, replayActive: false, stepIndex: 0 };
    case 'set_step':
      return state.stepIndex === action.stepIndex ? state : { ...state, stepIndex: action.stepIndex };
  }
}
