import type { Locale } from '../i18n/messages';
import type { ExecutionState, LiveRunSnapshot, WorkflowEdge, WorkflowGraph, WorkflowNode } from '../types/graph';

export const LIVE_GRAPH_ID = '__live_run__';

export interface LiveRunGraphView {
  graph: WorkflowGraph;
  nodeStates: Record<string, ExecutionState>;
  activeEdgeIds: Set<string>;
  traversedEdgeIds: Set<string>;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

export function formatDurationSec(sec: number, locale: Locale): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  if (safe === 0) return locale === 'en' ? '0s' : '0秒';
  if (safe < 60) {
    return locale === 'en' ? `${safe.toFixed(1)}s` : `${safe.toFixed(1)}秒`;
  }
  if (safe < 3600) {
    let mins = Math.floor(safe / 60);
    let secs = Math.round(safe % 60);
    if (secs === 60) {
      mins += 1;
      secs = 0;
    }
    if (mins === 60) {
      return locale === 'en' ? '1h 0m' : '1时0分';
    }
    return locale === 'en' ? `${mins}m ${secs}s` : `${mins}分${secs}秒`;
  }
  const totalMins = Math.round(safe / 60);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return locale === 'en' ? `${hours}h ${mins}m` : `${hours}时${mins}分`;
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

export function buildLiveRunGraph(snapshot: LiveRunSnapshot, locale: Locale): LiveRunGraphView {
  const run = snapshot.run ?? {};
  const runId = asText(run.id) || 'run-live';
  const runStatus = asText(run.status).toUpperCase();
  const { byTaskId, byRole } = extractActorAssignments(snapshot);

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const nodeStates: Record<string, ExecutionState> = {};

  const plannerId = 'live-planner';
  const hasPlan = snapshot.milestones.length > 0
    || snapshot.tasks.length > 0
    || snapshot.events.some((event) => {
      const k = asText(event.kind);
      return k === 'plan_generated' || k === 'plan_registered';
    });
  const plannerAssign = byRole.get('tactical_planner');
  nodes.push({
    id: plannerId,
    type: 'planner_node',
    label: locale === 'en' ? '01_PLAN · Tactical Plan' : '01_PLAN · 战术规划',
    role: 'tactical_planner',
    position: { x: 0, y: 120 },
    config: plannerAssign?.provider || plannerAssign?.model
      ? { provider: plannerAssign.provider, model: plannerAssign.model }
      : undefined,
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
        config: taskAssign?.provider || taskAssign?.model
          ? { provider: taskAssign.provider, model: taskAssign.model }
          : undefined,
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
    const centerY = msTasks.length > 0 ? ((msTasks.length - 1) * 150) / 2 : 120;
    nodes.push({
      id: reviewerId,
      type: 'reviewer_node',
      label: truncateLabel(`${msId} · ${msTitle}`, 38),
      role: 'milestone_reviewer',
      position: { x: baseX + 300, y: centerY },
      config: reviewerAssign?.provider || reviewerAssign?.model
        ? { provider: reviewerAssign.provider, model: reviewerAssign.model }
        : undefined,
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
