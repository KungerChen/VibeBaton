import './ContextDrawer.css';
import { useId, useState, type ReactNode } from 'react';
import type { BatonApiClient } from '../../api/client';
import { computeLiveSeconds, formatDurationSec, isRunStatusActive } from '../../engine/liveClock';
import type { LiveRunGraphView } from '../../engine/liveRunGraph';
import { translateTier } from '../../i18n/liveEvents';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { formatProviderModel, translateRole } from '../../i18n/presets';
import type { ExecutionState, LiveRunSnapshot, RunListItem, WorkflowNode } from '../../types/graph';
import { BattleReportModal, useBattleReport } from '../inspector/BattleReportModal';
import { formatReportedUsd, formatTokenCount, usageCoverage } from '../inspector/billingFormat';
import { PricingModal } from '../inspector/PricingModal';

/** Who the drawer shows, in priority order: a pending decision, the selected object, the run overview. */
export type DrawerOwner = 'decision' | 'task' | 'node' | 'handoff' | 'overview';

type DetailsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function drawerDetailsKey(panel: DrawerOwner): string {
  return `vibebaton.drawerDetails.${panel}`;
}

/** Whether the user last expanded the technical details of this panel type; collapsed when unknown. */
export function readDrawerDetails(storage: Pick<Storage, 'getItem'> | null, panel: DrawerOwner): boolean {
  try { return storage?.getItem(drawerDetailsKey(panel)) === 'open'; } catch { return false; }
}

export function writeDrawerDetails(storage: Pick<Storage, 'setItem'> | null, panel: DrawerOwner, open: boolean): void {
  try { storage?.setItem(drawerDetailsKey(panel), open ? 'open' : 'closed'); } catch { /* Storage may be unavailable. */ }
}

export function browserStorage(): DetailsStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage ?? null; } catch { return null; }
}

/** The last six characters of a run ID, the suffix its branches and worktrees use. */
export function shortRunId(runId: string): string {
  return runId.slice(-6);
}

/** A run's short ID in monospace, with the full ID on hover. */
export function ShortRunId({ runId }: { runId: string }) {
  return <code className="run-short-id" title={runId}>{shortRunId(runId)}</code>;
}

/** The fixed side panel of Build: never a layer over the graph, never takes focus. */
export function ContextDrawer({ locale, owner, children }: { locale: Locale; owner: DrawerOwner; children?: ReactNode }) {
  return (
    <aside className="context-drawer" aria-label={MESSAGES[locale].guided.relay.drawerAria} data-owner={owner}>
      {children}
    </aside>
  );
}

/** One panel of the drawer; a panel that is not the owner stays mounted, hidden and out of reach. */
export function DrawerPanel({ panel, owner, children }: { panel: DrawerOwner; owner: DrawerOwner; children?: ReactNode }) {
  return <section className="context-drawer__panel" data-panel={panel} hidden={panel !== owner}>{children}</section>;
}

/** Technical details, collapsed by default; only the user's own toggle is remembered, per panel type. */
export function DrawerDetails({ panel, locale, children }: { panel: DrawerOwner; locale: Locale; children?: ReactNode }) {
  const bodyId = useId();
  const [open, setOpen] = useState(() => readDrawerDetails(browserStorage(), panel));
  return (
    <div className="context-drawer__details">
      <button type="button" className="context-drawer__details-toggle" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { setOpen(!open); writeDrawerDetails(browserStorage(), panel, !open); }}>
        {MESSAGES[locale].guided.relay.details}
      </button>
      <div id={bodyId} className="context-drawer__details-body" hidden={!open}>{children}</div>
    </div>
  );
}

