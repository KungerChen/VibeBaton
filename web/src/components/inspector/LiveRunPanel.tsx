import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { formatDurationSec } from '../../engine/liveRunGraph';
import { useI18n } from '../../i18n';
import { formatLiveEventMessage, translateEventKind, translateTier } from '../../i18n/liveEvents';
import type { Locale } from '../../i18n/messages';
import { formatProviderDisplay, translateRole } from '../../i18n/presets';
import type { LiveRunSnapshot, RunListItem } from '../../types/graph';
import type { RightInspectorProps } from '../types';
import { Badge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Label, Select } from '../ui/input';
import { MarkdownView } from '../ui/MarkdownView';
import { Modal } from '../ui/Modal';
import { StartRunModal } from './StartRunModal';

const eventLimit = 200;
const emptySnapshot: LiveRunSnapshot = { run: null, milestones: [], tasks: [], events: [], quotas: [], telemetry: null };
const statusBadgeVariant = new Map<string, BadgeProps['variant']>([
  ['RUNNING', 'info'],
  ['PLANNING', 'info'],
  ['IN_PROGRESS', 'info'],
  ['REVIEWING', 'info'],
  ['READY_FOR_FINAL_GATE', 'warning'],
  ['PAUSED', 'secondary'],
  ['WAITING_HUMAN', 'warning'],
  ['COMPLETED', 'success'],
  ['PASSED', 'success'],
  ['FAILED', 'destructive'],
  ['HALTED', 'destructive'],
  ['REJECTED', 'destructive'],
  ['ESCALATED', 'warning'],
]);

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRow);
}

export function isLiveSnapshot(value: unknown): value is LiveRunSnapshot {
  return isRow(value) && (value.run === null || isRow(value.run))
    && isRows(value.milestones) && isRows(value.tasks) && isRows(value.events) && isRows(value.quotas);
}

function withRecentEvents(snapshot: LiveRunSnapshot): LiveRunSnapshot {
  return { ...snapshot, events: snapshot.events.slice(-eventLimit) };
}

function display(value: unknown, fallback = '—'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function formatDisplayTarget(target: string): string {
  const clean = target.trim();
  if (!clean) return '—';
  const slash = clean.indexOf('/');
  if (slash > 0) {
    return `${formatProviderDisplay(clean.slice(0, slash))}/${clean.slice(slash + 1)}`;
  }
  const colon = clean.indexOf(':');
  if (colon > 0) {
    return `${formatProviderDisplay(clean.slice(0, colon))}/${clean.slice(colon + 1)}`;
  }
  return formatProviderDisplay(clean);
}

function parseAllowedFiles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
        }
      } catch {
        // Fall through to plain splitting.
      }
    }
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

type LiveRunPanelProps = Pick<
  RightInspectorProps,
  | 'client'
  | 'onToast'
  | 'liveSnapshot'
  | 'recentRuns'
  | 'selectedRunId'
  | 'liveReconnecting'
  | 'onSelectRunId'
  | 'onRefreshLiveRun'
> & { visible: boolean };

type RunAction = 'pause' | 'resume' | 'approve' | 'reject';

