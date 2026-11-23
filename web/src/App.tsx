import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addEdge, useEdgesState, useNodesState, type OnConnect } from '@xyflow/react';
import { BatonApiClient, type ApiMode } from './api/client';
import { AttentionBanner } from './components/AttentionBanner';
import { CanvasWorkspace, updateWorkspaceReadiness } from './components/CanvasWorkspace';
import { HeaderBar } from './components/HeaderBar';
import { isLiveSnapshot, RunControlsContext, useRunControls } from './components/inspector/LiveRunPanel';
import { LeftSidebar } from './components/LeftSidebar';
import { PlaybackBar } from './components/PlaybackBar';
import { QuickStartModal, type QuickStartStepId } from './components/QuickStartModal';
import { RightInspector } from './components/RightInspector';
import { SplitHandle } from './components/SplitHandle';
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_INSPECTOR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  readPaneWidths,
  writePaneWidths,
} from './components/splitPane';
import { GuidedTourOverlay } from './components/tour/GuidedTourOverlay';
import { resolveAvailableTourSteps, tourSelector, type TourStep } from './components/tour/tourSteps';
import type { EdgePatch, NodePatch } from './components/types';
import { ToastHost, useToasts } from './components/ui/Toast';
import { findPreset, flagship_4tier, starter_2tier } from './data/presets';
import { getStage1ReplayTrace } from './data/stage1Replay';
import {
  buildAlertFingerprint,
  deriveAttentionAlert,
  dispatchBrowserNotification,
  formatAttentionDocumentTitle,
  playAttentionChime,
} from './engine/attentionAlerts';
import { flowToGraph, graphToFlow } from './engine/flowAdapter';
import { isRunStatusActive, useLiveClock } from './engine/liveClock';
import { buildLiveRunGraph, deriveLiveRoleStates, projectLiveRunCanvas } from './engine/liveRunGraph';
import { deriveStates, stepIntervalMs } from './engine/playback';
import { buildShareUrl, decodeRecipeHash, encodeRecipeHash } from './engine/shareUrl';
import { I18nProvider, useI18n } from './i18n';
import { translatePresetText } from './i18n/presets';
import { ThemeProvider, useTheme } from './theme';
import type {
  BudgetProfile,
  GraphTraceEvent,
  GraphValidationResult,
  LiveRunSnapshot,
  NodeType,
  PresetItem,
  RolesConfigResponse,
  RunListItem,
  Scenario,
  WorkflowGraph,
  WorkflowNode,
} from './types/graph';

const starter = graphToFlow(starter_2tier);
const emptySelection: { nodeId: string | null; edgeId: string | null } = { nodeId: null, edgeId: null };
const emptyTrace: GraphTraceEvent[] = [];
const initialPlayback = { stepIndex: 0, playing: false };
const LIVE_EVENT_LIMIT = 200;
const GUIDE_DISMISSED_KEY = 'vibebaton.quickstartDismissed';
type WorkspacePane = 'canvas' | 'sidebar' | 'inspector';

class WorkspaceApiClient extends BatonApiClient {
  private initialRolesConfig?: Promise<RolesConfigResponse>;

  loadInitialRolesConfig(): Promise<RolesConfigResponse> {
    return this.initialRolesConfig ??= this.getRolesConfig();
  }

  override async getRoles(): Promise<RolesConfigResponse | null> {
    // The workspace reports errors from this shared request.
    return this.mode === 'local' ? this.loadInitialRolesConfig().catch(() => null) : null;
  }
}

function readGuideDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wasPausedByRejection(snapshot: LiveRunSnapshot | null): boolean {
  const run = snapshot?.run;
  if (run?.status !== 'PAUSED' || typeof run.human_decision !== 'string') return false;
  try {
    const decision = JSON.parse(run.human_decision) as { decision?: unknown; at?: unknown } | null;
    if (decision?.decision !== 'reject' || typeof decision.at !== 'number') return false;
    // The decision and the event recording it both update the run timestamp.
    const lastEvent = snapshot?.events.at(-1);
    return decision.at === run.updated_at
      || (lastEvent?.kind === 'human_decision' && lastEvent.created_at === run.updated_at);
  } catch {
    return false;
  }
}