/** Planner, milestone review, final gate and panel nodes. */
export function RelayNodePanel({ node, state, locale }: { node: WorkflowNode; state: ExecutionState; locale: Locale }) {
  const copy = MESSAGES[locale].guided;
  const relay = copy.relay;
  const { provider, model, duration_sec: duration } = node.config ?? {};
  const modelText = formatProviderModel(typeof provider === 'string' ? provider : null, typeof model === 'string' ? model : null);
  return (
    <>
      <header className="context-drawer__head">
        <h2 className="context-drawer__title">{node.label}</h2>
      </header>
      <div className="context-drawer__upper">
        {relay.node.kinds[node.type] ? <p>{relay.node.kinds[node.type]}</p> : null}
        <p><span className="context-drawer__label">{relay.node.status}</span> <strong data-field="state">{relay.node.states[state]}</strong></p>
      </div>
      <DrawerDetails panel="node" locale={locale}>
        <dl className="context-drawer__facts">
          <dt>{relay.node.role}</dt>
          <dd data-field="role">{node.role ? translateRole(node.role, locale) : relay.unknown}</dd>
          <dt>{copy.nodeDetail.model}</dt>
          <dd data-field="model">{modelText || relay.unknown}</dd>
          <dt>{copy.nodeDetail.elapsed}</dt>
          <dd data-field="elapsed">{typeof duration === 'number' ? formatDurationSec(duration, locale) : relay.unknown}</dd>
        </dl>
      </DrawerDetails>
    </>
  );
}

type ReportToast = (message: string, kind?: 'ok' | 'err') => void;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The battle report and the model prices; both open as dialogs over the workbench. */
function RunReportActions({ client, runId, locale, onToast }: {
  client: Pick<BatonApiClient, 'getRunReport' | 'getPricing' | 'syncPricing' | 'saveCustomPricing'>;
  runId: string;
  locale: Locale;
  onToast: ReportToast;
}) {
  const messages = MESSAGES[locale];
  const [pricingOpen, setPricingOpen] = useState(false);
  const reports = useBattleReport(client, locale, onToast);
  return (
    <>
      <button type="button" className="context-drawer__button" aria-haspopup="dialog" disabled={reports.loading}
        onClick={() => void reports.show(runId)}>{messages.guided.signOff.battleReport}</button>
      <button type="button" className="context-drawer__button" aria-haspopup="dialog"
        onClick={() => setPricingOpen(true)}>{messages.pricing.openButton}</button>
      {reports.report ? (
        <BattleReportModal report={reports.report} locale={locale} onClose={reports.close} onToast={onToast} />
      ) : null}
      <PricingModal open={pricingOpen} client={client} onClose={() => setPricingOpen(false)} />
    </>
  );
}

export interface RunOverviewPanelProps {
  snapshot: LiveRunSnapshot;
  view: LiveRunGraphView;
  locale: Locale;
  /** The ticking clock of an active run (seconds, server time). */
  liveNowSec?: number;
  /** Pause and resume; without them the panel offers neither. */
  controls?: { busy: boolean; synced: boolean; changeRun(runId: string, action: 'pause' | 'resume'): void };
  /** Given only while the workbench's stop and replan flow allows stopping this run. */
  onStop?: () => void;
  /** The battle report and the model prices are offered when both are given. */
  client?: Pick<BatonApiClient, 'getRunReport' | 'getPricing' | 'syncPricing' | 'saveCustomPricing'>;
  onToast?: ReportToast;
  history?: { runs: readonly RunListItem[]; onSelect(runId: string): void };
  /** A task row selects that task on the graph, as a click on its node does. */
  onSelectTask?: (taskId: string) => void;
}

