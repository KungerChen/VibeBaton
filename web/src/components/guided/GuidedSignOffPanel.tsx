import './GuidedSignOffPanel.css';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import {
  ApiError,
  BatonApiClient,
  type ApprovalSuccessResult,
  type ApproveAndMergeResult,
  type FinalizeAction,
  type FinalizeRequest,
  type FinalizeResult,
  type GateCommandResult,
  type RollbackMode,
  type RollbackResult,
  type RunLineageFields,
} from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { BillingTelemetry } from '../../types/graph';
import { formatReportedUsd, usageCoverage } from '../inspector/billingFormat';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import { MarkdownView } from '../ui/MarkdownView';
import { isStaleRunError, localizeGuidedError } from './guidedErrors';
import { LineageSummary } from './LineageSummary';

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
  /** How many of the run's calls reported usage, stated next to the total. */
  usage?: Pick<BillingTelemetry, 'reported_calls' | 'total_calls'> | null;
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

export type VerificationState = 'passed' | 'failed' | 'not_configured' | 'not_returned';

/** What the checks of a merge step showed. An empty list is "not configured" and never counts as passed. */
export function verificationState(gates: unknown): VerificationState {
  if (!Array.isArray(gates)) return 'not_returned';
  if (gates.length === 0) return 'not_configured';
  return gates.every((gate) => (gate as Partial<GateCommandResult> | null)?.passed === true) ? 'passed' : 'failed';
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

/** The current base SHA must come from an API response, not the historical approval event. */
export interface SignOffLineage {
  status: string;
  lineage: RunLineageFields;
  rootStartSha: string | null;
  currentBaseSha: string | null;
  mergedSha: string | null;
  preMergeSha: string | null;
  /** A backend response may provide these when the base has advanced. */
  guidance?: string;
  revertCommand?: string;
}

export interface SignOffRevisionContext {
  runId: string;
  prior_rfc: string;
  requested_changes: string;
}

/** The host must supersede the run and navigate to Step 2 with this context. */
export type SignOffRevisionHandler = (context: SignOffRevisionContext) => Promise<{ run_id: string; status: 'SUPERSEDED' }>;
export type SignOffLineageLoader = (runId: string) => Promise<SignOffLineage>;
export type SignOffRollback = (runId: string, mode: RollbackMode) => Promise<RollbackResult>;

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return eventPayload(JSON.parse(value)); } catch { return null; }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Read the complete chain; a revision's start SHA is not the root start SHA. */
async function loadLineage(runId: string): Promise<SignOffLineage> {
  const client = new BatonApiClient();
  await client.init();
  return loadSignOffLineage(client, runId);
}

export async function loadSignOffLineage(client: Pick<BatonApiClient, 'getLineageRun'>, runId: string): Promise<SignOffLineage> {
  const snapshot = await client.getLineageRun(runId);
  const run = snapshot.run;
  if (!run || run.id !== runId) throw new Error('Run lineage is unavailable.');
  const lineage: RunLineageFields = {
    parent_run_id: stringField(run.parent_run_id), base_ref: stringField(run.base_ref),
    start_sha: stringField(run.start_sha), result_sha: stringField(run.result_sha),
  };
  let rootStartSha = lineage.start_sha;
  let parentId = lineage.parent_run_id;
  let childStart = lineage.start_sha;
  const seen = new Set([runId]);
  while (parentId) {
    if (seen.has(parentId)) throw new Error('Run lineage contains a cycle.');
    seen.add(parentId);
    const parent = (await client.getLineageRun(parentId)).run;
    if (!parent || parent.id !== parentId || stringField(parent.result_sha) !== childStart
      || stringField(parent.base_ref) !== lineage.base_ref) {
      throw new Error('Run lineage does not match its parent.');
    }
    rootStartSha = stringField(parent.start_sha);
    childStart = rootStartSha;
    parentId = stringField(parent.parent_run_id);
  }
  const approval = [...snapshot.events].reverse().find((event) =>
    event.kind === 'final_gate_approved' || event.kind === 'final_gate_rolled_back');
  const payload = approval?.kind === 'final_gate_approved'
    ? eventPayload(approval.payload) ?? eventPayload(approval.payload_json) : null;
  return {
    status: stringField(run.status) ?? '', lineage, rootStartSha,
    // GET /runs/{id} contains historical events, but does not report the live base head.
    currentBaseSha: null,
    mergedSha: stringField(payload?.merged_commit),
    preMergeSha: stringField(payload?.pre_merge_head),
  };
}

