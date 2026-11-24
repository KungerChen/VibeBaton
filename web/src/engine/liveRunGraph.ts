import { MESSAGES, type Locale } from '../i18n/messages';
import type {
  ExecutionState,
  LiveRunSnapshot,
  NodeTimingConfig,
  StageTelemetry,
  TaskTiming,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '../types/graph';
import { computeLiveSeconds } from './liveClock';

export const LIVE_GRAPH_ID = '__live_run__';

/** Stage id the backend reports for the panel-mode specialist consultation. */
export const PANEL_STAGE = '00_PANEL';
/** Live-graph node ids for panel-mode runs; specialists append their member id. */
export const PANEL_SPECIALIST_NODE_PREFIX = 'live-panel-specialist-';
export const PANEL_SYNTHESIZER_NODE_ID = 'live-panel-synthesizer';

const PANEL_EVENT_KINDS = new Set(['panel_started', 'panel_member_completed', 'panel_synthesized']);

export interface LiveRunGraphView {
  graph: WorkflowGraph;
  nodeStates: Record<string, ExecutionState>;
  activeEdgeIds: Set<string>;
  traversedEdgeIds: Set<string>;
}

/** Keep snapshot timings out of the canvas layout and the editable recipe. */
export function projectLiveRunCanvas(graph: WorkflowGraph) {
  const nodeTimings = new Map<string, NodeTimingConfig>();
  const nodes = graph.nodes.map((node) => {
    const { duration_sec, started_at, is_timing_active, ...config } = node.config ?? {};
    if (duration_sec === undefined && started_at === undefined && is_timing_active === undefined) return node;

    nodeTimings.set(node.id, { duration_sec, started_at, is_timing_active });
    return { ...node, config: Object.keys(config).length > 0 ? config : undefined };
  });
  const signature = JSON.stringify({
    name: graph.name,
    nodes: nodes.map(({ id, label, role, config }) => [id, label, role, config]),
    edges: graph.edges.map(({ id }) => id),
  });
  return { graph: { ...graph, nodes }, signature, nodeTimings };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readEventPayload(event: Record<string, unknown>): Record<string, unknown> {
  const raw = event.payload_json;
  if (typeof raw !== 'string') return asRecord(raw);
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseProviderModel(target: string): { provider?: string; model?: string } {
  const clean = target.trim();
  if (!clean) return {};
  const slash = clean.indexOf('/');
  if (slash > 0) {
    return {
      provider: clean.slice(0, slash).trim(),
      model: clean.slice(slash + 1).trim(),
    };
  }
  const colon = clean.indexOf(':');
  if (colon > 0) {
    return {
      provider: clean.slice(0, colon).trim(),
      model: clean.slice(colon + 1).trim(),
    };
  }
  return { model: clean };
}

function truncateLabel(text: string, maxLen = 42): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

export function mapRunStatusToExecutionState(status: unknown): ExecutionState {
  const upper = asText(status).toUpperCase();
  if (upper === 'PASSED' || upper === 'COMPLETED' || upper === 'APPROVED') return 'passed';
  if (
    upper === 'RUNNING'
    || upper === 'PLANNING'
    || upper === 'IN_PROGRESS'
    || upper === 'REVIEWING'
    || upper === 'READY_FOR_FINAL_GATE'
    || upper === 'WAITING_HUMAN'
  ) {
    return 'active';
  }
  if (upper === 'RETRYING' || upper === 'FIXING' || upper === 'NEEDS_FIX' || upper === 'PAUSED') {
    return 'retrying';
  }
  if (upper === 'ESCALATED') return 'escalated';
  if (upper === 'FAILED' || upper === 'REJECTED' || upper === 'CANCELLED') return 'failed';
  return 'idle';
}

function extractActorAssignments(snapshot: LiveRunSnapshot): {
  byTaskId: Map<string, { provider?: string; model?: string }>;
  byRole: Map<string, { provider?: string; model?: string }>;
} {
  const byTaskId = new Map<string, { provider?: string; model?: string }>();
  const byRole = new Map<string, { provider?: string; model?: string }>();

  for (const event of snapshot.events) {
    const kind = asText(event.kind);
    const taskId = asText(event.task_id);
    const msg = asText(event.message);
    if (kind === 'role_invoked' || kind === 'role_completed') {
      const match = /^(?:Invoking|Completed)\s+([a-z0-9_]+)\s*\(([^)]+)\)/i.exec(msg);
      if (match) {
        const [, role, target] = match;
        const parsed = parseProviderModel(target);
        if (parsed.provider || parsed.model) {
          byRole.set(role, parsed);
          if (taskId) byTaskId.set(taskId, parsed);
        }
      }
    } else if ((kind === 'task_model_allocated' || kind === 'task_step_up') && msg.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(msg) as Record<string, unknown>;
        const target = asText(parsedJson.assigned_model ?? parsedJson.target ?? parsedJson.to_target);
        const provider = asText(parsedJson.provider);
        const model = asText(parsedJson.model);
        const parsed = target ? parseProviderModel(target) : { provider: provider || undefined, model: model || undefined };
        if ((parsed.provider || parsed.model) && taskId) {
          byTaskId.set(taskId, parsed);
        }
      } catch {
        // Ignore unparseable audit JSON messages.
      }
    }
  }

  for (const modelRow of snapshot.telemetry?.models ?? []) {
    if (!byRole.has(modelRow.role) && (modelRow.provider || modelRow.model)) {
      byRole.set(modelRow.role, {
        provider: modelRow.provider || undefined,
        model: modelRow.model || undefined,
      });
    }
  }

  return { byTaskId, byRole };
}

/** Static renders may pass nowEpochSec to advance active durations past telemetry.server_now. */
export function buildLiveRunGraph(
  snapshot: LiveRunSnapshot,
  locale: Locale,
  nowEpochSec?: number,
): LiveRunGraphView {
  const run = snapshot.run ?? {};
  const runId = asText(run.id) || 'run-live';
  const runStatus = asText(run.status).toUpperCase();
  const { byTaskId, byRole } = extractActorAssignments(snapshot);
  const { telemetry } = snapshot;
  const stages = telemetry?.stages ?? [];

  function nodeConfig(
    assignment: { provider?: string; model?: string } | undefined,
    timing: StageTelemetry | TaskTiming | undefined,
  ): WorkflowNode['config'] {
    const config = assignment?.provider || assignment?.model
      ? { provider: assignment.provider, model: assignment.model }
      : undefined;
    if (!timing) return config;

    const baseSec = 'wall_sec' in timing ? timing.wall_sec : timing.duration_sec;
    const { started_at, is_active } = timing;
    // The backend durations can include in-flight work up to the snapshot time.
    const snapshotAnchor = started_at != null && Number.isFinite(started_at)
      ? telemetry?.server_now
      : undefined;
    const durationSec = nowEpochSec === undefined
      ? baseSec
      : computeLiveSeconds(baseSec, snapshotAnchor, is_active, nowEpochSec);
    return { ...config, duration_sec: durationSec, started_at, is_timing_active: is_active };
  }

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const nodeStates: Record<string, ExecutionState> = {};

  const plannerId = 'live-planner';

  const panelEvents = snapshot.events.filter((event) => PANEL_EVENT_KINDS.has(asText(event.kind)));
  const panelStage = stages.find((stage) => stage.id === PANEL_STAGE);
  if (panelStage || panelEvents.length > 0) {
    const panelLabels = MESSAGES[locale].inspector.liveGraphNodes;
    const members = new Map<string, {
      id: string;
      perspective: string;
      ok: boolean;
      provider?: string;
      model?: string;
    }>();
    for (const event of panelEvents) {
      if (asText(event.kind) !== 'panel_member_completed') continue;
      const payload = readEventPayload(event);
      const memberId = asText(payload.member_id);
      if (!memberId) continue;
      members.set(memberId, {
        id: memberId,
        perspective: asText(payload.perspective) || memberId,
        ok: payload.ok === true,
        provider: asText(payload.provider) || undefined,
        model: asText(payload.model) || undefined,
      });
    }

    const memberList = [...members.values()];
    memberList.forEach((member, index) => {
      const nodeId = `${PANEL_SPECIALIST_NODE_PREFIX}${member.id}`;
      nodes.push({
        id: nodeId,
        type: 'worker_node',
        label: truncateLabel(`${panelLabels.specialist} · ${member.perspective}`),
        position: { x: -600, y: 120 + (index - (memberList.length - 1) / 2) * 150 },
        config: nodeConfig({ provider: member.provider, model: member.model }, undefined),
      });
      nodeStates[nodeId] = member.ok ? 'passed' : 'failed';
      edges.push({
        id: `live-edge-${nodeId}-to-${PANEL_SYNTHESIZER_NODE_ID}`,
        source: nodeId,
        target: PANEL_SYNTHESIZER_NODE_ID,
        sourceHandle: 'out',
        targetHandle: 'in',
      });
    });

    const synthesized = panelEvents.some((event) => asText(event.kind) === 'panel_synthesized');
    nodes.push({
      id: PANEL_SYNTHESIZER_NODE_ID,
      type: 'merge_node',
      label: panelLabels.synthesizer,
      position: { x: -300, y: 120 },
      config: nodeConfig(undefined, panelStage),
    });
    nodeStates[PANEL_SYNTHESIZER_NODE_ID] = synthesized
      ? 'passed'
      : panelStage
        ? mapRunStatusToExecutionState(panelStage.status)
        : mapRunStatusToExecutionState(runStatus);
    edges.push({
      id: `live-edge-${PANEL_SYNTHESIZER_NODE_ID}-to-${plannerId}`,
      source: PANEL_SYNTHESIZER_NODE_ID,
      target: plannerId,
      sourceHandle: 'out',
      targetHandle: 'in',
    });
  }

  const hasPlan = snapshot.milestones.length > 0
    || snapshot.tasks.length > 0
    || snapshot.events.some((event) => {
      const k = asText(event.kind);
      return k === 'plan_generated' || k === 'plan_registered';
    });
  const plannerAssign = byRole.get('tactical_planner');
  const plannerTiming = stages.find((stage) => stage.kind === 'planning' && stage.id === 'PLANNING');
  nodes.push({
    id: plannerId,
    type: 'planner_node',
    label: locale === 'en' ? '01_PLAN · Tactical Plan' : '01_PLAN · 战术规划',
    role: 'tactical_planner',
    position: { x: 0, y: 120 },
    config: nodeConfig(plannerAssign, plannerTiming),
  });
  nodeStates[plannerId] = hasPlan
    ? 'passed'
    : runStatus === 'PLANNING' || runStatus === 'RUNNING'
      ? 'active'
      : mapRunStatusToExecutionState(runStatus);

  const rawMilestones = snapshot.milestones.length > 0
    ? snapshot.milestones
    : snapshot.tasks.length > 0
      ? [{ id: 'M1', title: locale === 'en' ? 'Execution Stage' : '执行阶段', status: runStatus }]
      : [];

  const milestoneIds = new Set(rawMilestones.map((m, idx) => asText(m.id) || `M${idx + 1}`));
  const fallbackMilestoneId = rawMilestones.length > 0
    ? asText(rawMilestones[rawMilestones.length - 1].id) || `M${rawMilestones.length}`
    : '';
  const tasksByMilestone = new Map<string, Record<string, unknown>[]>();
  for (const msId of milestoneIds) tasksByMilestone.set(msId, []);

  for (const task of snapshot.tasks) {
    const msId = asText(task.milestone_id);
    const bucketId = milestoneIds.has(msId) ? msId : fallbackMilestoneId;
    if (bucketId) {
      tasksByMilestone.get(bucketId)?.push(task);
    }
  }

  let prevReviewerId = plannerId;
  let prevSourceHandle = 'dag';

  rawMilestones.forEach((ms, msIndex) => {
    const msId = asText(ms.id) || `M${msIndex + 1}`;
    const msTitle = asText(ms.title) || msId;
    const msTasks = tasksByMilestone.get(msId) ?? [];
    const baseX = 340 + msIndex * 600;
    const reviewerId = `live-ms-${msId}`;

    msTasks.forEach((task, taskIndex) => {
      const taskId = asText(task.id) || `${msId}-T${taskIndex + 1}`;
      const taskTitle = asText(task.title) || taskId;
      const role = asText(task.current_role) || asText(task.assignee_role) || 'bulk_worker';
      const assignedTarget = asText(task.assigned_model);
      const taskAssign = assignedTarget
        ? parseProviderModel(assignedTarget)
        : byTaskId.get(taskId) ?? byRole.get(role);

      const nodeId = `live-task-${taskId}`;
      nodes.push({
        id: nodeId,
        type: 'worker_node',
        label: truncateLabel(`${taskId} · ${taskTitle}`, 40),
        role,
        position: { x: baseX, y: taskIndex * 150 },
        config: nodeConfig(taskAssign, telemetry?.task_timings?.[taskId]),
      });
      nodeStates[nodeId] = mapRunStatusToExecutionState(task.status);

      edges.push({
        id: `live-edge-${prevReviewerId}-to-${nodeId}`,
        source: prevReviewerId,
        target: nodeId,
        sourceHandle: prevSourceHandle,
        targetHandle: 'in',
      });
      edges.push({
        id: `live-edge-${nodeId}-to-${reviewerId}`,
        source: nodeId,
        target: reviewerId,
        sourceHandle: 'out',
        targetHandle: 'in',
      });
    });

    if (msTasks.length === 0) {
      edges.push({
        id: `live-edge-${prevReviewerId}-to-${reviewerId}`,
        source: prevReviewerId,
        target: reviewerId,
        sourceHandle: prevSourceHandle,
        targetHandle: 'in',
      });
    }

    const reviewerAssign = byRole.get('milestone_reviewer');
    const reviewerTiming = stages.find((stage) => stage.kind === 'milestone' && stage.id === msId);
    const centerY = msTasks.length > 0 ? ((msTasks.length - 1) * 150) / 2 : 120;
    nodes.push({
      id: reviewerId,
      type: 'reviewer_node',
      label: truncateLabel(`${msId} · ${msTitle}`, 38),
      role: 'milestone_reviewer',
      position: { x: baseX + 300, y: centerY },
      config: nodeConfig(reviewerAssign, reviewerTiming),
    });
    nodeStates[reviewerId] = mapRunStatusToExecutionState(ms.status);

    prevReviewerId = reviewerId;
    prevSourceHandle = 'approve';
  });

  const gateId = 'live-final-gate';
  const gateAssign = byRole.get('brainstorm_and_final_gate') ?? { provider: 'host_native', model: 'L0' };
  nodes.push({
    id: gateId,
    type: 'human_gate_node',
    label: locale === 'en' ? 'L0 Final Gate' : 'L0 终审合入',
    role: 'brainstorm_and_final_gate',
    position: { x: 340 + rawMilestones.length * 600, y: 120 },
    config: { provider: gateAssign.provider, model: gateAssign.model },
  });
  nodeStates[gateId] = runStatus === 'COMPLETED'
    ? 'passed'
    : runStatus === 'READY_FOR_FINAL_GATE' || runStatus === 'WAITING_HUMAN'
      ? 'active'
      : runStatus === 'REJECTED' || runStatus === 'FAILED'
        ? 'failed'
        : runStatus === 'PAUSED'
          ? 'retrying'
          : 'idle';

  edges.push({
    id: `live-edge-${prevReviewerId}-to-${gateId}`,
    source: prevReviewerId,
    target: gateId,
    sourceHandle: prevSourceHandle,
    targetHandle: 'in',
  });

  const activeEdgeIds = new Set<string>();
  const traversedEdgeIds = new Set<string>();
  for (const edge of edges) {
    const src = nodeStates[edge.source] ?? 'idle';
    const tgt = nodeStates[edge.target] ?? 'idle';
    if (src === 'passed' && tgt !== 'idle') {
      traversedEdgeIds.add(edge.id);
    }
    if ((src === 'active' || tgt === 'active' || tgt === 'retrying') && src !== 'idle') {
      activeEdgeIds.add(edge.id);
    }
  }

  return {
    graph: {
      schema_version: '1.0',
      id: LIVE_GRAPH_ID,
      name: locale === 'en' ? `Live Run · ${runId}` : `实时运行 · ${runId}`,
      difficulty: 'live',
      description: locale === 'en'
        ? `Live execution workflow for ${runId} (${runStatus || 'UNKNOWN'}).`
        : `运行 ${runId} 的实时执行工作流图（状态：${runStatus || 'UNKNOWN'}）。`,
      nodes,
      edges,
    },
    nodeStates,
    activeEdgeIds,
    traversedEdgeIds,
  };
}

export function deriveLiveRoleStates(
  graph: WorkflowGraph,
  snapshot: LiveRunSnapshot | null | undefined,
): Record<string, ExecutionState> {
  const states: Record<string, ExecutionState> = Object.fromEntries(
    graph.nodes.map(({ id }) => [id, 'idle'] as const),
  );
  const run = snapshot?.run;
  if (!snapshot || !run) return states;

  const runStatus = asText(run.status).toUpperCase();
  const isLive = runStatus === 'PLANNING'
    || runStatus === 'RUNNING'
    || runStatus === 'PAUSED'
    || runStatus === 'WAITING_HUMAN'
    || runStatus === 'READY_FOR_FINAL_GATE';
  if (!isLive) return states;

  const activeRoles = new Set<string>();
  const passedRoles = new Set<string>();
  const retryingRoles = new Set<string>();
  let hasActiveTask = false;
  let hasPassedTask = false;

  if (runStatus === 'PLANNING') {
    activeRoles.add('tactical_planner');
  } else if (snapshot.milestones.length > 0 || snapshot.tasks.length > 0) {
    passedRoles.add('tactical_planner');
  }

  for (const task of snapshot.tasks) {
    const role = asText(task.current_role) || asText(task.assignee_role);
    const taskState = mapRunStatusToExecutionState(task.status);
    if (taskState === 'active') {
      hasActiveTask = true;
      if (role) activeRoles.add(role);
    } else if (taskState === 'retrying') {
      hasActiveTask = true;
      if (role) retryingRoles.add(role);
    } else if (taskState === 'passed') {
      hasPassedTask = true;
      if (role) passedRoles.add(role);
    }
  }

  for (const ms of snapshot.milestones) {
    const msState = mapRunStatusToExecutionState(ms.status);
    if (msState === 'active') activeRoles.add('milestone_reviewer');
    else if (msState === 'passed') passedRoles.add('milestone_reviewer');
  }

  if (runStatus === 'READY_FOR_FINAL_GATE' || runStatus === 'WAITING_HUMAN') {
    activeRoles.add('brainstorm_and_final_gate');
  }

  for (const node of graph.nodes) {
    const role = asText(node.role);
    if (role && activeRoles.has(role)) {
      states[node.id] = 'active';
    } else if (role && retryingRoles.has(role)) {
      states[node.id] = 'retrying';
    } else if (role && passedRoles.has(role)) {
      states[node.id] = 'passed';
    } else if (node.type === 'human_gate_node' && (runStatus === 'READY_FOR_FINAL_GATE' || runStatus === 'WAITING_HUMAN')) {
      states[node.id] = 'active';
    } else if (node.type === 'gate_node' && hasPassedTask && !hasActiveTask) {
      states[node.id] = 'passed';
    } else if (node.type === 'gate_node' && hasActiveTask) {
      states[node.id] = 'active';
    } else if (node.type === 'merge_node' && (runStatus === 'READY_FOR_FINAL_GATE' || runStatus === 'WAITING_HUMAN')) {
      states[node.id] = 'passed';
    }
  }

  return states;
}