/** The run history: choosing a run opens it. In Build it sits in the run overview, elsewhere in the top row. */
export function RunHistorySelect({ runs, value, locale, onSelect }: {
  runs: readonly RunListItem[]; value: string; locale: Locale; onSelect(runId: string): void;
}) {
  const inspector = MESSAGES[locale].inspector;
  return (
    <label className="context-drawer__field">
      <span className="context-drawer__label">{inspector.runHistoryLabel}</span>
      <select className="context-drawer__select" value={value} onChange={(event) => onSelect(event.currentTarget.value)}>
        {/* No run is shown yet (Blueprint): an empty choice, so that picking any run is a change. */}
        {runs.some((item) => item.id === value) ? null : <option value="">-</option>}
        {runs.map((item) => (
          <option key={item.id} value={item.id}>
            {inspector.runHistoryOption(item.id, inspector.runStatuses[item.status] ?? item.status,
              item.passed_tasks, item.total_tasks, formatDurationSec(item.elapsed_sec, locale))}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Nothing selected and nothing to decide: how the run is doing, which step is working and what can be done now. */
export function RunOverviewPanel({
  snapshot, view, locale, liveNowSec, controls, onStop, client, onToast, history, onSelectTask,
}: RunOverviewPanelProps) {
  const messages = MESSAGES[locale];
  const inspector = messages.inspector;
  const copy = messages.guided.relay;
  const runId = text(snapshot.run?.id);
  const short = shortRunId(runId);
  const status = typeof snapshot.run?.status === 'string' ? snapshot.run.status : '';
  const done = snapshot.tasks.filter((task) => task.status === 'PASSED').length;
  const working = view.graph.nodes.filter((node) => view.nodeStates[node.id] === 'active').map((node) => node.label);
  const telemetry = snapshot.telemetry ?? null;
  const serverNow = telemetry?.server_now;
  // As in LiveRunPanel: the telemetry already counts up to server_now, so the clock adds only the time since then.
  const isActive = isRunStatusActive(status) && liveNowSec !== undefined && Number.isFinite(serverNow);
  const now = liveNowSec ?? 0;
  const elapsed = computeLiveSeconds(telemetry?.elapsed_sec ?? 0, serverNow, isActive, now);
  const billing = telemetry?.billing && (telemetry.billing.has_exact_billing === true || (telemetry.billing.total_calls ?? 0) > 0)
    ? telemetry.billing : null;
  const coverage = usageCoverage(billing, locale);
  const attention = telemetry?.attention;
  const attentionDetail = attention ? attention.message.trim() || messages.attention.fallbackDetails[attention.category] : '';
  const models = telemetry?.models ?? [];
  const modelTimings = models.map((item) => {
    const active = isActive && Number.isFinite(item.active_started_at);
    return { active, durationSec: computeLiveSeconds(item.duration_sec, serverNow, active, now) };
  });
  const modelLiveTotal = modelTimings.reduce((sum, { durationSec }) => sum + durationSec, 0);
  const pauseOrResume = controls && runId && (status === 'RUNNING' || status === 'PAUSED') ? controls : null;
  return (
    <>
      <header className="context-drawer__head">
        <h2 className="context-drawer__title">{copy.overview.title}</h2>
      </header>
      <div className="context-drawer__upper">
        <p data-field="run-status">{copy.overview.statuses[status] ?? copy.overview.statusOther(status || copy.unknown)}</p>
        <p className="context-drawer__status-row">
          <span className="context-drawer__badge" data-field="status-badge" data-status={status}>
            {inspector.runStatuses[status] ?? (status || copy.unknown)}
          </span>
          <span data-field="elapsed">{inspector.totalElapsed(formatDurationSec(elapsed, locale, isActive))}</span>
        </p>
        <p data-field="tasks-done">{copy.overview.tasksDone(done, snapshot.tasks.length)}</p>
        <p data-field="cost">
          {[inspector.billingTotalCost(formatReportedUsd(billing?.total_cost_usd, locale)), coverage].filter(Boolean).join(' · ')}
        </p>
        {attention ? (
          <p data-field="attention" className="context-drawer__attention" title={attentionDetail}>
            <strong>{messages.attention.badges[attention.category]}</strong>{` · ${attentionDetail}`}
          </p>
        ) : null}
        <p data-field="holder">{working.length
          ? copy.overview.holder(working.join(locale === 'zh' ? '、' : ', ')) : copy.overview.noHolder}</p>
        {pauseOrResume || onStop || (client && onToast) ? (
          <div className="context-drawer__actions">
            {pauseOrResume ? (
              <button type="button" className="context-drawer__button" disabled={pauseOrResume.busy || !pauseOrResume.synced}
                onClick={() => pauseOrResume.changeRun(runId, status === 'RUNNING' ? 'pause' : 'resume')}>
                {status === 'RUNNING' ? copy.overview.pauseRun(short) : copy.overview.resumeRun(short)}
              </button>
            ) : null}
            {onStop ? (
              <button type="button" className="context-drawer__button" onClick={onStop}>{copy.overview.stopRun(short)}</button>
            ) : null}
            {client && onToast ? <RunReportActions client={client} runId={runId} locale={locale} onToast={onToast} /> : null}
          </div>
        ) : null}
        {history && history.runs.length > 0 ? (
          <RunHistorySelect runs={history.runs} value={runId} locale={locale} onSelect={history.onSelect} />
        ) : null}
        <p className="context-drawer__hint">{copy.overview.hint}</p>
      </div>
      <DrawerDetails panel="overview" locale={locale}>
        {telemetry && telemetry.stages.length > 0 ? (
          <section className="context-drawer__section" data-field="stage-timing">
            <h3>{inspector.stageTimingTitle}</h3>
            <ul className="context-drawer__rows">
              {telemetry.stages.map((stage) => {
                const label = stage.kind === 'planning' ? inspector.planningStageLabel
                  : stage.kind === 'panel' ? inspector.panelStageLabel : `${stage.id} · ${stage.title}`;
                const stageActive = isActive && stage.is_active === true;
                const progress = stage.total_tasks > 0 ? `${stage.passed_tasks}/${stage.total_tasks}` : '';
                return (
                  <li key={stage.id} className="context-drawer__row">
                    <span className="context-drawer__row-main">
                      <strong>{label}</strong>
                      <span className="context-drawer__label">
                        {[inspector.runStatuses[stage.status] ?? stage.status, progress].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="context-drawer__row-value">
                      {formatDurationSec(computeLiveSeconds(stage.wall_sec, serverNow, stageActive, now), locale, stageActive)}
                      {stageActive ? <span className="context-drawer__live">{messages.liveClock.live}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {models.length > 0 ? (
          <section className="context-drawer__section" data-field="model-runtime">
            <h3>{inspector.modelRuntimeTitle}</h3>
            {billing?.has_exact_billing ? (
              <p className="context-drawer__label">{inspector.billingTokens(formatTokenCount(billing.total_prompt_tokens, locale),
                formatTokenCount(billing.total_completion_tokens, locale), formatTokenCount(billing.total_cached_tokens, locale))}</p>
            ) : null}
            <ul className="context-drawer__rows">
              {models.map((item, index) => {
                const { active, durationSec } = modelTimings[index];
                // The server's share is of the total model time; recount it once active models have moved on.
                const share = isActive ? (modelLiveTotal > 0 ? (durationSec / modelLiveTotal) * 100 : 0) : item.share_pct;
                return (
                  <li key={item.actor} className="context-drawer__row">
                    <span className="context-drawer__row-main">
                      <strong><code>{formatProviderModel(item.display_provider || item.provider, item.model)}</code></strong>
                      <span className="context-drawer__label">{translateRole(item.role, locale)}</span>
                      <span className="context-drawer__label">
                        {`${inspector.callCount(item.calls)} · ${inspector.avgDuration(formatDurationSec(item.avg_sec, locale))} · ${share.toFixed(1)}%`}
                      </span>
                      {billing ? (
                        <span className="context-drawer__label">
                          {item.prompt_tokens || item.completion_tokens ? `${inspector.billingPerModel(
                            formatTokenCount(item.prompt_tokens, locale), formatTokenCount(item.completion_tokens, locale))} · ` : ''}
                          <span>{formatReportedUsd(item.cost_usd, locale)}</span>
                        </span>
                      ) : null}
                    </span>
                    <span className="context-drawer__row-value">
                      {`${formatDurationSec(durationSec, locale, active)}${item.estimated ? ` (${inspector.estimatedTag})` : ''}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <section className="context-drawer__section" data-field="tasks">
          <h3>{inspector.tasksAria}</h3>
          {snapshot.tasks.length ? (
            <ul className="context-drawer__rows">
              {snapshot.tasks.map((task, index) => {
                const taskId = text(task.id, `task-${index}`);
                const taskStatus = text(task.status);
                const role = text(task.current_role ?? task.assignee_role);
                const timing = telemetry?.task_timings?.[taskId];
                const taskActive = isActive && timing?.is_active === true && Number.isFinite(timing.started_at);
                const seconds = timing ? computeLiveSeconds(timing.duration_sec, serverNow, taskActive, now) : count(task.duration_sec);
                return (
                  <li key={taskId}>
                    <button type="button" className="context-drawer__task" data-task={taskId}
                      onClick={onSelectTask ? () => onSelectTask(taskId) : undefined}>
                      <span className="context-drawer__row-main">
                        <strong><code>{taskId}</code> {text(task.title)}</strong>
                        <span className="context-drawer__label">
                          {[inspector.runStatuses[taskStatus] ?? taskStatus, task.tier ? translateTier(text(task.tier), locale) : '',
                            role ? translateRole(role, locale) : ''].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="context-drawer__row-value">{formatDurationSec(seconds, locale, taskActive)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="context-drawer__label">{inspector.noTasks}</p>}
        </section>
        <dl className="context-drawer__facts">
          <dt>{copy.overview.runId}</dt>
          <dd><code>{String(snapshot.run?.id ?? copy.unknown)}</code></dd>
          <dt>{copy.overview.runStatus}</dt>
          <dd><code>{status || copy.unknown}</code></dd>
        </dl>
      </DrawerDetails>
    </>
  );
}

export interface RunDecisionPanelProps {
  runId: string;
  question: string;
  milestoneId: string | null;
  locale: Locale;
  busy: boolean;
  /** While the shown snapshot is not the synced one. */
  disabled?: boolean;
  /** Approve lets the run continue, reject pauses it; resolves true once the server took the answer. */
  onDecide(runId: string, action: 'approve' | 'reject', note: string): Promise<boolean>;
}

/** A decision of the whole run that names no task, for example a milestone review asking to change the plan. */
export function RunDecisionPanel({ runId, question, milestoneId, locale, busy, disabled = false, onDecide }: RunDecisionPanelProps) {
  const messages = MESSAGES[locale];
  const copy = messages.guided.relay;
  const noteId = useId();
  const [note, setNote] = useState('');
  const short = shortRunId(runId);
  const blocked = busy || disabled;

  async function decide(action: 'approve' | 'reject') {
    if (blocked) return;
    if (await onDecide(runId, action, note)) setNote('');
  }

  return (
    <div className="run-decision" data-run={runId}>
      <header className="context-drawer__head">
        <h2 className="context-drawer__title">{copy.runDecisionTitle(short)}</h2>
      </header>
      <div className="context-drawer__upper">
        {milestoneId ? <p>{copy.runDecisionMilestone(milestoneId)}</p> : null}
        {question ? <p className="run-decision__question">{question}</p> : null}
        <p className="context-drawer__hint">{copy.runDecisionHint}</p>
        <label className="context-drawer__label" htmlFor={noteId}>{messages.inspector.decisionNote}</label>
        <textarea id={noteId} className="run-decision__note" rows={3} value={note} disabled={blocked}
          onChange={(event) => setNote(event.currentTarget.value)} />
        <div className="context-drawer__actions">
          <button type="button" className="context-drawer__button context-drawer__button--primary" disabled={blocked}
            onClick={() => decide('approve')}>{copy.approveRun(short)}</button>
          <button type="button" className="context-drawer__button" disabled={blocked}
            onClick={() => decide('reject')}>{copy.rejectRun(short)}</button>
        </div>
      </div>
    </div>
  );
}
