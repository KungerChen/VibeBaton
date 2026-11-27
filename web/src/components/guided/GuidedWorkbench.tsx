import './GuidedWorkbench.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNodesState } from '@xyflow/react';
import { ApiError, type ApiMode, type BatonApiClient, type FinalizeAction, type GuidedSession, type RecommendedLineup, type StopAndReplanResult } from '../../api/client';
import { graphToFlow } from '../../engine/flowAdapter';
import { buildLiveRunGraph, projectLiveRunCanvas } from '../../engine/liveRunGraph';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import { cn } from '../../lib/utils';
import { CanvasWorkspace } from '../CanvasWorkspace';
import type { BatonFlowNode } from '../nodes/BatonNode';
import { clearBrainstorm, GuidedBrainstormStep, type GuidedBrainstormApi, type LaunchPayload } from './GuidedBrainstormStep';
import { GuidedDecisionDrawer } from './GuidedDecisionDrawer';
import { optionsFromEvent, type GuidedDecisionOption } from './GuidedDecisionModal';
import { GuidedFailedBanner } from './GuidedFailedBanner';
import { GuidedSetupStep, lineupSummary } from './GuidedSetupStep';
import { GuidedSignOffPanel, loadSignOffLineage, type SignOffDeliverable, type SignOffSummary } from './GuidedSignOffPanel';
import { isStaleRunError, localizeGuidedError } from './guidedErrors';
import { NodeDetailDrawer } from './NodeDetailDrawer';
import { useGuidedSession } from './useGuidedSession';

export const GUIDED_STEPS = ['setup', 'brainstorm', 'live', 'signoff'] as const;
export type GuidedStep = (typeof GUIDED_STEPS)[number];

/** Sign-off is only actionable once the backend accepts `/finalize` (or the run already landed). */
const SIGNOFF_RUN_STATUSES = new Set(['READY_FOR_FINAL_GATE', 'COMPLETED']);
/** Matches the task node ids produced by `buildLiveRunGraph`. */
const LIVE_TASK_NODE_PREFIX = 'live-task-';

/** The step after `step`; sign-off is the last step and stays put. */
export function nextStep(step: GuidedStep): GuidedStep {
  return GUIDED_STEPS[Math.min(GUIDED_STEPS.indexOf(step) + 1, GUIDED_STEPS.length - 1)];
}

/** Step a launched run belongs on, or null while there is no run status yet. */
export function stepFromRun(runStatus: unknown): GuidedStep | null {
  if (typeof runStatus !== 'string' || !runStatus.trim()) return null;
  return SIGNOFF_RUN_STATUSES.has(runStatus.trim().toUpperCase()) ? 'signoff' : 'live';
}

/** Task id behind a live canvas node id; milestone, planner and gate nodes return null. */
export function taskIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(LIVE_TASK_NODE_PREFIX) && nodeId.length > LIVE_TASK_NODE_PREFIX.length
    ? nodeId.slice(LIVE_TASK_NODE_PREFIX.length)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(event.payload) ?? asRecord(event.payload_json);
}

export interface WaitingDecision {
  /** Changes whenever the backend raises a new decision, so a resolved one does not reopen. */
  key: string;
  taskId: string;
  question: string;
  options: GuidedDecisionOption[];
}

/**
 * The open human decision of a WAITING_HUMAN run: the latest `waiting_human` attention event,
 * falling back to any task the backend marked WAITING_HUMAN. The resolve endpoint needs a task id,
 * so a decision without one returns null.
 */
export function waitingDecision(snapshot: LiveRunSnapshot | null): WaitingDecision | null {
  const run = snapshot?.run;
  if (!snapshot || !run || run.status !== 'WAITING_HUMAN') return null;
  let lastDecisionIdx = -1;
  for (let i = snapshot.events.length - 1; i >= 0; i -= 1) {
    if (snapshot.events[i]?.kind === 'human_decision') {
      lastDecisionIdx = i;
      break;
    }
  }
  const event = snapshot.events
    .slice(lastDecisionIdx + 1)
    .reverse()
    .find((row) => row.kind === 'human_attention_required' && eventPayload(row)?.category === 'waiting_human');
  const waitingTask = snapshot.tasks.find((task) => task.status === 'WAITING_HUMAN');
  const taskId = typeof waitingTask?.id === 'string' && waitingTask.id
    ? waitingTask.id
    : typeof event?.task_id === 'string' && event.task_id ? event.task_id : '';
  if (!taskId) return null;
  const prompt = typeof run.human_prompt === 'string' ? run.human_prompt.trim() : '';
  const message = typeof event?.message === 'string' ? event.message.trim() : '';
  return {
    key: `${String(run.id)}|${taskId}|${String(event?.id ?? run.updated_at ?? '')}`,
    taskId,
    question: prompt || message,
    options: optionsFromEvent(event),
  };
}

/**
 * Sign-off figures from the live snapshot. A task only reaches PASSED after its mechanical
 * verification gate, so passed tasks stand in for passed checks; changed files are the union
 * reported by task events.
 */
export function signOffSummaryFromSnapshot(snapshot: LiveRunSnapshot): SignOffSummary {
  const changed = new Set<string>();
  for (const event of snapshot.events) {
    const files = eventPayload(event)?.changed_files;
    if (Array.isArray(files)) for (const file of files) changed.add(String(file));
  }
  return {
    testsPassed: snapshot.tasks.filter((task) => task.status === 'PASSED').length,
    testsTotal: snapshot.tasks.length,
    changedFiles: [...changed],
    reportUrl: '',
  };
}