export function LiveRunPanel({
  client,
  onToast,
  visible,
  liveSnapshot,
  recentRuns,
  selectedRunId,
  liveReconnecting,
  onSelectRunId,
  onRefreshLiveRun,
}: LiveRunPanelProps) {
  const { locale, messages } = useI18n();
  const panelId = useId();
  const hasLiftedState = onSelectRunId !== undefined;
  const [localSnapshot, setLocalSnapshot] = useState<LiveRunSnapshot>(emptySnapshot);
  const [localReconnecting, setLocalReconnecting] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [report, setReport] = useState<{ runId: string; lang: Locale; markdown: string } | null>(null);
  const [reportRawMode, setReportRawMode] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [note, setNote] = useState<{ runId: string; text: string } | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const eventLog = useRef<HTMLDivElement>(null);
  const snapshotRevision = useRef(0);

  const snapshot = hasLiftedState ? (liveSnapshot ?? emptySnapshot) : localSnapshot;
  const reconnecting = hasLiftedState ? Boolean(liveReconnecting) : localReconnecting;
  const runsList: RunListItem[] = recentRuns ?? [];
  const runId = typeof snapshot.run?.id === 'string' ? snapshot.run.id : undefined;
  const status = display(snapshot.run?.status, 'UNKNOWN');
  const telemetry = snapshot.telemetry ?? null;
  const onStreamError = useEffectEvent((error: unknown) => {
    onToast(error instanceof Error ? error.message : String(error), 'err');
  });

  useEffect(() => {
    if (hasLiftedState) return;
    setLocalSnapshot(emptySnapshot);
    setLocalReconnecting(false);

    let source: EventSource;
    try {
      source = new EventSource(client.streamUrl());
    } catch (error) {
      onStreamError(error);
      return;
    }

    function receiveSnapshot({ data }: MessageEvent<string>) {
      try {
        const next: unknown = JSON.parse(data);
        if (!isLiveSnapshot(next)) throw new Error('Invalid live run snapshot.');
        snapshotRevision.current += 1;
        setLocalSnapshot(withRecentEvents(next));
        setLocalReconnecting(false);
      } catch (error) {
        onStreamError(error);
      }
    }

    function receiveEvent({ data }: MessageEvent<string>) {
      try {
        const event: unknown = JSON.parse(data);
        if (!isRow(event)) throw new Error('Invalid live run event.');
        snapshotRevision.current += 1;
        setLocalSnapshot((current) => {
          if (current.run && typeof event.run_id === 'string' && event.run_id !== current.run.id) return current;
          const lastId = current.events.at(-1)?.id;
          if (typeof event.id === 'number' && typeof lastId === 'number' && event.id <= lastId) return current;
          return withRecentEvents({ ...current, events: [...current.events, event] });
        });
        setLocalReconnecting(false);
      } catch (error) {
        onStreamError(error);
      }
    }

    source.addEventListener('snapshot', receiveSnapshot);
    source.addEventListener('event', receiveEvent);
    source.onopen = () => setLocalReconnecting(false);
    source.onerror = () => setLocalReconnecting(true);
    return () => {
      snapshotRevision.current += 1;
      source.removeEventListener('snapshot', receiveSnapshot);
      source.removeEventListener('event', receiveEvent);
      source.onopen = null;
      source.onerror = null;
      source.close();
    };
  }, [client, hasLiftedState]);

  useEffect(() => {
    setExpandedTaskId(null);
  }, [runId]);

  useEffect(() => {
    if (visible && eventLog.current) eventLog.current.scrollTop = eventLog.current.scrollHeight;
  }, [visible, snapshot.events]);

  useEffect(() => {
    if (!visible || !report || report.lang === locale) return;
    let active = true;
    const targetRunId = report.runId;
    setLoadingReport(true);
    void client.getRunReport(targetRunId, locale).then(
      (markdown) => {
        if (active) setReport({ runId: targetRunId, lang: locale, markdown });
      },
      (error) => {
        if (active) onToast(error instanceof Error ? error.message : String(error), 'err');
      },
    ).finally(() => {
      if (active) setLoadingReport(false);
    });
    return () => { active = false; };
  }, [client, locale, onToast, report, visible]);

  async function refreshActiveRun() {
    if (onRefreshLiveRun) {
      await onRefreshLiveRun();
      return;
    }
    const revision = ++snapshotRevision.current;
    try {
      const latest = await client.getLatestRun();
      if (revision === snapshotRevision.current) setLocalSnapshot(withRecentEvents(latest));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  async function showReport() {
    if (!runId || loadingReport) return;
    setLoadingReport(true);
    try {
      const markdown = await client.getRunReport(runId, locale);
      setReportRawMode(false);
      setReport({ runId, lang: locale, markdown });
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setLoadingReport(false);
    }
  }

  async function copyReportMarkdown() {
    if (!report) return;
    try {
      await navigator.clipboard?.writeText(report.markdown);
      onToast(messages.toasts.reportCopied, 'ok');
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  async function changeRun(action: RunAction) {
    if (!runId || controlling) return;
    setControlling(true);
    try {
      if (action === 'pause' || action === 'resume') {
        await client.controlRun(runId, action);
      } else {
        await client.resolveRun(runId, action, note?.runId === runId ? note.text : '');
        setNote(null);
      }
      await refreshActiveRun();
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      setControlling(false);
    }
  }

  return (
    <section
      className="right-inspector__section border-t border-border pt-4"
      aria-label={messages.inspector.liveSectionAria}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground m-0">
          {messages.inspector.liveTitle}
        </h2>
        {reconnecting && (
          <Badge variant="warning" role="status">
            {messages.inspector.reconnecting}
          </Badge>
        )}
      </div>

      {runsList.length > 0 && onSelectRunId && (
        <div className="right-inspector__field">
          <Label htmlFor={`${panelId}-history`} className="text-[11px] font-semibold text-muted-foreground">
            {messages.inspector.runHistoryLabel}
          </Label>
          <Select
            id={`${panelId}-history`}
            value={selectedRunId ?? runId ?? ''}
            onChange={(event) => onSelectRunId(event.currentTarget.value)}
            className="text-xs font-mono"
          >
            {runsList.map((item) => {
              const itemStatus = messages.inspector.runStatuses[item.status] ?? item.status;
              return (
                <option key={item.id} value={item.id}>
                  {messages.inspector.runHistoryOption(
                    item.id,
                    itemStatus,
                    item.passed_tasks,
                    item.total_tasks,
                    formatDurationSec(item.elapsed_sec, locale),
                  )}
                </option>
              );
            })}
          </Select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" onClick={() => setStartOpen(true)}>
          {messages.inspector.startRealRun}
        </Button>
        {runId && (
          <Button variant="outline" size="sm" onClick={() => void showReport()} disabled={loadingReport}>
            {messages.inspector.battleReport}
          </Button>
        )}
      </div>

      {runId ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant.get(status) ?? 'outline'} role="status">
              {messages.inspector.runStatuses[status] ?? status}
            </Badge>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground break-all">
              {runId}
            </code>
          </div>

          {(status === 'RUNNING' || status === 'PAUSED') && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={controlling}
                onClick={() => void changeRun(status === 'RUNNING' ? 'pause' : 'resume')}
              >
                {status === 'RUNNING' ? messages.inspector.pauseRun : messages.inspector.resumeRun}
              </Button>
            </div>
          )}

          {status === 'WAITING_HUMAN' && (
            <>
              <label className="right-inspector__field">
                <Label className="pointer-events-none">{messages.inspector.decisionNote}</Label>
                <Input
                  value={note?.runId === runId ? note.text : ''}
                  disabled={controlling}
                  onChange={(event) => setNote({ runId, text: event.currentTarget.value })}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="default" size="sm" disabled={controlling} onClick={() => void changeRun('approve')}>
                  {messages.inspector.approve}
                </Button>
                <Button variant="destructive" size="sm" disabled={controlling} onClick={() => void changeRun('reject')}>
                  {messages.inspector.reject}
                </Button>
              </div>
            </>
          )}

          {telemetry && telemetry.stages.length > 0 && (
            <div className="right-inspector__telemetry-card">
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  {messages.inspector.stageTimingTitle}
                </h3>
                <span className="font-mono text-[11px] text-foreground">
                  {messages.inspector.totalElapsed(formatDurationSec(telemetry.elapsed_sec, locale))}
                </span>
              </div>
              <div className="grid gap-1.5">
                {telemetry.stages.map((stage) => {
                  const stageLabel = stage.kind === 'planning'
                    ? (locale === 'en' ? '01_PLAN' : '01_PLAN · 规划')
                    : `${stage.id} · ${stage.title}`;
                  const stageStatus = messages.inspector.runStatuses[stage.status] ?? stage.status;
                  return (
                    <div
                      key={stage.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-text-strong" title={stageLabel}>
                          {stageLabel}
                        </div>
                        <div className="text-[10.5px] text-muted-foreground">
                          {stageStatus}
                          {stage.total_tasks > 0 ? ` · ${stage.passed_tasks}/${stage.total_tasks}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] font-semibold text-foreground">
                        {formatDurationSec(stage.wall_sec, locale)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {telemetry && telemetry.models.length > 0 && (
            <div className="right-inspector__telemetry-card">
              <h3 className="m-0 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {messages.inspector.modelRuntimeTitle}
              </h3>
              <div className="grid gap-2">
                {telemetry.models.map((item) => {
                  const providerName = formatProviderDisplay(item.display_provider || item.provider);
                  const modelTitle = item.model ? `${providerName} / ${item.model}` : providerName;
                  return (
                    <div
                      key={item.actor}
                      className="grid gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-[11px] font-semibold text-text-strong" title={modelTitle}>
                          {modelTitle}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-foreground">
                          {formatDurationSec(item.duration_sec, locale)}
                          {item.estimated ? ` (${messages.inspector.estimatedTag})` : ''}
                        </span>
                      </div>
                      <div className="right-inspector__telemetry-bar-track" aria-hidden="true">
                        <div
                          className="right-inspector__telemetry-bar-fill"
                          style={{ width: `${Math.min(100, Math.max(3, item.share_pct))}%` }}
                        />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-1 text-[10.5px] text-muted-foreground">
                        <span>{translateRole(item.role, locale)}</span>
                        <span className="font-mono">
                          {messages.inspector.callCount(item.calls)} · {messages.inspector.avgDuration(formatDurationSec(item.avg_sec, locale))} · {item.share_pct.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            {snapshot.tasks.length > 0 && (
              <p className="m-0 text-[11px] text-muted-foreground">
                {messages.inspector.taskDetailHint}
              </p>
            )}
            <div className="right-inspector__tasks" tabIndex={0} role="region" aria-label={messages.inspector.tasksAria}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{messages.inspector.table.id}</th>
                    <th>{messages.inspector.table.title}</th>
                    <th>{messages.inspector.table.tier}</th>
                    <th>{messages.inspector.table.status}</th>
                    <th>{messages.inspector.table.assignee}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.tasks.map((task, index) => {
                    const taskId = display(task.id, `task-${index}`);
                    const taskTier = display(task.tier);
                    const taskStatus = display(task.status);
                    const taskAssignee = display(task.current_role ?? task.assignee_role);
                    const isExpanded = expandedTaskId === taskId;
                    const taskEvents = isExpanded
                      ? snapshot.events.filter((ev) => display(ev.task_id, '') === taskId)
                      : [];
                    const allowedFiles = isExpanded ? parseAllowedFiles(task.allowed_files) : [];
                    const lastError = display(task.last_error, '');
                    const assignedModel = display(task.assigned_model, '');

                    return (
                      <Fragment key={taskId}>
                        <tr
                          className="right-inspector__task-row"
                          data-expanded={isExpanded}
                          onClick={() => setExpandedTaskId(isExpanded ? null : taskId)}
                        >
                          <td>
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpandedTaskId(isExpanded ? null : taskId);
                              }}
                              className="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-mono text-xs text-foreground cursor-pointer"
                            >
                              {isExpanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                              <code>{taskId}</code>
                            </button>
                          </td>
                          <td>{display(task.title)}</td>
                          <td>{translateTier(taskTier, locale)}</td>
                          <td>{messages.inspector.runStatuses[taskStatus] ?? taskStatus}</td>
                          <td>{translateRole(taskAssignee, locale)}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="right-inspector__task-detail-row">
                            <td colSpan={5}>
                              <div className="grid gap-2 text-xs">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <strong className="text-text-strong">{messages.inspector.taskDetailTitle}</strong>
                                  <span className="font-mono text-[11px] text-muted-foreground">
                                    {messages.inspector.taskDetailCounters(
                                      asNumber(task.self_heal_count),
                                      asNumber(task.review_reject_count),
                                      asNumber(task.escalated),
                                    )}
                                  </span>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                  <span>
                                    <span className="text-muted-foreground">{messages.inspector.taskDetailModel}: </span>
                                    <code className="font-mono">{assignedModel ? formatDisplayTarget(assignedModel) : '—'}</code>
                                  </span>
                                  <span>
                                    <span className="text-muted-foreground">{messages.inspector.taskDetailDuration}: </span>
                                    <span className="font-mono">{formatDurationSec(asNumber(task.duration_sec), locale)}</span>
                                  </span>
                                </div>
                                {allowedFiles.length > 0 && (
                                  <div className="grid gap-1">
                                    <span className="text-[11px] text-muted-foreground">{messages.inspector.taskDetailFiles}:</span>
                                    <div className="flex flex-wrap gap-1">
                                      {allowedFiles.map((filePath) => (
                                        <code key={filePath} className="rounded bg-card px-1.5 py-0.5 font-mono text-[10.5px] border border-border">
                                          {filePath}
                                        </code>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {lastError && (
                                  <div className="grid gap-1">
                                    <span className="text-[11px] font-medium text-[var(--rose)]">{messages.inspector.taskDetailLastError}:</span>
                                    <pre className="m-0 max-h-28 overflow-auto rounded border border-border bg-card p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                                      {lastError}
                                    </pre>
                                  </div>
                                )}
                                <div className="grid gap-1">
                                  <span className="text-[11px] text-muted-foreground">{messages.inspector.taskDetailEvents}:</span>
                                  {taskEvents.length === 0 ? (
                                    <span className="text-[11px] text-muted-foreground">{messages.inspector.taskDetailNoEvents}</span>
                                  ) : (
                                    <ul className="m-0 grid gap-1 p-0 list-none">
                                      {taskEvents.map((ev, evIdx) => {
                                        const evKind = display(ev.kind, 'event');
                                        const evMsg = display(ev.message, '');
                                        const formatted = formatLiveEventMessage(evKind, evMsg, locale);
                                        return (
                                          <li key={display(ev.id, `ev-${evIdx}`)} className="rounded border border-border bg-card px-2 py-1 text-[11px]">
                                            <span className="font-semibold text-primary">{translateEventKind(evKind, locale)}</span>
                                            {' · '}
                                            <span className="break-words">{formatted.summary}</span>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {snapshot.tasks.length === 0 && <tr><td colSpan={5}>{messages.inspector.noTasks}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <p className="m-0 rounded-xl border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {messages.inspector.noRuns}
        </p>
      )}

      <div className="right-inspector__section">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground m-0">
          {messages.inspector.eventLogTitle}
        </h3>
        <div
          className="right-inspector__event-log right-inspector__mono"
          ref={eventLog}
          role="log"
          aria-label={messages.inspector.eventLogAria}
          tabIndex={0}
        >
          {snapshot.events.map((event, index) => {
            const rawKind = display(event.kind, 'event');
            const rawMsg = display(event.message, '');
            const taskId = display(event.task_id, '');
            const kindLabel = translateEventKind(rawKind, locale);
            const { summary, rawDetail } = formatLiveEventMessage(rawKind, rawMsg, locale);
            return (
              <div className="right-inspector__event" key={display(event.id, `event-${index}`)}>
                <span className="right-inspector__event-kind">{kindLabel}</span>
                <span>{[taskId, summary].filter(Boolean).join(' · ')}</span>
                {rawDetail && (
                  <details className="right-inspector__event-detail">
                    <summary>{messages.inspector.originalNote}</summary>
                    <pre>{rawDetail}</pre>
                  </details>
                )}
              </div>
            );
          })}
          {snapshot.events.length === 0 && (
            <p className="m-0 text-xs text-muted-foreground">{messages.inspector.noEvents}</p>
          )}
        </div>
      </div>

      {visible && report && (
        <Modal open wide title={messages.inspector.modalReportTitle} onClose={() => setReport(null)}>
          <div className="right-inspector__report-toolbar">
            <code className="text-xs font-mono text-muted-foreground">{report.runId}</code>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={!reportRawMode ? 'default' : 'outline'}
                size="sm"
                aria-pressed={!reportRawMode}
                onClick={() => setReportRawMode(false)}
              >
                {messages.inspector.reportRendered}
              </Button>
              <Button
                variant={reportRawMode ? 'default' : 'outline'}
                size="sm"
                aria-pressed={reportRawMode}
                onClick={() => setReportRawMode(true)}
              >
                {messages.inspector.reportRaw}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copyReportMarkdown()}>
                {messages.inspector.reportCopy}
              </Button>
            </div>
          </div>
          {reportRawMode ? (
            <pre className="right-inspector__report right-inspector__mono">{report.markdown}</pre>
          ) : (
            <div className="right-inspector__report-body">
              <MarkdownView markdown={report.markdown} />
            </div>
          )}
        </Modal>
      )}
      {startOpen && (
        <StartRunModal
          client={client}
          onToast={onToast}
          onClose={() => setStartOpen(false)}
          onStarted={() => void refreshActiveRun()}
        />
      )}
    </section>
  );
}
