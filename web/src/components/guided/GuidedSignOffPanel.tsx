import './GuidedSignOffPanel.css';
import { useRef, useState } from 'react';
import {
  BatonApiClient,
  type FinalizeAction,
  type FinalizeRequest,
  type FinalizeResult,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';

/** Everything the final verification card needs to render one run. */
export interface SignOffSummary {
  testsPassed: number;
  testsTotal: number;
  changedFiles: string[];
  reportUrl: string;
}

/** Localized, render-ready view of a sign-off summary. */
export interface SignOffDigest {
  /** Pass count plus the localized headline; claims success only when every test passed. */
  tests: string;
  /** Localized changed-files heading with the number of files. */
  changedFiles: string;
  /** Battle Report URL supplied by the caller; '' means the panel derives it from the run id. */
  reportUrl: string;
  /** True only when there is at least one test and every test passed. */
  allPassed: boolean;
}

/** Map a sign-off action and note to the exact payload the finalize endpoint expects. */
export function buildFinalizePayload(action: FinalizeAction, note: string): FinalizeRequest {
  const trimmed = note.trim();
  return trimmed ? { action, note: trimmed } : { action };
}

/** Localize the test result and file count without claiming more than the data supports. */
export function summarizeSignOff(summary: SignOffSummary, locale: Locale): SignOffDigest {
  const copy = MESSAGES[locale].guided.signOff;
  const allPassed = summary.testsTotal > 0 && summary.testsPassed === summary.testsTotal;
  const testCount = `${summary.testsPassed}/${summary.testsTotal}`;
  return {
    tests: allPassed ? `${testCount} · ${copy.testsPassed}` : testCount,
    changedFiles: `${copy.changedFiles} (${summary.changedFiles.length})`,
    reportUrl: summary.reportUrl,
    allPassed,
  };
}

export type SignOffFinalizer = (
  runId: string,
  payload: FinalizeRequest,
) => Promise<FinalizeResult>;

/** Default finalizer for the same-origin Studio API. Callers may inject their own client call. */
async function finalizeRun(runId: string, payload: FinalizeRequest): Promise<FinalizeResult> {
  const client = new BatonApiClient();
  await client.init();
  return client.finalizeRun(runId, payload);
}

export interface GuidedSignOffPanelProps {
  runId: string;
  summary: SignOffSummary;
  onFinalized: (result: FinalizeResult) => void;
  locale: Locale;
  /** Overrides the default same-origin `finalizeRun` call, primarily for embedding and tests. */
  finalizer?: SignOffFinalizer;
}

/**
 * Guided Mode step 4: show the verification result, changed files and Battle Report, then let the
 * user approve, request revisions or (after an inline confirmation) restore the pre-run snapshot.
 */
export function GuidedSignOffPanel({
  runId,
  summary,
  onFinalized,
  locale,
  finalizer = finalizeRun,
}: GuidedSignOffPanelProps) {
  const copy = MESSAGES[locale].guided.signOff;
  const digest = summarizeSignOff(summary, locale);
  const [note, setNote] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<FinalizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const locked = busy || completed !== null;
  const reportHref = digest.reportUrl.trim() || `/api/runs/${encodeURIComponent(runId)}/report`;

  async function finalize(action: FinalizeAction) {
    if (inFlight.current || locked) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await finalizer(
        runId,
        buildFinalizePayload(action, action === 'revise' ? note : ''),
      );
      setCompleted(result);
      setConfirmingRollback(false);
      setReviseOpen(false);
      onFinalized(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="guided-sign-off" aria-label={copy.title} aria-busy={busy || undefined}>
      <header className="guided-sign-off__header">
        <div className="guided-sign-off__heading">
          <h2 className="guided-sign-off__title">{copy.title}</h2>
          <code className="guided-sign-off__run" title={runId}>{runId}</code>
        </div>
        <a
          className="guided-sign-off__report"
          href={reportHref}
          target="_blank"
          rel="noreferrer"
        >
          {copy.battleReport}
        </a>
      </header>

      <div className="guided-sign-off__summary">
        <div className="guided-sign-off__tests" data-passed={digest.allPassed ? 'true' : 'false'}>
          <span className="guided-sign-off__dot" aria-hidden="true" />
          <span>{digest.tests}</span>
        </div>

        <div className="guided-sign-off__files">
          <h3 className="guided-sign-off__files-title">{digest.changedFiles}</h3>
          {summary.changedFiles.length > 0 ? (
            <ul className="guided-sign-off__file-list">
              {summary.changedFiles.map((file) => (
                <li key={file} className="guided-sign-off__file">
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {completed?.action === 'approve' ? (
        <p className="guided-sign-off__done" role="status">{copy.done}</p>
      ) : null}

      {error ? (
        <p className="guided-sign-off__error" role="alert">{error}</p>
      ) : null}

      <div className="guided-sign-off__actions">
        <Button
          variant="default"
          size="sm"
          disabled={locked}
          onClick={() => void finalize('approve')}
        >
          {copy.approve}
        </Button>

        {reviseOpen ? (
          <div
            className="guided-sign-off__revise"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setReviseOpen(false);
              }
            }}
          >
            <Textarea
              className="guided-sign-off__note"
              value={note}
              aria-label={copy.revise}
              placeholder={copy.revise}
              disabled={locked}
              autoFocus
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={locked || !note.trim()}
              onClick={() => void finalize('revise')}
            >
              {copy.revise}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => {
              setError(null);
              setConfirmingRollback(false);
              setReviseOpen(true);
            }}
          >
            {copy.revise}
          </Button>
        )}

        <div className="guided-sign-off__rollback">
          <Button
            variant="destructive"
            size="sm"
            disabled={locked}
            onClick={() => {
              if (confirmingRollback) {
                void finalize('rollback');
                return;
              }
              setError(null);
              setReviseOpen(false);
              setConfirmingRollback(true);
            }}
            onKeyDown={(event) => {
              if (confirmingRollback && event.key === 'Escape') {
                event.preventDefault();
                setConfirmingRollback(false);
              }
            }}
          >
            {copy.rollback}
          </Button>
          {confirmingRollback ? (
            <p className="guided-sign-off__confirm" role="alert">{copy.rollbackConfirm}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