async function rollbackRun(runId: string, mode: RollbackMode): Promise<RollbackResult> {
  const client = new BatonApiClient();
  await client.init();
  return client.rollbackRun(runId, mode);
}

/** Keep the two recoverable approval failures separate from transport/lifecycle errors. */
function approvalFailure(error: unknown): ApproveAndMergeResult | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const data = error.data;
  if (error.code === 'INTEGRATION_CONFLICT' && Array.isArray(data?.conflicts)
    && data.conflicts.every((path) => typeof path === 'string') && typeof data.base_head === 'string') {
    return { kind: 'conflict', error, conflicts: data.conflicts, base_head: data.base_head };
  }
  if (error.code === 'GATE_FAILED' && Array.isArray(data?.gates)) {
    return { kind: 'gate_failed', error, gates: data.gates };
  }
  return null;
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
  /** Optional authoritative snapshot; otherwise the panel reads the run and its ancestors. */
  lineage?: SignOffLineage;
  lineageLoader?: SignOffLineageLoader;
  rollbacker?: SignOffRollback;
  /** The RFC for this run and a host-provided Step 2 transition are both required for revision. */
  priorRfc?: string | null;
  onRequestRevision?: SignOffRevisionHandler;
  stale?: boolean;
  /** Fetches markdown Battle Report inline so users can read it directly inside Guided Mode. */
  reportFetcher?: (runId: string, locale: Locale) => Promise<string>;
  /** Opens the project folder or a changed file / reveals it in Explorer/Finder. */
  onOpenPath?: (options: { path?: string; reveal?: boolean }) => Promise<unknown>;
  /** Optional pre-loaded battle report markdown (primarily for tests or offline views). */
  initialReportMarkdown?: string | null;
  onBusyChange?(busy: boolean): void;
}

/**
 * Guided Mode step 4: show the verification result, changed files and Battle Report, then let the
 * user approve, request revisions or (after an inline confirmation) restore the pre-run snapshot.
 */