/** Extract concise task deliverable rows from a live run snapshot for beginner-friendly sign-off review. */
export function signOffDeliverablesFromSnapshot(snapshot: LiveRunSnapshot): SignOffDeliverable[] {
  const taskSummaries = new Map<string, string>();
  for (const event of snapshot.events) {
    const taskId = typeof event.task_id === 'string' ? event.task_id : '';
    const payload = eventPayload(event);
    const note = [payload?.summary, payload?.result, event.message]
      .find((item) => typeof item === 'string' && item.trim());
    if (taskId && typeof note === 'string') {
      taskSummaries.set(taskId, note.trim().slice(0, 220));
    }
  }
  return snapshot.tasks.map((task, idx) => {
    const id = typeof task.id === 'string' && task.id ? task.id : `task-${idx + 1}`;
    const title = typeof task.title === 'string' && task.title.trim() ? task.title.trim() : id;
    const status = typeof task.status === 'string' && task.status ? task.status : 'PENDING';
    const rawSummary = typeof task.summary === 'string' && task.summary.trim()
      ? task.summary.trim()
      : taskSummaries.get(id);
    return rawSummary ? { id, title, status, summary: rawSummary } : { id, title, status };
  });
}

function runIdOf(snapshot: LiveRunSnapshot | null): string | null {
  const id = snapshot?.run?.id;
  return typeof id === 'string' ? id : null;
}

/** The server retains extra session fields, so the complete stop result survives a refresh. */
export function replanContextFromSession(session: GuidedSession | null): StopAndReplanResult | null {
  if (!session?.active_run_id) return null;
  const contexts = asRecord(session.brainstorm.replan_contexts);
  const result = readReplanResult(contexts?.[session.active_run_id]);
  return result?.run_id === session.active_run_id ? result : null;
}

function readReplanResult(value: unknown): StopAndReplanResult | null {
  const context = asRecord(value);
  const errors = asRecord(context?.last_errors);
  if (!context || context.ok !== true || context.status !== 'SUPERSEDED'
    || typeof context.run_id !== 'string' || !Array.isArray(context.failed_tasks)
    || !context.failed_tasks.every((task) => typeof task === 'object' && task !== null && !Array.isArray(task))
    || !errors || !Object.values(errors).every((error) => typeof error === 'string') || typeof context.current_sha !== 'string'
    || typeof context.run_summary !== 'string') return null;
  return context as unknown as StopAndReplanResult;
}

function pendingReplanFromSession(session: GuidedSession): { runId: string; result: StopAndReplanResult | null } | null {
  const runId = session.active_run_id;
  if (!runId) return null;
  const pending = asRecord(asRecord(session.replan_pending)?.[runId]);
  if (!pending || pending.run_id !== runId) return null;
  const result = readReplanResult(pending.result);
  return { runId: pending.run_id, result: result?.run_id === pending.run_id ? result : null };
}

/** Launch a stopped parent's revision; recover an already created child after an uncertain response. */
export async function startReplannedRevision(client: BatonApiClient, parentId: string, payload: LaunchPayload): Promise<string> {
  const pendingKey = (session: GuidedSession) => asRecord(session.workflow.guided_pending_launch)?.launch_request_id;
  const revisionNote = (session: GuidedSession) => {
    const revision = asRecord(session.brainstorm.guided_revision);
    const requested = revision?.run_id === parentId && typeof revision.requested_changes === 'string'
      ? revision.requested_changes.trim() : '';
    return [requested, `Revised blueprint:\n\n${payload.rfc_markdown}`].filter(Boolean).join('\n\n');
  };
  async function recover(session: GuidedSession, candidate?: string): Promise<string | null> {
    if (pendingKey(session) !== payload.launch_request_id) return null;
    if (session.active_run_id !== parentId && session.active_run_id !== candidate) return null;
    const children = candidate ? [candidate] : (await client.listLineageRuns())
      .filter((run) => run.parent_run_id === parentId).map((run) => run.id);
    if (children.length !== 1) return null;
    const childId = children[0];
    const child = await client.getLineageRun(childId);
    if (child.run?.id !== childId || child.run.parent_run_id !== parentId) return null;
    const parent = await client.getLineageRun(parentId);
    const matchingRequest = parent.events.some((event) => event.kind === 'revision_requested'
      && event.message === revisionNote(session) && eventPayload(event)?.revision_run_id === childId);
    if (!matchingRequest) return null;
    if (session.active_run_id === parentId) {
      await client.saveGuidedSession({ active_run_id: childId, active_stage: 'build', open_human_gate: null, open_drawer: null });
    }
    return childId;
  }
  const latest = await client.getGuidedSession();
  if (latest.active_run_id !== parentId) {
    const child = latest.active_run_id && await recover(latest, latest.active_run_id);
    if (child) return child;
    throw new ApiError(409, 'The active run changed. Refresh the session before continuing.', { code: 'RUN_STALE' });
  }
  if (latest.active_stage !== 'blueprint' || pendingKey(latest) !== payload.launch_request_id
    || replanContextFromSession(latest)?.run_id !== parentId) {
    throw new ApiError(409, 'The revision session changed. Refresh before continuing.', { code: 'RUN_STALE' });
  }
  const note = revisionNote(latest);
  try {
    const result = await client.requestChanges(parentId, note);
    if (result.run_id !== parentId || result.status !== 'SUPERSEDED' || !result.revision_run_id) {
      throw new ApiError(409, 'The revision response did not identify the parent and child runs.', { code: 'RUN_STALE' });
    }
    return result.revision_run_id;
  } catch (failure) {
    try {
      const current = await client.getGuidedSession();
      const candidate = failure instanceof ApiError && typeof failure.data?.run_id === 'string'
        ? failure.data.run_id : current.active_run_id !== parentId ? current.active_run_id ?? undefined : undefined;
      const child = await recover(current, candidate);
      if (child) return child;
    } catch { /* Keep the original failure and the saved intent available for retry. */ }
    throw failure;
  }
}

