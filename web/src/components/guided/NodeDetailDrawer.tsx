import './NodeDetailDrawer.css';
import { useEffect, useEffectEvent, useId, useState } from 'react';
import { BatonApiClient, type RunTaskDetail } from '../../api/client';
import { formatDurationSec } from '../../engine/liveClock';
import type { Locale } from '../../i18n/messages';
import { MESSAGES } from '../../i18n/messages';
import { formatProviderDisplay } from '../../i18n/presets';
import { GlossaryTerm, useGlossaryHighlights } from './GlossaryTerm';
import { localizeGuidedError } from './guidedErrors';

export type NodeDetailFetcher = (runId: string, taskId: string) => Promise<RunTaskDetail>;

export interface NodeDetailDrawerProps {
  runId: string;
  taskId: string | null;
  onClose(): void;
  locale: Locale;
  /** Injected in tests and by the Guided workbench; the default probes the local API first. */
  fetcher?: NodeDetailFetcher;
  /** Whether an event of this task carried a cost (see `taskCostReported`); only then is a zero shown as $0.00. */
  costReported?: boolean;
}

export interface DetailSummary {
  status: string;
  summary: string;
  model: string;
  elapsed: string;
  cost: string;
  tests: string;
  changedFiles: string[];
  verdict: string;
}

/**
 * Elapsed task runtime. `billingFormat` only formats USD and token counts, and `playbackLabels`
 * only builds replay labels, so this reuses the snapshot clock formatter used by run durations.
 */
export function formatElapsed(sec: number, locale: Locale): string {
  return formatDurationSec(sec, locale);
}

function displayToken(value: string): string {
  return value.replace(/_/g, ' ');
}

// Billed task costs are dollar amounts, so the drawer always shows two decimal places.
// billingFormat.formatUsd keeps four decimals below $1 because it also formats per-token rates.
function formatBilledUsd(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Whether any event of this task carried a numeric `cost_usd`. The task detail adds up exactly those,
 * and sends 0 when there are none, so this tells a real $0.00 from a cost nobody reported.
 */
export function taskCostReported(events: readonly Record<string, unknown>[], taskId: string): boolean {
  return events.some((event) => {
    if (event.task_id !== taskId) return false;
    let payload = event.payload ?? event.payload_json;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return false; }
    }
    const cost = (payload as { cost_usd?: unknown } | null | undefined)?.cost_usd;
    return typeof cost === 'number' && Number.isFinite(cost);
  });
}

/** Format every value the drawer renders, keeping the raw task payload out of the JSX. */
export function summarizeDetail(detail: RunTaskDetail, locale: Locale, costReported?: boolean): DetailSummary {
  const copy = MESSAGES[locale].guided.nodeDetail;
  const provider = detail.provider ? formatProviderDisplay(detail.provider) : '';
  return {
    status: copy.statuses[detail.status] ?? displayToken(detail.status),
    summary: detail.summary,
    model: [provider, detail.model].filter(Boolean).join(' / ') || '—',
    elapsed: formatElapsed(detail.elapsed_sec, locale),
    // A zero is only real when an event confirms a reported cost; any amount above zero was reported.
    cost: detail.cost_usd === 0 && costReported !== true
      ? MESSAGES[locale].inspector.billingNotReported : formatBilledUsd(detail.cost_usd, locale),
    tests: copy.testStatuses[detail.test_status] ?? displayToken(detail.test_status),
    changedFiles: [...detail.changed_files],
    verdict: detail.review_verdict ? (copy.verdicts[detail.review_verdict] ?? displayToken(detail.review_verdict)) : '—',
  };
}

const fallbackClient = new BatonApiClient();

async function defaultFetcher(runId: string, taskId: string, locale?: Locale): Promise<RunTaskDetail> {
  // A standalone drawer has no access to App's initialized client, so leave demo mode first.
  if (fallbackClient.mode === 'demo') await fallbackClient.init();
  return fallbackClient.getRunTaskDetail(runId, taskId, locale);
}

type LoadState =
  | { key: string; phase: 'ready'; detail: RunTaskDetail }
  | { key: string; phase: 'error'; message: string };

function taskKey(runId: string, taskId: string, locale: Locale): string {
  return `${runId}\u0000${taskId}\u0000${locale}`;
}

/**
 * Read-only inspector for one run task. It loads `RunTaskDetail` on open and presents the
 * summary, status, model, runtime, cost, tests, changed files and review verdict in plain words.
 */
