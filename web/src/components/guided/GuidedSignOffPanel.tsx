import './GuidedSignOffPanel.css';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import {
  BatonApiClient,
  type FinalizeAction,
  type FinalizeRequest,
  type FinalizeResult,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatUsd } from '../inspector/billingFormat';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import { MarkdownView } from '../ui/MarkdownView';
import { localizeGuidedError } from './guidedErrors';

/** One finished deliverable/task summary shown clearly to users at sign-off. */
export interface SignOffDeliverable {
  id: string;
  title: string;
  status: string;
  summary?: string;
}

/** Everything the final verification card needs to render one run. */
export interface SignOffSummary {
  testsPassed: number;
  testsTotal: number;
  changedFiles: string[];
  reportUrl: string;
  totalCostUsd?: number | null;
  workspacePath?: string | null;
  deliverables?: SignOffDeliverable[];
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
    tests: allPassed ? `${testCount} · ${copy.testsPassed}` : copy.testsSummary(summary.testsPassed, summary.testsTotal),
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
  /** Current run status (e.g. READY_FOR_FINAL_GATE or COMPLETED) so actions track backend rules. */
  runStatus?: string;
  summary: SignOffSummary;
  onFinalized: (result: FinalizeResult) => void;
  locale: Locale;
  /** Overrides the default same-origin `finalizeRun` call, primarily for embedding and tests. */
  finalizer?: SignOffFinalizer;
  /** Fetches markdown Battle Report inline so users can read it directly inside Guided Mode. */
  reportFetcher?: (runId: string, locale: Locale) => Promise<string>;
  /** Opens the project folder or a changed file / reveals it in Explorer/Finder. */
  onOpenPath?: (options: { path?: string; reveal?: boolean }) => Promise<unknown>;
  /** Optional pre-loaded battle report markdown (primarily for tests or offline views). */
  initialReportMarkdown?: string | null;
}

/**
 * Guided Mode step 4: show the verification result, changed files and Battle Report, then let the
 * user approve, request revisions or (after an inline confirmation) restore the pre-run snapshot.
 */