export function formatReplanContext(context: StopAndReplanResult): string {
  const tasks = context.failed_tasks.map((task) => {
    const id = typeof task.id === 'string' ? task.id : '';
    const title = typeof task.title === 'string' ? task.title : '';
    return [id, title].filter(Boolean).join(' — ');
  }).filter(Boolean);
  const errors = Object.entries(context.last_errors).map(([id, error]) => `${id}: ${error}`);
  return [context.run_summary, ...tasks, ...errors, context.current_sha ? `SHA: ${context.current_sha}` : '']
    .filter(Boolean).join('\n');
}

function lineupFromSession(session: GuidedSession): RecommendedLineup | null {
  const saved = asRecord(session.workflow.guided_selected_lineup);
  const savedRoles = asRecord(saved?.roles);
  const savedOverrides = saved?.model_overrides === undefined ? {} : asRecord(saved.model_overrides);
  if ((session.active_run_id === null || session.workflow.guided_selected_run_id === session.active_run_id)
    && saved && typeof saved.ready === 'boolean' && savedRoles && savedOverrides
    && Object.values(savedRoles).every((value) => typeof value === 'string')
    && Object.values(savedOverrides).every((value) => typeof value === 'string')
    && (saved.source === 'cli' || saved.source === 'http' || saved.source === 'mixed')
    && typeof saved.notes_en === 'string' && typeof saved.notes_zh === 'string') {
    return { ...(saved as unknown as RecommendedLineup), ready: false };
  }
  const roles = session.workflow.lineup.roles;
  if (!Object.keys(roles).length && session.active_stage === 'setup') return null;
  // A stored run's team has not been rechecked on this visit; require Setup before launching.
  return { ready: false, roles, model_overrides: session.workflow.lineup.model_overrides, source: 'mixed', notes_en: '', notes_zh: '' };
}

function failureDetail(snapshot: LiveRunSnapshot | null): string | null {
  const summary = snapshot?.run?.summary;
  const errors = snapshot?.tasks.map((task) => typeof task.last_error === 'string' ? task.last_error : '').filter(Boolean) ?? [];
  return [typeof summary === 'string' ? summary : '', ...errors].filter(Boolean).join('\n') || null;
}

const noop = () => {};

function GuidedLiveCanvas({
  snapshot,
  locale,
  onTaskClick,
}: {
  snapshot: LiveRunSnapshot;
  locale: Locale;
  onTaskClick(taskId: string): void;
}) {
  const view = useMemo(() => {
    const { graph, nodeStates, activeEdgeIds, traversedEdgeIds } = buildLiveRunGraph(snapshot, locale);
    const projected = projectLiveRunCanvas(graph);
    return { ...graphToFlow(projected.graph, nodeStates), activeEdgeIds, traversedEdgeIds };
  }, [snapshot, locale]);
  const [nodes, setNodes, onNodesChange] = useNodesState<BatonFlowNode>(view.nodes);

  useEffect(() => {
    setNodes(view.nodes);
  }, [setNodes, view.nodes]);

  const handleNodeClick = useCallback((nodeId: string) => {
    const taskId = taskIdFromNodeId(nodeId);
    if (taskId) onTaskClick(taskId);
  }, [onTaskClick]);

  return (
    <CanvasWorkspace
      nodes={nodes}
      edges={view.edges}
      onNodesChange={onNodesChange}
      onEdgesChange={noop}
      onConnect={noop}
      onSelectionChange={noop}
      activeEdgeIds={view.activeEdgeIds}
      traversedEdgeIds={view.traversedEdgeIds}
      onNodeClick={handleNodeClick}
    />
  );
}

export interface GuidedWorkbenchProps {
  locale: Locale;
  /** The app's local API client; every guided step talks to the Studio server through it. */
  client: BatonApiClient;
  /** Resolved client mode (`null` while `/api/health` initialization is still running). */
  apiMode?: ApiMode | null;
  /** The app's live run snapshot (SSE-driven). Only the run launched here is shown. */
  liveSnapshot: LiveRunSnapshot | null;
  /** Asks the app to follow (and refetch) this run: after launch and after a sign-off action. */
  onFollowRun(runId: string): void;
}