function newWorkflowNode(type: NodeType, nodes: WorkflowNode[], defaultLabel?: string): WorkflowNode {
  const idPrefix = type.replace('_node', '');
  const label = defaultLabel ?? idPrefix;
  const count = nodes.length;
  const ids = new Set(nodes.map(({ id }) => id));
  let number = count + 1;
  while (ids.has(`${idPrefix}_${number}`)) number += 1;

  const config: NonNullable<WorkflowNode['config']> = {};
  if (type === 'gate_node' || type === 'reviewer_node') config.max_loops = 2;
  if (type === 'worker_node' || type === 'planner_node') {
    const { provider, model } = nodes.find((node) => node.type === type)?.config ?? {};
    if (typeof provider === 'string') config.provider = provider;
    if (typeof model === 'string') config.model = model;
  }

  const offset = 120 + 40 * count;
  return { id: `${idPrefix}_${number}`, type, label, position: { x: offset, y: offset }, config };
}

function AppContent() {
  const { locale, messages } = useI18n();
  const { soundEnabled, soundVolume } = useTheme();
  const panes: readonly { id: WorkspacePane; label: string }[] = [
    { id: 'canvas', label: messages.tabs.canvas },
    { id: 'sidebar', label: messages.tabs.sidebar },
    { id: 'inspector', label: messages.tabs.inspector },
  ];
  const clientRef = useRef<WorkspaceApiClient | null>(null);
  if (clientRef.current === null) clientRef.current = new WorkspaceApiClient();
  const client = clientRef.current;
  const initialization = useRef<Promise<ApiMode> | null>(null);
  const latestPresetRequest = useRef(0);
  const [mode, setMode] = useState<ApiMode | null>(null);
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [budgetProfile, setBudgetProfile] = useState<BudgetProfile | null>(null);
  const [pendingBudgetProfile, setPendingBudgetProfile] = useState<BudgetProfile | null>(null);
  const budgetProfileSaving = useRef(false);
  const [baseGraph, setBaseGraph] = useState<WorkflowGraph>(starter_2tier);
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges);
  const [selection, setSelection] = useState(emptySelection);
  const [pane, setPane] = useState<WorkspacePane>('canvas');
  const [paneWidths, setPaneWidths] = useState(readPaneWidths);
  const [canvasKey, setCanvasKey] = useState(0);
  const [scenario, setScenario] = useState<Scenario>('happy_path');
  const [replayActive, setReplayActive] = useState(false);
  const replayActiveRef = useRef(false);
  replayActiveRef.current = replayActive;
  const pendingAutoPlayRef = useRef(false);
  const [dontShowGuide, setDontShowGuide] = useState<boolean>(() => readGuideDismissed());
  const [guideOpen, setGuideOpen] = useState<boolean>(
    () => typeof window !== 'undefined' && !window.location.hash.startsWith('#recipe=') && !readGuideDismissed(),
  );
  const [tourState, setTourState] = useState<{ open: boolean; stepIndex: number; steps: TourStep[] }>({
    open: false,
    stepIndex: 0,
    steps: [],
  });
  const [completedGuideSteps, setCompletedGuideSteps] = useState<Set<QuickStartStepId>>(() => new Set());
  const [playback, setPlayback] = useState(initialPlayback);
  const [speed, setSpeed] = useState(1);
  const [checkedGraph, setCheckedGraph] = useState<{
    structure: string;
    result: GraphValidationResult;
  } | null>(null);
  const [simulation, setSimulation] = useState<{
    validation: GraphValidationResult;
    scenario: Scenario;
    trace: GraphTraceEvent[];
  } | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveRunSnapshot | null>(null);
  const attentionAlert = useMemo(() => deriveAttentionAlert(liveSnapshot), [liveSnapshot]);
  const run = liveSnapshot?.run;
  const runId = typeof run?.run_id === 'string' ? run.run_id : typeof run?.id === 'string' ? run.id : null;
  const fingerprint = buildAlertFingerprint(runId, attentionAlert);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(null);
  const announcedFingerprints = useRef(new Set<string>());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    () => typeof window === 'undefined' ? 'unsupported' : (window.Notification?.permission ?? 'unsupported'),
  );
  // Rejecting a decision pauses the run and resolves the attention episode in the same update.
  const visibleFingerprint = dismissedFingerprint !== fingerprint && !wasPausedByRejection(liveSnapshot) ? fingerprint : null;
  const visibleAttentionAlert = visibleFingerprint ? attentionAlert : null;
  const baseTitle = messages.docTitle;
  const isSelectedRunActive = isRunStatusActive(liveSnapshot?.run?.status);
  const liveNowSec = useLiveClock(isSelectedRunActive, liveSnapshot?.telemetry?.server_now);
  const [recentRuns, setRecentRuns] = useState<RunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);
  selectedRunIdRef.current = selectedRunId;
  const latestRunIdRef = useRef<string | null>(null);
  const latestStatusRef = useRef<string | null>(null);
  const liveRequestSeq = useRef(0);
  const [liveReconnecting, setLiveReconnecting] = useState(false);
  const [liveViewActive, setLiveViewActive] = useState(false);
  const lastLiveCanvasRef = useRef<{ runId: string | null; signature: string } | null>(null);
  const { toasts, push } = useToasts();
  const runControls = useRunControls(client, onRefreshLiveRun, push);

  const graph = useMemo(() => flowToGraph(baseGraph, nodes, edges), [baseGraph, nodes, edges]);
  // Only workflow changes invalidate playback. Layout edits still go into exports.
  const structure = useMemo(() => JSON.stringify({
    ...graph,
    nodes: graph.nodes.map(({ position, ...node }) => node),
  }), [graph]);
  const getGraph = useEffectEvent(() => graph);
  const validation = checkedGraph?.structure === structure ? checkedGraph.result : null;
  const trace = liveViewActive
    ? emptyTrace
    : replayActive
      ? getStage1ReplayTrace(locale)
      : simulation?.validation === validation && simulation.scenario === scenario
        ? simulation.trace
        : emptyTrace;
  const stepIndex = Math.min(playback.stepIndex, trace.length);
  const playing = playback.playing && trace.length > 0;
  const resetPlayback = useCallback(() => setPlayback(initialPlayback), []);

  useEffect(() => {
    setDismissedFingerprint(null);
  }, [fingerprint]);

  const announceAttention = useEffectEvent((episode: string) => {
    if (!visibleAttentionAlert || announcedFingerprints.current.has(episode)) return;
    announcedFingerprints.current.add(episode);
    dispatchBrowserNotification(visibleAttentionAlert, locale, notificationPermission, window.Notification);
    playAttentionChime(visibleAttentionAlert.category, soundEnabled, soundVolume);
  });

  const updateAttentionTitle = useEffectEvent((tickOdd: boolean) => {
    document.title = formatAttentionDocumentTitle(baseTitle, visibleAttentionAlert, locale, tickOdd);
  });

  useEffect(() => {
    if (!visibleFingerprint) return;
    announceAttention(visibleFingerprint);
    let tickOdd = true;
    const tick = () => {
      updateAttentionTitle(tickOdd);
      tickOdd = !tickOdd;
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      document.title = baseTitle;
    };
  }, [baseTitle, visibleFingerprint]);

  useEffect(() => {
    writePaneWidths(paneWidths);
  }, [paneWidths]);

  useEffect(() => {
    let active = true;

    function reportError(error: unknown) {
      if (active) push(errorMessage(error), 'err');
    }

    async function initialize() {
      const nextMode = await (initialization.current ??= client.init());
      if (!active) return;
      setMode(nextMode);
      void client.listPresets().then((items) => {
        if (active) setPresets(items);
      }, reportError);
      void client.loadInitialRolesConfig().then(({ budget_profile }) => {
        if (active) setBudgetProfile(budget_profile);
      }, reportError);
    }

    void initialize().catch(reportError);
    return () => { active = false; };
  }, [client, push]);

  const syncQuotaReadiness = useCallback((quotas: Record<string, unknown>[]) => {
    updateWorkspaceReadiness((current) => {
      const providerHealth = new Map(current.providerHealth);
      for (const quota of quotas) {
        const provider = quota.provider;
        const cooldown_until = quota.cooldown_until;
        if (typeof provider !== 'string' || typeof cooldown_until !== 'number' || !Number.isFinite(cooldown_until)) continue;
        const previous = providerHealth.get(provider);
        providerHealth.set(provider, { provider, ok: false, detail: '', ...previous, cooldown_until });
      }
      return { ...current, providerHealth };
    });
  }, []);

  const onLiveError = useEffectEvent((error: unknown) => {
    push(errorMessage(error), 'err');
  });

  useEffect(() => {
    if (mode !== 'local') {
      setLiveSnapshot(null);
      setRecentRuns([]);
      setSelectedRunId(null);
      setLiveReconnecting(false);
      setLiveViewActive(false);
      latestRunIdRef.current = null;
      latestStatusRef.current = null;
      return;
    }

    let active = true;
    setLiveReconnecting(false);

    async function refreshRunsList() {
      try {
        const runs = await client.listRuns();
        if (active) setRecentRuns(runs);
      } catch {
        // Initial or background history refresh failures do not block SSE live updates.
      }
    }

    void refreshRunsList();

    let source: EventSource;
    try {
      source = new EventSource(client.streamUrl());
    } catch (error) {
      onLiveError(error);
      return;
    }

    function receiveSnapshot({ data }: MessageEvent<string>) {
      try {
        const parsed: unknown = JSON.parse(data);
        if (!isLiveSnapshot(parsed)) throw new Error('Invalid live run snapshot.');
        const trimmed: LiveRunSnapshot = {
          ...parsed,
          events: parsed.events.slice(-LIVE_EVENT_LIMIT),
        };
        const streamRunId = typeof trimmed.run?.id === 'string' ? trimmed.run.id : null;
        const streamStatus = typeof trimmed.run?.status === 'string' ? trimmed.run.status : null;
        const prevLatestRunId = latestRunIdRef.current;
        const prevLatestStatus = latestStatusRef.current;
        latestRunIdRef.current = streamRunId;
        latestStatusRef.current = streamStatus;

        if (!selectedRunIdRef.current || selectedRunIdRef.current === prevLatestRunId || selectedRunIdRef.current === streamRunId) {
          setSelectedRunId(streamRunId);
          setLiveSnapshot(trimmed);
          syncQuotaReadiness(trimmed.quotas);
        }
        if (streamRunId !== prevLatestRunId || streamStatus !== prevLatestStatus) {
          void refreshRunsList();
        }
        setLiveReconnecting(false);
      } catch (error) {
        onLiveError(error);
      }
    }

    function receiveEvent({ data }: MessageEvent<string>) {
      try {
        const event: unknown = JSON.parse(data);
        if (typeof event !== 'object' || event === null || Array.isArray(event)) {
          throw new Error('Invalid live run event.');
        }
        const row = event as Record<string, unknown>;
        const eventRunId = typeof row.run_id === 'string' ? row.run_id : null;
        setLiveSnapshot((current) => {
          if (!current?.run || typeof current.run.id !== 'string') return current;
          if (selectedRunIdRef.current && selectedRunIdRef.current !== current.run.id) return current;
          if (eventRunId && eventRunId !== current.run.id) return current;
          const lastId = current.events.at(-1)?.id;
          if (typeof row.id === 'number' && typeof lastId === 'number' && row.id <= lastId) return current;
          return {
            ...current,
            events: [...current.events, row].slice(-LIVE_EVENT_LIMIT),
          };
        });
        setLiveReconnecting(false);
      } catch (error) {
        onLiveError(error);
      }
    }

    source.addEventListener('snapshot', receiveSnapshot);
    source.addEventListener('event', receiveEvent);
    source.onopen = () => setLiveReconnecting(false);
    source.onerror = () => setLiveReconnecting(true);
    return () => {
      active = false;
      source.removeEventListener('snapshot', receiveSnapshot);
      source.removeEventListener('event', receiveEvent);
      source.onopen = null;
      source.onerror = null;
      source.close();
    };
  }, [client, mode, syncQuotaReadiness]);

  useEffect(() => {
    if (mode === null) return;
    let active = true;
    setCheckedGraph(null);
    const timer = setTimeout(async () => {
      try {
        const result = await client.validate(getGraph());
        if (active) setCheckedGraph({ structure, result });
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, mode, push, structure]);

  const loadSharedHash = useEffectEvent(() => {
    if (typeof window === 'undefined') return;
    const decoded = decodeRecipeHash(window.location.hash);
    if (!decoded) return;
    if ('error' in decoded) {
      push(messages.toasts.invalidShared(decoded.error), 'err');
      return;
    }
    latestPresetRequest.current += 1;
    setLiveViewActive(false);
    setReplayActive(false);
    replaceGraph(decoded.graph);
    push(messages.toasts.loadedShared(translatePresetText(decoded.graph.name, locale)));
  });

  useEffect(() => {
    loadSharedHash();
  }, []);

  useEffect(() => {
    setSimulation(null);
    if (!replayActiveRef.current) resetPlayback();
    if (liveViewActive || !validation?.valid) return;
    let active = true;
    const validGraph = validation;

    async function simulate() {
      try {
        const result = await client.simulate(getGraph(), scenario);
        if (!active) return;
        setSimulation({ validation: validGraph, scenario, trace: result.trace });
        if (pendingAutoPlayRef.current) {
          pendingAutoPlayRef.current = false;
          setPlayback({ stepIndex: result.trace.length > 0 ? 1 : 0, playing: result.trace.length > 0 });
        }
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }

    void simulate();
    return () => { active = false; };
  }, [client, liveViewActive, push, resetPlayback, scenario, validation]);

  const stepCount = trace.length;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPlayback((current) => {
        if (!current.playing) return current;
        const next = Math.min(current.stepIndex + 1, stepCount);
        return { stepIndex: next, playing: next < stepCount };
      });
    }, stepIntervalMs(speed));
    return () => clearInterval(timer);
  }, [playing, speed, stepCount]);

  const liveGraphView = useMemo(() => {
    if (!liveViewActive || !liveSnapshot?.run) return null;
    const { graph, ...liveState } = buildLiveRunGraph(liveSnapshot, locale);
    return { ...projectLiveRunCanvas(graph), ...liveState };
  }, [liveSnapshot, liveViewActive, locale]);
  const liveNodeTimings = baseGraph.id === liveGraphView?.graph.id ? liveGraphView.nodeTimings : undefined;
  const serverNow = liveSnapshot?.telemetry?.server_now;
  const canvasNow = isSelectedRunActive ? liveNowSec : undefined;
  const liveCanvasTiming = useMemo(() => liveNodeTimings && {
    nodeTimings: liveNodeTimings,
    server_now: serverNow,
    now_epoch_sec: canvasNow,
  }, [liveNodeTimings, serverNow, canvasNow]);

  useEffect(() => {
    if (!liveGraphView) {
      lastLiveCanvasRef.current = null;
      return;
    }
    const runId = typeof liveSnapshot?.run?.id === 'string' ? liveSnapshot.run.id : null;
    const { graph: canvasGraph, signature } = liveGraphView;
    if (lastLiveCanvasRef.current?.runId === runId && lastLiveCanvasRef.current?.signature === signature) {
      return;
    }
    const isNewRun = lastLiveCanvasRef.current?.runId !== runId;
    lastLiveCanvasRef.current = { runId, signature };
    const flow = graphToFlow(canvasGraph, liveGraphView.nodeStates);
    setBaseGraph(canvasGraph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    if (isNewRun) {
      setSelection(emptySelection);
      setCanvasKey((key) => key + 1);
    }
  }, [liveGraphView, liveSnapshot?.run?.id, setEdges, setNodes]);

  const simDerived = useMemo(
    () => deriveStates(graph, trace, trace[stepIndex - 1]?.seq ?? -1),
    [graph, trace, stepIndex],
  );
  const roleStates = useMemo(() => {
    if (liveViewActive || replayActive || stepIndex > 0 || !liveSnapshot?.run) return null;
    return deriveLiveRoleStates(graph, liveSnapshot);
  }, [graph, liveSnapshot, liveViewActive, replayActive, stepIndex]);

  const nodeStates = liveGraphView ? liveGraphView.nodeStates : (roleStates ?? simDerived.nodeStates);
  const activeEdgeIds = liveGraphView ? liveGraphView.activeEdgeIds : simDerived.activeEdgeIds;
  const traversedEdgeIds = liveGraphView ? liveGraphView.traversedEdgeIds : simDerived.traversedEdgeIds;
  const currentEvent = liveGraphView ? null : simDerived.currentEvent;

  useEffect(() => {
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const state = nodeStates[node.id] ?? 'idle';
        if (node.data.state === state) return node;
        changed = true;
        return { ...node, data: { ...node.data, state } };
      });
      return changed ? next : current;
    });
  }, [nodeStates, setNodes]);

  function replaceGraph(nextGraph: WorkflowGraph) {
    const flow = graphToFlow(nextGraph);
    setBaseGraph(nextGraph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelection(emptySelection);
    setCanvasKey((key) => key + 1);
    resetPlayback();
  }

  function onSelectLiveRun() {
    if (!liveSnapshot?.run) return;
    latestPresetRequest.current += 1;
    setReplayActive(false);
    resetPlayback();
    lastLiveCanvasRef.current = null;
    setLiveViewActive(true);
  }

  async function onSelectRunId(nextRunId: string) {
    if (!nextRunId) return;
    const req = ++liveRequestSeq.current;
    setSelectedRunId(nextRunId);
    try {
      const snap = await client.getRun(nextRunId);
      if (req !== liveRequestSeq.current) return;
      const trimmed: LiveRunSnapshot = { ...snap, events: snap.events.slice(-LIVE_EVENT_LIMIT) };
      setLiveSnapshot(trimmed);
      syncQuotaReadiness(trimmed.quotas);
      void client.listRuns().then((runs) => {
        if (req === liveRequestSeq.current) setRecentRuns(runs);
      }, () => {});
    } catch (error) {
      if (req === liveRequestSeq.current) push(errorMessage(error), 'err');
    }
  }

  async function onRefreshLiveRun() {
    const req = ++liveRequestSeq.current;
    try {
      const targetId = selectedRunIdRef.current;
      const snap = targetId && targetId !== latestRunIdRef.current
        ? await client.getRun(targetId)
        : await client.getLatestRun();
      if (req !== liveRequestSeq.current) return;
      const trimmed: LiveRunSnapshot = { ...snap, events: snap.events.slice(-LIVE_EVENT_LIMIT) };
      const resolvedId = typeof trimmed.run?.id === 'string' ? trimmed.run.id : null;
      if (!targetId) setSelectedRunId(resolvedId);
      setLiveSnapshot(trimmed);
      syncQuotaReadiness(trimmed.quotas);
      void client.listRuns().then((runs) => {
        if (req === liveRequestSeq.current) setRecentRuns(runs);
      }, () => {});
    } catch (error) {
      if (req === liveRequestSeq.current) push(errorMessage(error), 'err');
    }
  }

  function onAttentionRunAction(action: 'approve' | 'reject' | 'resume', note?: string) {
    if (runId) void runControls.changeRun(runId, action, note);
  }

  async function onEnableNotifications() {
    if (typeof window.Notification === 'undefined') return;
    try {
      setNotificationPermission(await window.Notification.requestPermission());
    } catch (error) {
      push(errorMessage(error), 'err');
    }
  }

  async function onSelectPreset(id: string) {
    const request = ++latestPresetRequest.current;
    try {
      const preset = mode === 'local' ? await client.getPreset(id) : findPreset(id);
      if (!preset) throw new Error(messages.toasts.unknownPreset(id));
      if (request === latestPresetRequest.current) {
        setLiveViewActive(false);
        setReplayActive(false);
        replaceGraph(preset);
      }
    } catch (error) {
      if (request === latestPresetRequest.current) push(errorMessage(error), 'err');
    }
  }

  async function onBudgetProfileChange(profile: BudgetProfile) {
    if (budgetProfile === null || profile === budgetProfile || budgetProfileSaving.current) return;
    budgetProfileSaving.current = true;
    setPendingBudgetProfile(profile);
    try {
      const { budget_profile } = await client.setBudgetProfile(profile);
      setBudgetProfile(budget_profile);
    } catch (error) {
      push(`${messages.budgetProfile.label} · ${errorMessage(error)}`, 'err');
    } finally {
      budgetProfileSaving.current = false;
      setPendingBudgetProfile(null);
    }
  }

  function onAddNode(type: NodeType) {
    const node = newWorkflowNode(type, graph.nodes, messages.nodeTypes[type]);
    const flow = graphToFlow({ ...graph, nodes: [node], edges: [] });
    setLiveViewActive(false);
    setReplayActive(false);
    setBaseGraph({ ...graph, nodes: [...graph.nodes, node] });
    setNodes((current) => [...current, ...flow.nodes]);
  }

  function onImportGraph(imported: WorkflowGraph) {
    latestPresetRequest.current += 1;
    setLiveViewActive(false);
    setReplayActive(false);
    replaceGraph(imported);
    push(messages.toasts.imported(translatePresetText(imported.name, locale)));
  }

  function onExport() {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${graph.id}.baton.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function onShare() {
    try {
      const hash = encodeRecipeHash(graph);
      const url = buildShareUrl(graph, window.location.href);
      window.history.replaceState(null, '', hash);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        push(messages.toasts.shareCopied);
      } else {
        push(messages.toasts.shareUpdatedBar);
      }
    } catch (error) {
      push(errorMessage(error), 'err');
    }
  }

  function onScenarioSelect(nextScenario: Scenario) {
    setLiveViewActive(false);
    setReplayActive(false);
    setScenario(nextScenario);
    resetPlayback();
  }

  function onToggleReplay() {
    setLiveViewActive(false);
    if (replayActive) {
      setReplayActive(false);
      resetPlayback();
      return;
    }
    latestPresetRequest.current += 1;
    if (graph.id !== flagship_4tier.id) replaceGraph(flagship_4tier);
    setReplayActive(true);
    setPlayback({ stepIndex: 1, playing: true });
    push(messages.toasts.replayLoaded);
  }

  function onUpdateNode(id: string, patch: NodePatch) {
    setNodes((current) => current.map((node) => node.id === id
      ? { ...node, data: { ...node.data, ...patch, label: patch.label ?? node.data.label } }
      : node));
  }

  function onUpdateEdge(id: string, patch: EdgePatch) {
    const { max_loops, ...handles } = patch;
    setEdges((current) => current.map((edge) => {
      if (edge.id !== id) return edge;
      const updated = { ...edge, ...handles };
      if ('max_loops' in patch) updated.data = { ...edge.data, max_loops };
      const { sourceHandle } = updated;
      updated.label = sourceHandle === 'out' || sourceHandle === 'dag' ? undefined : sourceHandle;
      return updated;
    }));
  }

  const onConnect = useCallback<OnConnect>((connection) => {
    setEdges((current) => {
      // The workspace ID is shared by connections that only differ by target handle.
      if ('id' in connection && current.some(({ id }) => id === connection.id)) return current;
      return addEdge(connection, current);
    });
  }, [setEdges]);

  function onPlayPause() {
    setPlayback((current) => current.playing
      ? { ...current, playing: false }
      : { stepIndex: current.stepIndex >= stepCount ? 0 : current.stepIndex, playing: true });
  }

  function onJumpToStep(index: number) {
    setPlayback({ stepIndex: Math.min(Math.max(index, 0), stepCount), playing: false });
  }

  function onDontShowGuideChange(next: boolean) {
    setDontShowGuide(next);
    if (typeof window !== 'undefined') {
      try {
        if (next) {
          window.localStorage.setItem(GUIDE_DISMISSED_KEY, '1');
        } else {
          window.localStorage.removeItem(GUIDE_DISMISSED_KEY);
        }
      } catch {
        // Ignore storage errors in restricted contexts.
      }
    }
  }

  function markGuideStep(step: QuickStartStepId) {
    setCompletedGuideSteps((current) => {
      if (current.has(step)) return current;
      const next = new Set(current);
      next.add(step);
      return next;
    });
  }

  function onStartTour() {
    const steps = resolveAvailableTourSteps(
      mode ?? 'demo',
      Boolean(liveSnapshot),
      (id) => document.querySelector(tourSelector(id)) !== null,
    );
    setGuideOpen(false);
    setTourState({ open: steps.length > 0, stepIndex: 0, steps });
  }

  function onRequirePane(requiredPane: TourStep['requiredPane'], tab: TourStep['requiredInspectorTab']) {
    if (requiredPane) setPane(requiredPane);
    if (tab === 'live') {
      // RightInspector owns the tab state, so use the same selection path as a user click.
      const liveTab = document.querySelector<HTMLButtonElement>(tourSelector('inspector-live-tab'));
      if (liveTab?.getAttribute('aria-selected') === 'false') liveTab.click();
    }
  }

  const onCloseTour = useCallback(() => {
    setTourState((current) => ({ ...current, open: false }));
  }, []);

  function onGuideTryStarter() {
    markGuideStep('starter');
    latestPresetRequest.current += 1;
    setLiveViewActive(false);
    setReplayActive(false);
    setScenario('happy_path');
    setGuideOpen(false);
    if (graph.id !== starter_2tier.id) {
      pendingAutoPlayRef.current = true;
      replaceGraph(starter_2tier);
      return;
    }
    if (simulation?.scenario === 'happy_path' && simulation.trace.length > 0) {
      setPlayback({ stepIndex: 1, playing: true });
    } else {
      pendingAutoPlayRef.current = true;
    }
  }

  function onGuideWatchReplay() {
    markGuideStep('replay');
    setGuideOpen(false);
    if (!replayActive) {
      onToggleReplay();
    } else {
      setPlayback({ stepIndex: 1, playing: true });
    }
  }

  function onGuideInspectWorker() {
    markGuideStep('inspect');
    setGuideOpen(false);
    const targetNode = nodes.find((node) => node.data.nodeType === 'worker_node') ?? nodes[0];
    if (!targetNode) return;
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === targetNode.id })));
    setSelection({ nodeId: targetNode.id, edgeId: null });
    setPane('inspector');
  }

  const version = client.health?.version;
  return (
    <div
      className="app"
      style={{
        '--sidebar-w': `${paneWidths.sidebar}px`,
        '--inspector-w': `${paneWidths.inspector}px`,
      } as CSSProperties}
    >
      <HeaderBar
        mode={mode ?? 'demo'}
        version={typeof version === 'string' ? version : undefined}
        graphName={graph.name}
        onOpenGuide={() => setGuideOpen(true)}
      />
      <AttentionBanner
        key={visibleFingerprint}
        alert={visibleAttentionAlert}
        runId={runId}
        locale={locale}
        notificationPermission={notificationPermission}
        busy={runControls.busy}
        onApprove={() => onAttentionRunAction('approve')}
        onReject={(note) => onAttentionRunAction('reject', note)}
        onResume={() => onAttentionRunAction('resume')}
        onOpenBattleReport={() => onRequirePane('inspector', 'live')}
        onEnableNotifications={() => void onEnableNotifications()}
        onDismiss={() => setDismissedFingerprint(fingerprint)}
      />
      <nav className="app-tabs tabs" aria-label={messages.tabs.ariaLabel}>
        {panes.map(({ id, label }) => (
          <button
            className={`tab${pane === id ? ' tab--active' : ''}`}
            key={id}
            type="button"
            aria-pressed={pane === id}
            aria-controls={`workspace-${id}`}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="app-pane app-pane--sidebar" id="workspace-sidebar" data-active={pane === 'sidebar'}>
        <LeftSidebar
          presets={presets}
          budgetProfile={pendingBudgetProfile ?? budgetProfile}
          budgetProfileSaving={pendingBudgetProfile !== null}
          onBudgetProfileChange={onBudgetProfileChange}
          currentGraphId={graph.id}
          onSelectPreset={onSelectPreset}
          onAddNode={onAddNode}
          onImportGraph={onImportGraph}
          onExport={onExport}
          onShare={onShare}
          validation={validation}
          liveSnapshot={liveSnapshot}
          liveNowSec={liveNowSec}
          liveViewActive={liveViewActive}
          onSelectLiveRun={onSelectLiveRun}
        />
      </div>
      <SplitHandle
        ariaLabel={messages.splitPane.sidebarHandleLabel}
        hint={messages.splitPane.resizeHint}
        value={paneWidths.sidebar}
        min={MIN_SIDEBAR_WIDTH}
        max={MAX_SIDEBAR_WIDTH}
        defaultValue={DEFAULT_SIDEBAR_WIDTH}
        side="left"
        onChange={(sidebar) => setPaneWidths((current) => ({ ...current, sidebar }))}
      />
      <main className="app-pane app-pane--canvas" id="workspace-canvas" data-active={pane === 'canvas'}>
        <CanvasWorkspace
          key={canvasKey}
          nodes={nodes}
          edges={edges}
          liveTiming={liveCanvasTiming}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={setSelection}
          activeEdgeIds={activeEdgeIds}
          traversedEdgeIds={traversedEdgeIds}
        >
          <PlaybackBar
            scenario={scenario}
            onScenarioChange={onScenarioSelect}
            replayActive={replayActive}
            onToggleReplay={onToggleReplay}
            playing={playing}
            onPlayPause={onPlayPause}
            onStep={() => onJumpToStep(stepIndex + 1)}
            onReset={resetPlayback}
            speed={speed}
            onSpeedChange={setSpeed}
            stepIndex={stepIndex}
            stepCount={stepCount}
            currentEvent={currentEvent}
            disabled={liveViewActive || stepCount === 0}
          />
        </CanvasWorkspace>
      </main>
      <SplitHandle
        ariaLabel={messages.splitPane.inspectorHandleLabel}
        hint={messages.splitPane.resizeHint}
        value={paneWidths.inspector}
        min={MIN_INSPECTOR_WIDTH}
        max={MAX_INSPECTOR_WIDTH}
        defaultValue={DEFAULT_INSPECTOR_WIDTH}
        side="right"
        onChange={(inspector) => setPaneWidths((current) => ({ ...current, inspector }))}
      />
      <div className="app-pane app-pane--inspector" id="workspace-inspector" data-active={pane === 'inspector'}>
        <RunControlsContext.Provider value={runControls}>
          <RightInspector
            mode={mode ?? 'demo'}
            client={client}
            graph={graph}
            selectedNodeId={selection.nodeId}
            selectedEdgeId={selection.edgeId}
            onUpdateNode={onUpdateNode}
            onUpdateEdge={onUpdateEdge}
            trace={trace}
            stepIndex={stepIndex}
            onJumpToStep={onJumpToStep}
            onToast={push}
            liveSnapshot={liveSnapshot}
            liveNowSec={liveNowSec}
            recentRuns={recentRuns}
            selectedRunId={selectedRunId}
            liveReconnecting={liveReconnecting}
            onSelectRunId={(id) => void onSelectRunId(id)}
            onRefreshLiveRun={onRefreshLiveRun}
          />
        </RunControlsContext.Provider>
      </div>
      <QuickStartModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        completedSteps={completedGuideSteps}
        dontShowAgain={dontShowGuide}
        onDontShowAgainChange={onDontShowGuideChange}
        onTryStarter={onGuideTryStarter}
        onWatchReplay={onGuideWatchReplay}
        onInspectWorker={onGuideInspectWorker}
        onStartTour={onStartTour}
      />
      {tourState.open && (
        <GuidedTourOverlay
          steps={tourState.steps}
          stepIndex={tourState.stepIndex}
          onStepChange={(stepIndex) => setTourState((current) => ({ ...current, stepIndex }))}
          onClose={onCloseTour}
          onRequirePane={onRequirePane}
        />
      )}
      <ToastHost toasts={toasts} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppContent />
      </I18nProvider>
    </ThemeProvider>
  );
}
