import { MESSAGES, type Locale } from '../../i18n/messages';

/** STOP_PENDING and other 409 errors require their own recovery, not a stale-run notice. */
export function isStaleRunError(failure: unknown): boolean {
  if (typeof failure !== 'object' || failure === null || !('status' in failure) || failure.status !== 409) return false;
  const error = failure as { code?: unknown; data?: { code?: unknown } };
  const code = error.code ?? error.data?.code;
  return code === undefined || code === 'RUN_SUPERSEDED' || code === 'RUN_STALE';
}

/**
 * Translate common Guided-mode API/Git error strings into plain localized wording while keeping
 * unfamiliar technical messages intact for diagnosis.
 */
export function localizeGuidedError(failure: unknown, locale: Locale): string {
  const raw = failure instanceof Error ? failure.message : String(failure);
  const copy = MESSAGES[locale].guided.errors;
  if (/uncommitted changes/i.test(raw)) return copy.dirtyWorkingTree;
  if (/not READY_FOR_FINAL_GATE/i.test(raw)) return copy.notReadyForFinalGate;
  if (/only an approved \(COMPLETED\) run can be rolled back/i.test(raw)) return copy.rollbackRequiresCompleted;
  if (/has moved past this run's merge/i.test(raw)) return copy.rollbackMovedPastMerge;
  if (/revise requires a non-empty note/i.test(raw)) return copy.emptyReviseNote;
  if (/^Request timed out$/i.test(raw)) return copy.requestTimedOut;
  return raw;
}