export function GuidedSignOffPanel({
  runId,
  runStatus,
  summary,
  onFinalized,
  locale,
  finalizer = finalizeRun,
  reportFetcher,
  onOpenPath,
  initialReportMarkdown = null,
}: GuidedSignOffPanelProps) {
  const copy = MESSAGES[locale].guided.signOff;
  const digest = summarizeSignOff(summary, locale);
  const [note, setNote] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<FinalizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [reportMarkdown, setReportMarkdown] = useState<string | null>(initialReportMarkdown);
  const [reportLoading, setReportLoading] = useState(Boolean(reportFetcher && initialReportMarkdown === null));
  const [reportError, setReportError] = useState(false);
  const [reportExpanded, setReportExpanded] = useState(true);
  const [copiedReport, setCopiedReport] = useState(false);
  const inFlight = useRef(false);
  const effectiveStatus = completed?.status ?? runStatus;
  const isApproved = effectiveStatus === 'COMPLETED' || completed?.action === 'approve';
  const isTerminal = completed !== null && completed.action !== 'approve';
  const canApproveOrRevise = !busy && !isTerminal && !isApproved
    && (runStatus === undefined || effectiveStatus === 'READY_FOR_FINAL_GATE');
  const canRollback = !busy && !isTerminal
    && (effectiveStatus === 'COMPLETED' || (runStatus === undefined && completed === null));
  const reportHref = digest.reportUrl.trim() || `/api/runs/${encodeURIComponent(runId)}/report`;
  const costDisplay = typeof summary.totalCostUsd === 'number' && Number.isFinite(summary.totalCostUsd)
    ? formatUsd(summary.totalCostUsd, locale)
    : copy.kpiCostUnavailable;
  const deliverables = summary.deliverables ?? [];

  useEffect(() => {
    if (!reportFetcher) return;
    let active = true;
    setReportLoading(true);
    setReportError(false);
    reportFetcher(runId, locale)
      .then((markdown) => {
        if (!active) return;
        setReportMarkdown(markdown);
      })
      .catch(() => {
        if (!active) return;
        setReportError(true);
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => { active = false; };
  }, [runId, locale, reportFetcher]);

  async function triggerOpen(key: string, options: { path?: string; reveal?: boolean }) {
    if (!onOpenPath || openingKey !== null) return;
    setOpeningKey(key);
    setOpenError(null);
    try {
      await onOpenPath(options);
    } catch {
      setOpenError(copy.openFailed);
    } finally {
      setOpeningKey(null);
    }
  }

  async function copyBattleReport() {
    if (!reportMarkdown || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(reportMarkdown);
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      // Ignore clipboard permission denials in non-secure contexts.
    }
  }

  async function finalize(action: FinalizeAction) {
    const allowed = action === 'rollback' ? canRollback : canApproveOrRevise;
    if (inFlight.current || !allowed) return;
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
      setError(localizeGuidedError(failure, locale));
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
        <div className="guided-sign-off__header-actions">
          {onOpenPath && (
            <Button
              variant="secondary"
              size="sm"
              disabled={openingKey !== null}
              onClick={() => void triggerOpen('workspace', {})}
            >
              <FolderOpen size={14} aria-hidden="true" />
              {copy.openFolder}
            </Button>
          )}
          <a
            className="guided-sign-off__report"
            href={reportHref}
            target="_blank"
            rel="noreferrer"
          >
            {copy.battleReport}
          </a>
        </div>
      </header>

      <div className="guided-sign-off__summary">
        <div className="guided-sign-off__kpis">
          <div className="guided-sign-off__kpi" data-passed={digest.allPassed ? 'true' : 'false'}>
            <span className="guided-sign-off__kpi-label">{copy.kpiTests}</span>
            <strong className="guided-sign-off__kpi-value">{summary.testsPassed}/{summary.testsTotal}</strong>
          </div>
          <div className="guided-sign-off__kpi">
            <span className="guided-sign-off__kpi-label">{copy.kpiFiles}</span>
            <strong className="guided-sign-off__kpi-value">{summary.changedFiles.length}</strong>
          </div>
          <div className="guided-sign-off__kpi">
            <span className="guided-sign-off__kpi-label">{copy.kpiCost}</span>
            <strong className="guided-sign-off__kpi-value">{costDisplay}</strong>
          </div>
        </div>

        <div className="guided-sign-off__tests" data-passed={digest.allPassed ? 'true' : 'false'}>
          <span className="guided-sign-off__dot" aria-hidden="true" />
          <span>{digest.tests}</span>
        </div>

        {summary.workspacePath && (
          <div className="guided-sign-off__workspace-bar">
            <span className="guided-sign-off__workspace-label">{copy.workspaceLocation}</span>
            <code className="guided-sign-off__workspace-path">{summary.workspacePath}</code>
            {onOpenPath && (
              <Button
                variant="ghost"
                size="xs"
                disabled={openingKey !== null}
                onClick={() => void triggerOpen('workspace-inline', {})}
              >
                <FolderOpen size={13} aria-hidden="true" />
                {copy.openFolder}
              </Button>
            )}
          </div>
        )}

        {deliverables.length > 0 && (
          <div className="guided-sign-off__deliverables">
            <h3 className="guided-sign-off__files-title">{copy.deliverablesTitle}</h3>
            <ul className="guided-sign-off__deliverable-list">
              {deliverables.map((item) => (
                <li key={item.id} className="guided-sign-off__deliverable">
                  <div className="guided-sign-off__deliverable-head">
                    <strong className="guided-sign-off__deliverable-title">{item.title}</strong>
                    <span className="guided-sign-off__deliverable-status" data-status={item.status}>
                      {item.status}
                    </span>
                  </div>
                  {item.summary && (
                    <p className="guided-sign-off__deliverable-summary">{item.summary}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="guided-sign-off__files">
          <h3 className="guided-sign-off__files-title">{digest.changedFiles}</h3>
          {openError && <p className="guided-sign-off__error" role="alert">{openError}</p>}
          {summary.changedFiles.length > 0 ? (
            <ul className="guided-sign-off__file-list">
              {summary.changedFiles.map((file) => (
                <li key={file} className="guided-sign-off__file">
                  <code>{file}</code>
                  {onOpenPath && (
                    <div className="guided-sign-off__file-actions">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={openingKey !== null}
                        onClick={() => void triggerOpen(`open:${file}`, { path: file, reveal: false })}
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        {copy.openFile}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={openingKey !== null}
                        onClick={() => void triggerOpen(`reveal:${file}`, { path: file, reveal: true })}
                      >
                        <FolderOpen size={12} aria-hidden="true" />
                        {copy.revealFile}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {(reportFetcher || reportMarkdown !== null || reportError) && (
          <div className="guided-sign-off__inline-report">
            <div className="guided-sign-off__inline-report-head">
              <h3 className="guided-sign-off__files-title">{copy.battleReportInline}</h3>
              <div className="guided-sign-off__inline-report-actions">
                {reportMarkdown && typeof navigator !== 'undefined' && navigator.clipboard && (
                  <Button variant="ghost" size="xs" onClick={() => void copyBattleReport()}>
                    {copiedReport ? copy.copiedReport : copy.copyReport}
                  </Button>
                )}
                {reportMarkdown && (
                  <Button variant="ghost" size="xs" onClick={() => setReportExpanded((prev) => !prev)}>
                    {reportExpanded ? copy.battleReportToggleHide : copy.battleReportToggleShow}
                  </Button>
                )}
              </div>
            </div>
            {reportLoading && <p className="guided-sign-off__report-state">{copy.battleReportLoading}</p>}
            {reportError && <p className="guided-sign-off__error" role="alert">{copy.battleReportFailed}</p>}
            {reportExpanded && reportMarkdown && (
              <div className="guided-sign-off__report-body">
                <MarkdownView markdown={reportMarkdown} />
              </div>
            )}
          </div>
        )}
      </div>

      {completed?.action === 'approve' || (completed === null && runStatus === 'COMPLETED') ? (
        <p className="guided-sign-off__done" role="status">{copy.done}</p>
      ) : null}
      {completed?.action === 'revise' ? (
        <p className="guided-sign-off__done" role="status">{copy.revisedDone}</p>
      ) : null}
      {completed?.action === 'rollback' ? (
        <p className="guided-sign-off__done" role="status">{copy.rolledBackDone}</p>
      ) : null}

      {error ? (
        <p className="guided-sign-off__error" role="alert">{error}</p>
      ) : null}

      <div className="guided-sign-off__actions">
        <Button
          variant="default"
          size="sm"
          disabled={!canApproveOrRevise}
          onClick={() => void finalize('approve')}
        >
          {busy ? copy.working : copy.approve}
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
              placeholder={copy.reviseNote}
              disabled={!canApproveOrRevise}
              autoFocus
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!canApproveOrRevise || !note.trim()}
              onClick={() => void finalize('revise')}
            >
              {copy.revise}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={!canApproveOrRevise}
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
            disabled={!canRollback}
            title={!canRollback && !busy && !isTerminal ? copy.rollbackHint : undefined}
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