/** Guided Mode shell: Workspace → Blueprint → Build (live canvas) → Sign-Off. */
export function useGuidedWorkbenchView({ locale, client, apiMode, liveSnapshot, onFollowRun }: GuidedWorkbenchProps) {
  const copy = MESSAGES[locale].guided;
  const [step, setStep] = useState<GuidedStep>('setup');
  const [lineup, setLineup] = useState<RecommendedLineup | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [resolvedDecisionKey, setResolvedDecisionKey] = useState<string | null>(null);
  const [lastSignOff, setLastSignOff] = useState<{ runId: string; action: FinalizeAction } | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  // The shared client starts in demo mode until App's health check finishes.
  // Recreate the session adapter when that mode changes so an early failed read is retried.
  const sessionApi = useMemo(() => ({
    getGuidedSession: () => client.getGuidedSession(),
    saveGuidedSession: (patch: Parameters<BatonApiClient['saveGuidedSession']>[0]) => client.saveGuidedSession(patch),
    resetGuidedSession: () => client.resetGuidedSession(),
  }), [client, apiMode, sessionAttempt]);
  const guidedSession = useGuidedSession(sessionApi);
  const { session, save: saveSession, flush: flushSession } = guidedSession;
  const restoredSession = useRef(false);
  const stopInFlight = useRef(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [staleRunId, setStaleRunId] = useState<string | null>(null);
  const [settling, setSettling] = useState<StopAndReplanResult | null>(null);
  const [findingCurrent, setFindingCurrent] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [childBusy, setChildBusy] = useState(false);

  const snapshot = runId && runIdOf(liveSnapshot) === runId ? liveSnapshot : null;
  const stale = Boolean(runId && (staleRunId === runId || (snapshot?.run?.status === 'SUPERSEDED' && !stopBusy && !stopPending)));
  // Once a run exists its status decides between Build and Sign-Off (a revision re-enters Build).
  const shownStep: GuidedStep = runId ? (stopBusy || stopPending || stale ? 'live'
    : snapshot?.run?.status === 'PAUSED' && session?.active_stage === 'signoff' ? 'signoff'
      : stepFromRun(snapshot?.run?.status) ?? 'live') : step;

  useEffect(() => {
    if (!session) { restoredSession.current = false; return; }
    if (restoredSession.current) return;
    restoredSession.current = true;
    const restoredLineup = lineupFromSession(session);
    if (restoredLineup) setLineup(restoredLineup);
    if (session.workspace_path) setWorkspacePath(session.workspace_path);
    const pending = pendingReplanFromSession(session);
    if (pending && pending.runId === session.active_run_id) {
      setRunId(pending.runId);
      setStopPending(true);
      if (pending.result) {
        stopInFlight.current = true;
        setStopBusy(true);
        setSettling(pending.result);
      }
      onFollowRun(pending.runId);
    } else if ((session.active_stage === 'build' || session.active_stage === 'signoff') && session.active_run_id) {
      setRunId(session.active_run_id);
      if (session.open_drawer?.run_id === session.active_run_id) setDetailTaskId(session.open_drawer.task_id);
      onFollowRun(session.active_run_id);
    } else {
      setStep(session.active_stage === 'blueprint' && restoredLineup ? 'brainstorm' : 'setup');
    }
  }, [session, onFollowRun, workspaceGeneration]);

  useEffect(() => {
    // Sign-Off shows the folder; Blueprint keeps its conversation per folder.
    if ((shownStep !== 'signoff' && shownStep !== 'brainstorm') || typeof client.getWorkspaceInfo !== 'function') return;
    let active = true;
    client.getWorkspaceInfo()
      .then((info) => {
        if (active && info?.path) setWorkspacePath(info.path);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [client, shownStep]);
  const decision = waitingDecision(snapshot);
  const decisionOpen = Boolean(runId && decision && decision.key !== resolvedDecisionKey && !stale && !stopBusy && !stopPending);
  const replanContext = replanContextFromSession(session);
  const manualRevision = replanContext && asRecord(session?.brainstorm.guided_revision)?.run_id === replanContext.run_id;
  const replanText = replanContext ? formatReplanContext(replanContext) : '';
  const lineageLoader = useCallback((id: string) => loadSignOffLineage(client, id), [client]);
  const brainstormApi = useMemo<GuidedBrainstormApi>(() => ({
    brainstormChat: async (payload) => {
      if (!replanContext) return client.brainstormChat(payload);
      // The brainstorm endpoint updates the draft independently of this hook after every turn.
      const latest = await client.getGuidedSession();
      const context = replanContextFromSession(latest);
      if (!context || context.run_id !== replanContext.run_id || latest.active_run_id !== context.run_id
        || latest.active_stage !== 'blueprint') throw new Error(copy.m3.brainstorm.stale);
      if (asRecord(latest.brainstorm.guided_revision)?.run_id === context.run_id) return client.brainstormChat(payload);
      const failureText = formatReplanContext(context);
      const prior = latest.brainstorm.latest_rfc_draft.trim();
      const requested = [...payload.messages].reverse().find((message) => message.role === 'user')?.content.trim() ?? '';
      if (!failureText) return client.brainstormChat(payload);
      if (prior && requested) {
        return client.brainstormChat({ ...payload, revision_context: { prior_rfc: prior, requested_changes: requested },
          failure_context: failureText, previous_lineup: latest.workflow.lineup });
      }
      // Older sessions may lack an RFC draft; still deliver the failure details with the user's turn.
      return client.brainstormChat({ ...payload, messages: payload.messages.map((message, index) =>
        index === payload.messages.length - 1 && message.role === 'user'
          ? { ...message, content: `${message.content}\n\n${failureText}` } : message) });
    },
    brainstormConfirm: (rfc) => client.brainstormConfirm(rfc),
    startRun: (payload) => {
      if (!replanContext) return client.startRun(payload);
      if (!payload.launch_request_id || !payload.lineup || !payload.rfc_markdown || !payload.mode) {
        throw new ApiError(409, 'The revision launch is missing its saved intent.', { code: 'RUN_STALE' });
      }
      const revisionPayload: LaunchPayload = { launch_request_id: payload.launch_request_id, lineup: payload.lineup,
        rfc_markdown: payload.rfc_markdown, mode: payload.mode, preset: payload.preset };
      return startReplannedRevision(client, replanContext.run_id, revisionPayload).then((run_id) => ({ run_id }));
    },
  }), [client, replanContext, copy.m3.brainstorm.stale]);

  useEffect(() => {
    if (!session || !runId || session.active_run_id !== runId || !snapshot || stopBusy || stopPending || stale) return;
    const desired = decisionOpen && decision ? { run_id: runId, task_id: decision.taskId } : null;
    if (session.open_human_gate?.run_id !== desired?.run_id || session.open_human_gate?.task_id !== desired?.task_id) {
      saveSession({ open_human_gate: desired });
    }
  }, [session, runId, snapshot, stopBusy, stopPending, stale, decisionOpen, decision?.taskId, saveSession]);

  useEffect(() => {
    if (runId && snapshot && session?.active_run_id === runId && session.active_stage === 'build'
      && stepFromRun(snapshot.run?.status) === 'signoff' && !stopBusy && !stopPending && !stale) {
      saveSession({ active_stage: 'signoff' });
    }
  }, [runId, snapshot, session, stopBusy, stopPending, stale, saveSession]);

  // The POST's success context is retained while the authoritative run read catches up.
  useEffect(() => {
    if (!settling || !runId || settling.run_id !== runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const current = await client.getRun(runId);
        if (!active) return;
        if (runIdOf(current) === runId && current.run?.status === 'SUPERSEDED') {
          // The stop endpoint itself moved this session to Blueprint. Never put an old run
          // back in the session if another client has already selected a newer one.
          const latestSession = await client.getGuidedSession();
          if (!active) return;
          if (latestSession.active_run_id !== runId || latestSession.active_stage !== 'blueprint') {
            setStaleRunId(runId);
            setSettling(null);
            setStopBusy(false);
            setStopPending(false);
            stopInFlight.current = false;
            return;
          }
          // Run-keyed values cannot overwrite another run's pending stop or context.
          saveSession({ replan_pending: { [runId]: null },
            brainstorm: { replan_contexts: { [runId]: JSON.stringify(settling) } } });
          const saved = await flushSession();
          if (!active) return;
          if (saved.active_run_id !== runId || saved.active_stage !== 'blueprint') {
            setStaleRunId(runId);
            setSettling(null);
            setStopBusy(false);
            setStopPending(false);
            stopInFlight.current = false;
            return;
          }
          setDetailTaskId(null);
          setRunId(null);
          setStep('brainstorm');
          setSettling(null);
          setStopBusy(false);
          setStopPending(false);
          setStopError(null);
          stopInFlight.current = false;
          return;
        }
        setStopError(null);
      } catch (failure) {
        if (active) setStopError(localizeGuidedError(failure, locale));
      }
      if (active) timer = setTimeout(() => void check(), 1500);
    };
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [settling, runId, client, saveSession, flushSession, locale]);
  const shownIndex = GUIDED_STEPS.indexOf(shownStep);
  const pausedBannerText = snapshot?.run?.status === 'PAUSED'
    ? (lastSignOff?.runId === runId && lastSignOff.action === 'rollback'
      ? copy.m3.rollback.paused
      : lastSignOff?.runId === runId && lastSignOff.action === 'revise'
        ? copy.signOff.revisedDone
        : copy.workbench.pausedBanner)
    : null;

  async function resumeRun() {
    if (!runId || resumeBusy) return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      await client.controlRun(runId, 'resume');
      setLastSignOff(null);
      onFollowRun(runId);
    } catch (failure) {
      if (isStaleRunError(failure)) setStaleRunId(runId);
      else setResumeError(localizeGuidedError(failure, locale));
    } finally {
      setResumeBusy(false);
    }
  }

  async function stopAndReplan(revision?: { prior_rfc: string; requested_changes: string }) {
    if (!runId || stopInFlight.current || stale || !session) return;
    stopInFlight.current = true;
    setConfirmingStop(false);
    setStopBusy(true);
    setStopError(null);
    let requested = false;
    try {
      // Finish queued view writes before the server changes the session stage.
      const latestSession = await client.getGuidedSession();
      if (latestSession.active_run_id !== runId) {
        setStaleRunId(runId);
        setStopBusy(false);
        stopInFlight.current = false;
        return;
      }
      saveSession({ replan_pending: { [runId]: JSON.stringify({ run_id: runId, result: null }) },
        workflow: { guided_pending_launch: null, launch_request_id: null, guided_launch_parent: null },
        ...(revision ? { brainstorm: { guided_revision: JSON.stringify({ run_id: runId, ...revision }),
          guided_input: revision.requested_changes, guided_draft_parent_run_id: null } } : {}) });
      const saved = await flushSession();
      if (saved.active_run_id !== runId) {
        setStaleRunId(runId);
        setStopBusy(false);
        stopInFlight.current = false;
        return;
      }
      setStopPending(true);
      requested = true;
      const result = await client.stopAndReplan(runId);
      if (result.run_id !== runId || result.status !== 'SUPERSEDED') throw new Error('Unexpected stop result');
      saveSession({ replan_pending: { [runId]: JSON.stringify({ run_id: runId, result }) } });
      setSettling(result);
      void flushSession().catch((failure: unknown) => setStopError(localizeGuidedError(failure, locale)));
      onFollowRun(runId);
      return result;
    } catch (failure) {
      if (isStaleRunError(failure)) {
        setStaleRunId(runId);
        setStopPending(false);
        saveSession({ replan_pending: { [runId]: null } });
        void flushSession().catch(() => {});
      }
      else setStopError(localizeGuidedError(failure, locale));
      if (!requested) setStopPending(false);
      stopInFlight.current = false;
      setStopBusy(false);
      if (revision) throw failure;
    }
  }

  async function resetSession() {
    if (resetBusy || childBusy || stopBusy || stopPending) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await guidedSession.reset();
      if (workspacePath && typeof window !== 'undefined') {
        try { clearBrainstorm(window.localStorage, workspacePath); } catch { /* Storage may be unavailable. */ }
      }
      setRunId(null);
      setLineup(null);
      setDetailTaskId(null);
      setResolvedDecisionKey(null);
      setLastSignOff(null);
      setStaleRunId(null);
      setStep('setup');
      setConfirmReset(false);
    } catch (failure) {
      setResetError(localizeGuidedError(failure, locale));
    } finally { setResetBusy(false); }
  }

  function returnToSetup() {
    if (!session) { setStep('setup'); return; }
    saveSession({ active_stage: 'setup' });
    void flushSession().then(() => setStep('setup')).catch(() => {});
  }

  async function followCurrentRun() {
    if (!runId || findingCurrent) return;
    setFindingCurrent(true);
    setStopError(null);
    try {
      const latestSession = await client.getGuidedSession();
      const selected = latestSession.active_run_id;
      let current = selected && selected !== runId ? await client.getRun(selected) : null;
      if (!current || current.run?.status === 'SUPERSEDED') current = await client.getLatestRun();
      const currentId = runIdOf(current);
      if (!currentId || currentId === runId || current.run?.status === 'SUPERSEDED') {
        throw new Error(locale === 'zh' ? '没有找到更新的运行。' : 'No newer run was found.');
      }
      setStaleRunId(null);
      setResolvedDecisionKey(null);
      setDetailTaskId(null);
      setRunId(currentId);
      if (session && latestSession.active_run_id !== currentId) saveSession({ active_run_id: currentId,
        active_stage: stepFromRun(current.run?.status) === 'signoff' ? 'signoff' : 'build',
        open_human_gate: null, open_drawer: null });
      onFollowRun(currentId);
    } catch (failure) {
      setStopError(localizeGuidedError(failure, locale));
    } finally {
      setFindingCurrent(false);
    }
  }

  return (
    <div className="guided-workbench">
      <ol className="guided-workbench__rail" aria-label={copy.workbench.stepsAria}>
        {copy.steps.map(({ title, hint }, index) => {
          const canReturnToSetup = index === 0 && !runId && shownStep === 'brainstorm';
          const content = (
            <>
              <span className="guided-workbench__step-index" aria-hidden="true">{index + 1}</span>
              <span className="guided-workbench__step-text">
                <span className="guided-workbench__step-title">{title}</span>
                <span className="guided-workbench__step-hint">{hint}</span>
              </span>
            </>
          );
          return (
            <li
              key={GUIDED_STEPS[index]}
              className={cn(
                'guided-workbench__step',
                index === shownIndex && 'guided-workbench__step--current',
                index < shownIndex && 'guided-workbench__step--done',
              )}
              aria-current={index === shownIndex ? 'step' : undefined}
            >
              {canReturnToSetup ? (
                <button
                  type="button"
                  className="guided-workbench__step-btn"
                  onClick={returnToSetup}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>

      {session ? <div className="guided-workbench__notice">
        {confirmReset ? <div role="group" aria-label={copy.m3.session.reset}>
          <span>{copy.m3.session.resetConfirm}</span>{' '}
          <button type="button" className="guided-workbench__button" disabled={resetBusy || childBusy || stopBusy || stopPending}
            onClick={() => void resetSession()}>{copy.m3.session.confirmReset}</button>{' '}
          <button type="button" className="guided-workbench__button" disabled={resetBusy}
            onClick={() => setConfirmReset(false)}>{copy.m3.session.cancel}</button>
        </div> : <button type="button" className="guided-workbench__button" disabled={childBusy || stopBusy || stopPending}
          onClick={() => setConfirmReset(true)}>{copy.m3.session.reset}</button>}
        {resetError ? <p className="guided-workbench__error" role="alert">{resetError}</p> : null}
      </div> : null}

      <section className="guided-workbench__body" data-step={shownStep}>
        {session && guidedSession.error ? <div className="guided-workbench__notice" role="alert">
          <span className="guided-workbench__error">{localizeGuidedError(guidedSession.error, locale)}</span>{' '}
          <button type="button" className="guided-workbench__button" onClick={() => void flushSession().catch(() => {})}>
            {copy.m3.session.retrySave}
          </button>
        </div> : null}
        {apiMode !== null && apiMode !== 'demo' && !guidedSession.loading && !session && guidedSession.error ? (
          <div className="guided-workbench__notice" role="alert">
            <span className="guided-workbench__error">{localizeGuidedError(guidedSession.error, locale)}</span>
            <button type="button" className="guided-workbench__button" onClick={() => setSessionAttempt((attempt) => attempt + 1)}>
              {copy.m3.brainstorm.reload}
            </button>
          </div>
        ) : null}
        {shownStep === 'setup' && !session && (guidedSession.loading || apiMode === null) ? (
          <p className="guided-workbench__hint" role="status">{locale === 'zh' ? '正在加载会话……' : 'Loading session…'}</p>
        ) : null}
        {shownStep === 'setup' && (session || apiMode === 'demo' || (apiMode === undefined && !guidedSession.loading)) && (
          <div className="guided-workbench__panel">
            <GuidedSetupStep
              locale={locale}
              api={client}
              apiMode={apiMode}
              guidedSession={session ? guidedSession : undefined}
              onWorkspaceChanged={(info) => {
                restoredSession.current = false;
                setWorkspacePath(info.path);
                setWorkspaceGeneration((generation) => generation + 1);
                setLineup(null);
                setRunId(null);
                setStep('setup');
              }}
              initialRoles={lineup?.roles ?? null}
              initialModelOverrides={lineup?.model_overrides ?? null}
              onReady={(ready) => {
                setLineup(ready);
                // A serialized value replaces the previous selection instead of recursively merging role maps.
                if (session) {
                  saveSession({ active_stage: 'blueprint', workflow: {
                    guided_selected_lineup: JSON.stringify(ready), guided_selected_run_id: session.active_run_id,
                  } });
                  void flushSession().then(() => setStep(nextStep('setup'))).catch(() => {});
                } else setStep(nextStep('setup'));
              }}
            />
          </div>
        )}

        {shownStep === 'brainstorm' && lineup && (
          <div className="guided-workbench__panel">
            <div className="guided-workbench__team-bar">
              <span className="guided-workbench__team-text">
                <strong>{copy.workbench.currentTeamPrefix}</strong> {lineupSummary(lineup, locale)}
              </span>
              <button
                type="button"
                className="guided-workbench__button"
                onClick={returnToSetup}
              >
                {copy.workbench.changeTeam}
              </button>
            </div>
            <GuidedBrainstormStep
              locale={locale}
              lineup={lineup}
              api={brainstormApi}
              services={client}
              guidedSession={guidedSession}
              onBusyChange={setChildBusy}
              allowReplanLaunch
              projectPath={workspacePath}
              onLaunched={(launchedRunId) => {
                setStaleRunId(null);
                setResolvedDecisionKey(null);
                setRunId(launchedRunId);
                setStep(nextStep('brainstorm'));
                onFollowRun(launchedRunId);
              }}
            />
            {replanContext && !manualRevision && (
              <section className="guided-workbench__replan-context" aria-label={copy.m3.failed.details}>
                <h2>{copy.m3.failed.details}</h2>
                <pre>{replanText || copy.m3.failed.noDetails}</pre>
              </section>
            )}
          </div>
        )}

        {shownStep === 'live' && runId && (
          <div className="guided-workbench__live">
            {stale ? (
              <div className="guided-workbench__notice" role="status">
                <span>{locale === 'zh' ? '此运行已被替代或已过期，只能查看。' : 'This run has been superseded or is stale and is read-only.'}</span>
                <button type="button" className="guided-workbench__button" disabled={findingCurrent} onClick={() => void followCurrentRun()}>
                  {locale === 'zh' ? '返回当前运行' : 'Go to current run'}
                </button>
              </div>
            ) : null}
            {snapshot?.run?.status === 'FAILED' && !stale && (!stopPending || stopBusy) ? (
              <GuidedFailedBanner detail={failureDetail(snapshot)} busy={stopBusy}
                onStopAndReplan={session ? () => setConfirmingStop(true) : undefined} />
            ) : null}
            {stopBusy && (snapshot?.run?.status !== 'FAILED' || stopPending) ? (
              <p className="guided-workbench__notice" role="status">{copy.m3.failed.stopping}</p>
            ) : null}
            {stopPending && !stopBusy && !stale ? (
              <div className="guided-workbench__notice" role="status">
                <span>{locale === 'zh' ? '停止请求已提交，需确认运行完成停止后才能重新规划。' : 'The stop was requested. Confirm it has settled before replanning.'}</span>
                <button type="button" className="guided-workbench__button" onClick={() => void stopAndReplan()}>
                  {locale === 'zh' ? '重试确认停止' : 'Retry stop'}
                </button>
              </div>
            ) : null}
            {confirmingStop && !stale && !stopBusy ? (
              <div className="guided-workbench__notice" role="group" aria-label={copy.m3.failed.replan}>
                <span>{locale === 'zh' ? '确认停止此运行并返回蓝图？' : 'Stop this run and return to the blueprint?'}</span>
                <button type="button" className="guided-workbench__button guided-workbench__button--primary" onClick={() => void stopAndReplan()}>
                  {copy.m3.failed.replan}
                </button>
                <button type="button" className="guided-workbench__button" onClick={() => setConfirmingStop(false)}>
                  {copy.m3.lineup.cancel}
                </button>
              </div>
            ) : null}
            {stopError ? <p className="guided-workbench__error" role="alert">{stopError}</p> : null}
            {pausedBannerText && !stale && !stopBusy && !stopPending ? (
              <div className="guided-workbench__paused" role="status">
                <span>{pausedBannerText}</span>
                <div className="guided-workbench__paused-actions">
                  <button
                    type="button"
                    className="guided-workbench__button guided-workbench__button--primary"
                    disabled={resumeBusy}
                    onClick={() => void resumeRun()}
                  >
                    {copy.workbench.resumeRun}
                  </button>
                  <button
                    type="button"
                    className="guided-workbench__button"
                    disabled={resumeBusy}
                    onClick={() => { setResumeError(null); setConfirmingStop(true); }}
                  >
                    {copy.workbench.newBlueprint}
                  </button>
                </div>
                {resumeError ? <p className="guided-workbench__error" role="alert">{resumeError}</p> : null}
              </div>
            ) : null}
            <p className="guided-workbench__hint">{snapshot ? copy.workbench.nodeHint : copy.workbench.waitingForRun}</p>
            {snapshot && (
              <div className={cn('guided-workbench__live-main', decisionOpen && 'guided-workbench__live-main--decision')}>
                <div className="guided-workbench__canvas">
                  <GuidedLiveCanvas snapshot={snapshot} locale={locale} onTaskClick={(taskId) => {
                    setDetailTaskId(taskId);
                    if (session?.active_run_id === runId) saveSession({ open_drawer: { run_id: runId, task_id: taskId } });
                  }} />
                </div>
                {runId && decision && decisionOpen && (
                  <GuidedDecisionDrawer
                    key={decision.key}
                    open
                    runId={runId}
                    taskId={decision.taskId}
                    question={decision.question}
                    options={decision.options}
                    locale={locale}
                    resolver={({ runId: id, taskId, choice, note }) => client.resolveRunTask(id, { taskId, choice, note })}
                    onStale={() => setStaleRunId(runId)}
                    onResolved={() => {
                      setResolvedDecisionKey(decision.key);
                      if (session?.active_run_id === runId) saveSession({ open_human_gate: null });
                      onFollowRun(runId);
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {shownStep === 'signoff' && runId && snapshot && (
          <div className="guided-workbench__panel">
            <GuidedSignOffPanel
              runId={runId}
              runStatus={typeof snapshot.run?.status === 'string' ? snapshot.run.status : undefined}
              summary={{
                ...signOffSummaryFromSnapshot(snapshot),
                totalCostUsd: snapshot.telemetry?.billing?.total_cost_usd ?? null,
                workspacePath,
                deliverables: signOffDeliverablesFromSnapshot(snapshot),
              }}
              locale={locale}
              priorRfc={session?.brainstorm.latest_rfc_draft}
              lineageLoader={lineageLoader}
              rollbacker={(id, mode) => client.rollbackRun(id, mode)}
              onBusyChange={setChildBusy}
              onRequestRevision={async ({ runId: id, prior_rfc, requested_changes }) => {
                if (id !== runId) throw new Error(copy.m3.errors.RUN_STALE);
                const result = await stopAndReplan({ prior_rfc, requested_changes });
                if (!result) throw new Error(copy.m3.errors.RUN_STALE);
                return result;
              }}
              finalizer={async (id, payload) => {
                try { return await client.finalizeRun(id, payload); }
                catch (failure) { if (isStaleRunError(failure)) setStaleRunId(id); throw failure; }
              }}
              reportFetcher={typeof client.getRunReport === 'function' ? (id, lang) => client.getRunReport(id, lang) : undefined}
              onOpenPath={typeof client.openWorkspacePath === 'function' ? (opts) => client.openWorkspacePath(opts) : undefined}
              onFinalized={(result) => {
                setLastSignOff({ runId, action: result.action });
                onFollowRun(runId);
              }}
            />
            {snapshot.run?.status === 'PAUSED' && !stale && !stopBusy && !stopPending ? (
              <div className="guided-workbench__paused" role="status">
                <span>{pausedBannerText}</span>
                <div className="guided-workbench__paused-actions">
                  <button type="button" className="guided-workbench__button guided-workbench__button--primary"
                    disabled={resumeBusy || childBusy} onClick={() => void resumeRun()}>{copy.workbench.resumeRun}</button>
                  <button type="button" className="guided-workbench__button" disabled={resumeBusy || childBusy}
                    onClick={() => setConfirmingStop(true)}>{copy.m3.failed.replan}</button>
                </div>
                {confirmingStop ? <div role="group" aria-label={copy.m3.failed.replan}>
                  <span>{locale === 'zh' ? '确认停止此运行并返回蓝图？' : 'Stop this run and return to the blueprint?'}</span>{' '}
                  <button type="button" className="guided-workbench__button" onClick={() => void stopAndReplan()}>{copy.m3.failed.replan}</button>{' '}
                  <button type="button" className="guided-workbench__button" onClick={() => setConfirmingStop(false)}>{copy.m3.lineup.cancel}</button>
                </div> : null}
                {resumeError ? <p className="guided-workbench__error" role="alert">{resumeError}</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {runId && (
        <NodeDetailDrawer
          runId={runId}
          taskId={detailTaskId}
          locale={locale}
          fetcher={(id, taskId) => client.getRunTaskDetail(id, taskId, locale)}
          onClose={() => {
            setDetailTaskId(null);
            if (session?.active_run_id === runId) saveSession({ open_drawer: null });
          }}
        />
      )}
    </div>
  );
}

export function GuidedWorkbench(props: GuidedWorkbenchProps) {
  return useGuidedWorkbenchView(props);
}