export function NodeDetailDrawer({
  runId,
  taskId,
  onClose,
  locale,
  fetcher,
  costReported,
}: NodeDetailDrawerProps) {
  const copy = MESSAGES[locale].guided.nodeDetail;
  const headingId = useId();
  const [state, setState] = useState<LoadState | null>(null);

  const loadDetail = useEffectEvent((id: string) => (
    fetcher ? fetcher(runId, id) : defaultFetcher(runId, id, locale)
  ));

  useEffect(() => {
    if (!taskId) return;
    const key = taskKey(runId, taskId, locale);
    let active = true;
    void loadDetail(taskId).then(
      (detail) => {
        if (active) setState({ key, phase: 'ready', detail });
      },
      (error: unknown) => {
        if (active) {
          setState({ key, phase: 'error', message: localizeGuidedError(error, locale) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [runId, taskId, locale]);

  useEffect(() => {
    if (!taskId || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [taskId, onClose]);

  const key = taskId ? taskKey(runId, taskId, locale) : null;
  const current = key !== null && state?.key === key ? state : null;
  const detail = current !== null && current.phase === 'ready' ? current.detail : null;
  const errorMessage = current !== null && current.phase === 'error' ? current.message : null;
  const hasError = current !== null && current.phase === 'error';
  const summary = detail ? summarizeDetail(detail, locale, costReported) : null;
  const segments = useGlossaryHighlights(summary?.summary ?? '', locale);

  if (!taskId) return null;

  return (
    <div className="node-detail-drawer__root">
      <div className="node-detail-drawer__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="node-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header className="node-detail-drawer__header">
          <div className="node-detail-drawer__heading">
            <p className="node-detail-drawer__eyebrow">{copy.title}</p>
            <h2 id={headingId} className="node-detail-drawer__title">
              {detail?.title ?? taskId}
            </h2>
            <code className="node-detail-drawer__task-id">{detail?.task_id ?? taskId}</code>
            {detail && summary && (
              <span className="node-detail-drawer__status-pill" data-status={detail.status} data-field="status">
                {summary.status}
              </span>
            )}
          </div>
          <button type="button" className="node-detail-drawer__close" onClick={onClose}>
            {copy.close}
          </button>
        </header>

        {hasError ? (
          <div className="node-detail-drawer__error" role="alert">
            <p className="node-detail-drawer__error-label">{copy.summary}</p>
            <p>{errorMessage}</p>
          </div>
        ) : detail && summary ? (
          <>
            <section className="node-detail-drawer__section">
              <h3>{copy.summary}</h3>
              <p className="node-detail-drawer__summary">
                {segments.map((segment, index) => (
                  segment.termId ? (
                    <GlossaryTerm key={`${segment.termId}-${index}`} termId={segment.termId}>
                      {segment.text}
                    </GlossaryTerm>
                  ) : segment.text
                ))}
              </p>
            </section>

            <dl className="node-detail-drawer__facts">
              <div className="node-detail-drawer__fact">
                <dt>{copy.model}</dt>
                <dd data-field="model"><code>{summary.model}</code></dd>
              </div>
              <div className="node-detail-drawer__fact">
                <dt>{copy.elapsed}</dt>
                <dd data-field="elapsed">{summary.elapsed}</dd>
              </div>
              <div className="node-detail-drawer__fact">
                <dt>{copy.cost}</dt>
                <dd data-field="cost">{summary.cost}</dd>
              </div>
              <div className="node-detail-drawer__fact">
                <dt>{copy.tests}</dt>
                <dd data-field="tests" data-test-status={detail.test_status}>{summary.tests}</dd>
              </div>
              <div className="node-detail-drawer__fact">
                <dt>{copy.verdict}</dt>
                <dd data-field="verdict">{summary.verdict}</dd>
              </div>
            </dl>

            <section className="node-detail-drawer__section">
              <h3>{copy.changedFiles}</h3>
              {summary.changedFiles.length > 0 ? (
                <ul className="node-detail-drawer__files" data-field="changed-files">
                  {summary.changedFiles.map((file, index) => (
                    <li key={`${file}-${index}`}><code>{file}</code></li>
                  ))}
                </ul>
              ) : (
                <p className="node-detail-drawer__empty" aria-hidden="true">—</p>
              )}
            </section>
          </>
        ) : (
          <div className="node-detail-drawer__loading" role="status" aria-busy="true" aria-label={copy.title}>
            <span className="node-detail-drawer__spinner" aria-hidden="true" />
          </div>
        )}
      </aside>
    </div>
  );
}
