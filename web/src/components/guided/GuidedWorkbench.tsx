import './GuidedWorkbench.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNodesState } from '@xyflow/react';
import type { BatonApiClient, FinalizeAction, RecommendedLineup } from '../../api/client';
import { graphToFlow } from '../../engine/flowAdapter';
import { buildLiveRunGraph, projectLiveRunCanvas } from '../../engine/liveRunGraph';
import { MESSAGES, type Locale } from '../../i18n/messages';
import type { LiveRunSnapshot } from '../../types/graph';
import { cn } from '../../lib/utils';
import { CanvasWorkspace } from '../CanvasWorkspace';
import type { BatonFlowNode } from '../nodes/BatonNode';
import { GuidedBrainstormStep } from './GuidedBrainstormStep';
import { GuidedDecisionModal, optionsFromEvent, type GuidedDecisionOption } from './GuidedDecisionModal';
import { GuidedSetupStep } from './GuidedSetupStep';
import { GuidedSignOffPanel, type SignOffSummary } from './GuidedSignOffPanel';
import { localizeGuidedError } from './guidedErrors';
import { NodeDetailDrawer } from './NodeDetailDrawer';

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

function runIdOf(snapshot: LiveRunSnapshot | null): string | null {
  const id = snapshot?.run?.id;
  return typeof id === 'string' ? id : null;
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
  /** The app's live run snapshot (SSE-driven). Only the run launched here is shown. */
  liveSnapshot: LiveRunSnapshot | null;
  /** Asks the app to follow (and refetch) this run: after launch and after a sign-off action. */
  onFollowRun(runId: string): void;
}

/** Guided Mode shell: Workspace → Blueprint → Build (live canvas) → Sign-Off. */
export function GuidedWorkbench({ locale, client, liveSnapshot, onFollowRun }: GuidedWorkbenchProps) {
  const copy = MESSAGES[locale].guided;
  const [step, setStep] = useState<GuidedStep>('setup');
  const [lineup, setLineup] = useState<RecommendedLineup | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [resolvedDecisionKey, setResolvedDecisionKey] = useState<string | null>(null);
  const [lastSignOff, setLastSignOff] = useState<{ runId: string; action: FinalizeAction } | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const snapshot = runId && runIdOf(liveSnapshot) === runId ? liveSnapshot : null;
  // Once a run exists its status decides between Build and Sign-Off (a revision re-enters Build).
  const shownStep: GuidedStep = runId ? stepFromRun(snapshot?.run?.status) ?? 'live' : step;
  const decision = waitingDecision(snapshot);
  const shownIndex = GUIDED_STEPS.indexOf(shownStep);
  const pausedBannerText = snapshot?.run?.status === 'PAUSED'
    ? (lastSignOff?.runId === runId && lastSignOff.action === 'rollback'
      ? copy.signOff.rolledBackDone
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
      setResumeError(localizeGuidedError(failure, locale));
    } finally {
      setResumeBusy(false);
    }
  }

  return (
    <div className="guided-workbench">
      <ol className="guided-workbench__rail" aria-label={copy.workbench.stepsAria}>
        {copy.steps.map(({ title, hint }, index) => (
          <li
            key={GUIDED_STEPS[index]}
            className={cn(
              'guided-workbench__step',
              index === shownIndex && 'guided-workbench__step--current',
              index < shownIndex && 'guided-workbench__step--done',
            )}
            aria-current={index === shownIndex ? 'step' : undefined}
          >
            <span className="guided-workbench__step-index" aria-hidden="true">{index + 1}</span>
            <span className="guided-workbench__step-text">
              <span className="guided-workbench__step-title">{title}</span>
              <span className="guided-workbench__step-hint">{hint}</span>
            </span>
          </li>
        ))}
      </ol>

      <section className="guided-workbench__body" data-step={shownStep}>
        {shownStep === 'setup' && (
          <div className="guided-workbench__panel">
            <GuidedSetupStep
              locale={locale}
              api={client}
              onReady={(ready) => {
                setLineup(ready);
                setStep(nextStep('setup'));
              }}
            />
          </div>
        )}

        {shownStep === 'brainstorm' && lineup && (
          <div className="guided-workbench__panel">
            <GuidedBrainstormStep
              locale={locale}
              lineup={lineup}
              api={client}
              onLaunched={(launchedRunId) => {
                setRunId(launchedRunId);
                setStep(nextStep('brainstorm'));
                onFollowRun(launchedRunId);
              }}
            />
          </div>
        )}

        {shownStep === 'live' && runId && (
          <div className="guided-workbench__live">
            {pausedBannerText ? (
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
                    onClick={() => {
                      setLastSignOff(null);
                      setResumeError(null);
                      setRunId(null);
                      setStep('brainstorm');
                    }}
                  >
                    {copy.workbench.newBlueprint}
                  </button>
                </div>
                {resumeError ? <p className="guided-workbench__error" role="alert">{resumeError}</p> : null}
              </div>
            ) : null}
            <p className="guided-workbench__hint">{snapshot ? copy.workbench.nodeHint : copy.workbench.waitingForRun}</p>
            {snapshot && (
              <div className="guided-workbench__canvas">
                <GuidedLiveCanvas snapshot={snapshot} locale={locale} onTaskClick={setDetailTaskId} />
              </div>
            )}
          </div>
        )}

        {shownStep === 'signoff' && runId && snapshot && (
          <div className="guided-workbench__panel">
            <GuidedSignOffPanel
              runId={runId}
              runStatus={typeof snapshot.run?.status === 'string' ? snapshot.run.status : undefined}
              summary={signOffSummaryFromSnapshot(snapshot)}
              locale={locale}
              finalizer={(id, payload) => client.finalizeRun(id, payload)}
              onFinalized={(result) => {
                setLastSignOff({ runId, action: result.action });
                onFollowRun(runId);
              }}
            />
          </div>
        )}
      </section>

      {runId && (
        <NodeDetailDrawer
          runId={runId}
          taskId={detailTaskId}
          locale={locale}
          fetcher={(id, taskId) => client.getRunTaskDetail(id, taskId, locale)}
          onClose={() => setDetailTaskId(null)}
        />
      )}

      {runId && decision && (
        <GuidedDecisionModal
          key={decision.key}
          open={decision.key !== resolvedDecisionKey}
          runId={runId}
          taskId={decision.taskId}
          question={decision.question}
          options={decision.options}
          locale={locale}
          resolver={({ runId: id, taskId, choice, note }) => client.resolveRunTask(id, { taskId, choice, note })}
          onResolved={() => setResolvedDecisionKey(decision.key)}
        />
      )}
    </div>
  );
}