export function useGuidedSignOffView({
  runId,
  runStatus,
  summary,
  onFinalized,
  locale,
  finalizer = finalizeRun,
  lineage: suppliedLineage,
  lineageLoader = loadLineage,
  rollbacker = rollbackRun,
  priorRfc,
  onRequestRevision,
  stale = false,
  reportFetcher,
  onOpenPath,
  initialReportMarkdown = null,
  onBusyChange,
}: GuidedSignOffPanelProps) {
  const copy = MESSAGES[locale].guided.signOff;
  const m3 = MESSAGES[locale].guided.m3;
  const digest = summarizeSignOff(summary, locale);
  const [note, setNote] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ mode: RollbackMode; target: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ runId: string; result: FinalizeResult } | null>(null);
  const [outcome, setOutcome] = useState<{ runId: string; result: ApproveAndMergeResult } | null>(null);
  const [loaded, setLoaded] = useState<{ runId: string; value: SignOffLineage } | null>(null);
  const [lineageError, setLineageError] = useState(false);
  const [staleRun, setStaleRun] = useState<{ runId: string; superseded: boolean } | null>(null);
  const [guidance, setGuidance] = useState<{ runId: string; text: string; command: string | null } | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [reportMarkdown, setReportMarkdown] = useState<string | null>(initialReportMarkdown);
  const [reportLoading, setReportLoading] = useState(Boolean(reportFetcher && initialReportMarkdown === null));
  const [reportError, setReportError] = useState(false);
  const [reportExpanded, setReportExpanded] = useState(true);
  const [copiedReport, setCopiedReport] = useState(false);
  const inFlight = useRef<string | null>(null);
  const currentRun = useRef(runId);
  currentRun.current = runId;
  const context = loaded?.runId === runId ? loaded.value : suppliedLineage;
  const completedResult = completed?.runId === runId ? completed.result : null;
  const currentOutcome = outcome?.runId === runId ? outcome.result : null;
  const currentGuidance = guidance?.runId === runId ? guidance : null;
  const effectiveStatus = completedResult?.status ?? runStatus ?? context?.status ?? '';
  const isSuperseded = (staleRun?.runId === runId && staleRun.superseded) || runStatus === 'SUPERSEDED'
    || context?.status === 'SUPERSEDED' || effectiveStatus === 'SUPERSEDED';
  const isStale = stale || staleRun?.runId === runId || isSuperseded;
  const staleNow = useRef(isStale);
  staleNow.current = isStale;
  const isApproved = effectiveStatus === 'COMPLETED';
  const canApprove = !busy && !isStale && effectiveStatus === 'READY_FOR_FINAL_GATE'
    && context?.status === 'READY_FOR_FINAL_GATE';
  const canRevise = canApprove && Boolean(priorRfc?.trim() && onRequestRevision);
  const canRollback = !busy && !isStale && Boolean(context?.lineage.result_sha)
    && (effectiveStatus === 'READY_FOR_FINAL_GATE' || effectiveStatus === 'PAUSED')
    && (context?.status === 'READY_FOR_FINAL_GATE' || context?.status === 'PAUSED');
  const canUndo = !busy && !isStale && isApproved && !currentGuidance && !context?.guidance
    && Boolean(context?.mergedSha && context.preMergeSha
      && (!context.currentBaseSha || context.mergedSha.toLowerCase() === context.currentBaseSha.toLowerCase()));
  const confirmationTarget = confirmation?.mode === 'undo' ? context?.preMergeSha
    : confirmation?.mode === 'revert_revision' ? context?.lineage.start_sha : context?.rootStartSha;
  const canConfirm = Boolean(confirmation && confirmation.target === confirmationTarget
    && (confirmation.mode === 'undo' ? canUndo : canRollback)
    && (confirmation.mode !== 'revert_revision' || context?.lineage.parent_run_id));
  const reportHref = digest.reportUrl.trim() || `/api/runs/${encodeURIComponent(runId)}/report`;
  const costDisplay = formatReportedUsd(summary.totalCostUsd, locale);
  const costCoverage = usageCoverage(summary.usage, locale);
  const deliverables = summary.deliverables ?? [];

  useEffect(() => {
    setConfirmation(null);
    setReviseOpen(false);
    setNote('');
    setError(null);
    setBusy(false);
  }, [runId]);

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setLineageError(false);
    if (!suppliedLineage) {
      lineageLoader(runId).then((value) => {
        if (active) setLoaded({ runId, value });
      }).catch(() => {
        if (active) setLineageError(true);
      });
    }
    return () => { active = false; };
  }, [runId, suppliedLineage, lineageLoader]);

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

  function showFailure(failure: unknown) {
    if (isStaleRunError(failure)) {
      setStaleRun({ runId, superseded: failure instanceof ApiError && failure.code === 'RUN_SUPERSEDED' });
      setConfirmation(null);
      setReviseOpen(false);
    }
    if (failure instanceof ApiError && failure.code && failure.code in m3.errors) {
      setError(m3.errors[failure.code as keyof typeof m3.errors]);
    } else {
      setError(localizeGuidedError(failure, locale));
    }
  }

  async function approve() {
    if (inFlight.current === runId || !canApprove) return;
    const operationRunId = runId;
    inFlight.current = operationRunId;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await finalizer(operationRunId, buildFinalizePayload('approve', ''));
      if (currentRun.current !== operationRunId) return;
      if (result.run_id !== operationRunId || result.action !== 'approve' || result.status !== 'COMPLETED'
        || !result.merged_commit) {
        setStaleRun({ runId, superseded: false });
        throw new Error('Invalid approval response. Refresh the run before retrying.');
      }
      const success: ApprovalSuccessResult = { ...result, action: 'approve', status: 'COMPLETED',
        merged_commit: result.merged_commit, changed_files: result.changed_files ?? [] };
      setOutcome({ runId, result: result.reintegrated
        ? { kind: 'reintegrated', result: { ...success, reintegrated: true, gates: result.gates ?? [] } }
        : { kind: 'merged', result: { ...success, reintegrated: false } } });
      setCompleted({ runId, result });
      setConfirmation(null);
      setReviseOpen(false);
      onFinalized(result);
      // The approval response reports the head at the time of merge. The event supplies
      // the exact pre-merge target; neither the root nor the revision start is a substitute.
      try {
        const fresh = await lineageLoader(operationRunId);
        if (currentRun.current === operationRunId && fresh.status === 'COMPLETED'
          && fresh.mergedSha === result.merged_commit) {
          setLoaded({ runId, value: { ...fresh, currentBaseSha: result.base_head } });
        }
      } catch { /* A missing target keeps undo disabled until authoritative data is available. */ }
    } catch (failure) {
      if (currentRun.current !== operationRunId) return;
      const failed = approvalFailure(failure);
      if (failed) setOutcome({ runId, result: failed });
      else showFailure(failure);
    } finally {
      if (inFlight.current === operationRunId) inFlight.current = null;
      onBusyChange?.(false);
      if (currentRun.current === operationRunId) setBusy(false);
    }
  }

  async function requestRevision() {
    if (inFlight.current === runId || !canRevise || !note.trim() || !priorRfc || !onRequestRevision) return;
    const operationRunId = runId;
    inFlight.current = operationRunId;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    try {
      const result = await onRequestRevision({ runId, prior_rfc: priorRfc, requested_changes: note.trim() });
      if (currentRun.current !== operationRunId) return;
      if (result.run_id !== operationRunId || result.status !== 'SUPERSEDED') {
        setStaleRun({ runId, superseded: false });
        throw new Error('The revision response did not confirm this run. Refresh its status.');
      }
      setStaleRun({ runId, superseded: true });
      setReviseOpen(false);
    } catch (failure) {
      if (currentRun.current === operationRunId) showFailure(failure);
    } finally {
      if (inFlight.current === operationRunId) inFlight.current = null;
      onBusyChange?.(false);
      if (currentRun.current === operationRunId) setBusy(false);
    }
  }

  async function rollback() {
    if (!confirmation || inFlight.current === runId) return;
    const { mode, target } = confirmation;
    const currentTarget = mode === 'undo' ? context?.preMergeSha
      : mode === 'revert_revision' ? context?.lineage.start_sha : context?.rootStartSha;
    if (target !== currentTarget || (mode === 'undo' ? !canUndo : !canRollback)
      || (mode === 'revert_revision' && !context?.lineage.parent_run_id)) return;
    const operationRunId = runId;
    inFlight.current = operationRunId;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    try {
      if (mode !== 'undo') {
        const fresh = await lineageLoader(operationRunId);
        if (currentRun.current !== operationRunId || staleNow.current) return;
        const freshTarget = mode === 'revert_revision' ? fresh.lineage.start_sha : fresh.rootStartSha;
        if ((fresh.status !== 'READY_FOR_FINAL_GATE' && fresh.status !== 'PAUSED')
          || fresh.lineage.result_sha !== context?.lineage.result_sha || freshTarget !== target
          || (mode === 'revert_revision' && fresh.lineage.parent_run_id !== context?.lineage.parent_run_id)) {
          setStaleRun({ runId, superseded: fresh.status === 'SUPERSEDED' });
          throw new Error('The run changed after confirmation. Refresh before rolling back.');
        }
      }
      // Legacy runs use the guarded finalize rollback; explicit modes require lineage.
      const legacy = mode === 'undo' && !context?.lineage.start_sha
        ? await finalizer(operationRunId, buildFinalizePayload('rollback', '')) : null;
      const result = legacy ? { ...legacy, mode } : await rollbacker(operationRunId, mode);
      if (currentRun.current !== operationRunId) return;
      if (result.run_id !== operationRunId || result.mode !== mode || result.status !== 'PAUSED'
        || (legacy && legacy.action !== 'rollback') || result.restored_to !== target) {
        setStaleRun({ runId, superseded: false });
        throw new Error('Rollback response did not match the confirmed target. Refresh the run.');
      }
      const finalized: FinalizeResult = legacy ?? { ...result, action: 'rollback', backup_tag: null };
      setCompleted({ runId, result: finalized });
      if (context) setLoaded({ runId, value: { ...context, status: result.status,
        lineage: { ...context.lineage, result_sha: mode === 'undo' ? context.lineage.result_sha : result.restored_to },
        currentBaseSha: result.base_head,
        mergedSha: mode === 'undo' ? null : context.mergedSha,
        preMergeSha: mode === 'undo' ? null : context.preMergeSha } });
      setOutcome(null);
      setConfirmation(null);
      onFinalized(finalized);
    } catch (failure) {
      if (currentRun.current !== operationRunId) return;
      if (failure instanceof ApiError && failure.status === 409 && failure.code === 'MERGE_NOT_HEAD') {
        const text = stringField(failure.data?.guidance) ?? localizeGuidedError(failure, locale);
        // Copy only the command actually returned by the server. Its placeholder is intentional.
        const command = text.match(/git revert -m 1 <merge-commit>/)?.[0] ?? null;
        setGuidance({ runId, text, command });
        setConfirmation(null);
      } else showFailure(failure);
    } finally {
      if (inFlight.current === operationRunId) inFlight.current = null;
      onBusyChange?.(false);
      if (currentRun.current === operationRunId) setBusy(false);
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

      <LineageSummary
        runId={runId}
        status={isSuperseded ? 'SUPERSEDED' : effectiveStatus || 'UNKNOWN'}
        lineage={context?.lineage ?? { parent_run_id: null, base_ref: null, start_sha: null, result_sha: null }}
        rootStartSha={context?.rootStartSha ?? null}
        currentBaseSha={context?.currentBaseSha ?? null}
        mergedSha={context?.mergedSha ?? null}
      />
      {lineageError ? (
        <p className="guided-sign-off__error" role="alert">
          {locale === 'zh' ? '无法读取运行历史；回退操作不可用。' : 'Could not load run lineage; rollback is unavailable.'}
        </p>
      ) : null}

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
            {costCoverage ? <span className="guided-sign-off__kpi-note">{costCoverage}</span> : null}
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

      {currentOutcome ? (
        <>
          {/* The merge result says only what happened to the branch; checks are the separate verification result. */}
          <div className={currentOutcome.kind === 'conflict' || currentOutcome.kind === 'gate_failed'
            ? 'guided-sign-off__error' : 'guided-sign-off__done'}
          role={currentOutcome.kind === 'conflict' || currentOutcome.kind === 'gate_failed' ? 'alert' : 'status'}
          data-outcome={currentOutcome.kind}>
            {currentOutcome.kind === 'merged' || currentOutcome.kind === 'reintegrated' ? (
              <>
                <strong>{currentOutcome.kind === 'merged' ? m3.signOff.merged : m3.signOff.reintegrated}</strong>
                <p>{m3.signOff.mergedSha}: <code>{currentOutcome.result.merged_commit}</code></p>
                {currentOutcome.kind === 'reintegrated' ? (
                  <p>{locale === 'zh' ? '基准分支在运行期间发生变化；本次结果已与新基准整合。'
                    : 'The base branch advanced during this run; the result was integrated with the updated base.'}</p>
                ) : null}
              </>
            ) : currentOutcome.kind === 'conflict' ? (
              <>
                <strong>{m3.signOff.conflict}</strong>
                <p>{locale === 'zh' ? '没有合并任何改动。' : 'Nothing was merged.'} {m3.drift.conflict}</p>
                <p>{m3.signOff.currentBaseSha}: <code>{currentOutcome.base_head}</code></p>
                <ul>{currentOutcome.conflicts.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
              </>
            ) : (
              <>
                <strong>{m3.signOff.gateFailed}</strong>
                <p>{m3.drift.gateFailed}</p>
              </>
            )}
          </div>
          {currentOutcome.kind === 'reintegrated' ? <VerificationResult gates={completedResult?.gates} locale={locale} />
            : currentOutcome.kind === 'gate_failed' ? <VerificationResult gates={currentOutcome.gates} locale={locale} /> : null}
        </>
      ) : isApproved ? <p className="guided-sign-off__done" role="status">{m3.signOff.merged}</p> : null}
      {completedResult?.action === 'rollback' ? (
        <p className="guided-sign-off__done" role="status">{m3.rollback.restored}: <code>{completedResult.restored_to}</code></p>
      ) : null}
      {isStale ? (
        <p className="guided-sign-off__error" role="status">{isSuperseded ? m3.errors.RUN_SUPERSEDED : m3.errors.RUN_STALE}</p>
      ) : null}

      {error ? (
        <p className="guided-sign-off__error" role="alert">{error}</p>
      ) : null}

      <div className="guided-sign-off__actions">
        <Button
          variant="default"
          size="sm"
          disabled={!canApprove}
          onClick={() => void approve()}
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
              disabled={!canRevise}
              autoFocus
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!canRevise || !note.trim()}
              onClick={() => void requestRevision()}
            >
              {copy.revise}
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={!canRevise}
            onClick={() => {
              setError(null);
              setConfirmation(null);
              setReviseOpen(true);
            }}
          >
            {copy.revise}
          </Button>
        )}

      </div>
      {!isApproved && !isStale && (!onRequestRevision || !priorRfc?.trim()) ? (
        <p className="guided-sign-off__report-state">
          {locale === 'zh' ? '需要原蓝图和第 2 步修订入口才能提出修改。' : 'The original blueprint and a Step 2 revision transition are required to request changes.'}
        </p>
      ) : null}

      {!isApproved ? (
        <div className="guided-sign-off__rollback" aria-label={m3.rollback.title}>
          {context?.lineage.parent_run_id ? (
            <Button variant="destructive" size="sm" disabled={!canRollback || !context.lineage.start_sha}
              title={m3.rollback.revertRevisionHint}
              onClick={() => { setReviseOpen(false); setError(null);
                setConfirmation({ mode: 'revert_revision', target: context.lineage.start_sha! }); }}>
              {m3.rollback.revertRevision}
            </Button>
          ) : null}
          <Button variant="destructive" size="sm" disabled={!canRollback || !context?.rootStartSha}
            title={m3.rollback.abandonAllHint}
            onClick={() => { if (!context?.rootStartSha) return; setReviseOpen(false); setError(null);
              setConfirmation({ mode: 'abandon_all', target: context.rootStartSha }); }}>
            {m3.rollback.abandonAll}
          </Button>
        </div>
      ) : canUndo ? (
        <div className="guided-sign-off__rollback">
          {!context?.currentBaseSha ? <p>{m3.rollback.serverChecksHead}</p> : null}
          <Button variant="destructive" size="sm" title={m3.rollback.undoHint}
            onClick={() => { if (!context?.preMergeSha) return; setError(null);
              setConfirmation({ mode: 'undo', target: context.preMergeSha }); }}>
            {m3.rollback.undo}
          </Button>
        </div>
      ) : null}

      {isApproved && !isStale && !busy && !canUndo && !currentGuidance && !context?.guidance ? (
        <p className="guided-sign-off__report-state">
          {context?.mergedSha && context.currentBaseSha && context.mergedSha.toLowerCase() !== context.currentBaseSha.toLowerCase()
            ? (locale === 'zh' ? '基准分支已有新提交，尚未取得后端的撤销建议。' : 'The base has advanced; backend revert guidance is not available.')
            : (locale === 'zh' ? '尚未取得当前分支头的确认；无法提供撤销合并。' : 'The current base head has not been verified; undo is unavailable.')}
        </p>
      ) : null}
      {currentGuidance || context?.guidance ? (
        <div className="guided-sign-off__confirm" role="alert">
          <strong>{m3.rollback.moved}</strong>
          <p>{currentGuidance?.text ?? context?.guidance}</p>
          {(currentGuidance?.command ?? context?.revertCommand) ? (
            <div className="guided-sign-off__command">
              <code>{currentGuidance?.command ?? context?.revertCommand}</code>
              <Button variant="secondary" size="xs" onClick={() => {
                const command = currentGuidance?.command ?? context?.revertCommand;
                if (!command || typeof navigator === 'undefined' || !navigator.clipboard) return;
                void navigator.clipboard.writeText(command).then(() => setCopiedCommand(true)).catch(() => {});
              }}>{copiedCommand ? (locale === 'zh' ? '已复制' : 'Copied')
                : (currentGuidance?.command ?? context?.revertCommand)?.includes('<')
                  ? (locale === 'zh' ? '复制命令模板' : 'Copy command template')
                  : (locale === 'zh' ? '复制命令' : 'Copy command')}</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmation && !isStale ? (
        <div className="guided-sign-off__confirm" role="group" aria-label={m3.rollback.confirm}>
          <p>{m3.rollback.confirm}: <code>{confirmation.target}</code></p>
          <Button variant="destructive" size="sm" disabled={!canConfirm} onClick={() => void rollback()}>
            {busy ? m3.rollback.working : m3.rollback.confirm}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmation(null)}>
            {m3.rollback.cancel}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The verification result in one of its four states; only "passed" is shown in green. */
function VerificationResult({ gates, locale }: { gates: unknown; locale: Locale }) {
  const copy = MESSAGES[locale].guided.m3.signOff;
  const state = verificationState(gates);
  const label = {
    passed: copy.verificationPassed, failed: copy.verificationFailed,
    not_configured: copy.noGates, not_returned: copy.verificationNotReturned,
  }[state];
  const listed = Array.isArray(gates) ? gates as GateCommandResult[] : [];
  return (
    <section className="guided-sign-off__verification" data-verification={state} aria-label={copy.verification}>
      <strong>{copy.verification}{locale === 'zh' ? '：' : ': '}{label}</strong>
      {state === 'not_returned' ? <p>{copy.verificationNotReturnedHint}</p> : null}
      {listed.length ? <ul>{listed.map((gate, index) => (
        <li key={`${gate.command}-${index}`}>
          <code>{gate.command}</code> — {gate.passed ? 'PASS' : 'FAIL'} ({gate.exit_code})
          {(gate.stderr || gate.stdout) ? <pre>{gate.stderr || gate.stdout}</pre> : null}
        </li>
      ))}</ul> : null}
    </section>
  );
}

export function GuidedSignOffPanel(props: GuidedSignOffPanelProps) {
  return useGuidedSignOffView(props);
}
