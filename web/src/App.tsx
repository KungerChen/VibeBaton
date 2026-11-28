import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { addEdge, useEdgesState, useNodesState, type OnConnect } from '@xyflow/react';
import { BatonApiClient, type ApiMode } from './api/client';
import { AttentionBanner } from './components/AttentionBanner';
import { CanvasWorkspace, updateWorkspaceReadiness } from './components/CanvasWorkspace';
import { GlossaryDrawer, GuidedWorkbench } from './components/guided';
import { HeaderBar } from './components/HeaderBar';
import { RunControlsContext } from './components/inspector/LiveRunPanel';
import { LeftSidebar } from './components/LeftSidebar';
import { PlaybackBar } from './components/PlaybackBar';
import { QuickStartModal, type QuickStartStepId } from './components/QuickStartModal';
import {
  ExportCaseModal,
  ExportRecipeModal,
  ImportTransferModal,
  type TransferModalKind,
} from './components/RecipeTransferModals';
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
import { findPreset, starter_2tier } from './data/presets';
import {
  buildAlertFingerprint,
  deriveAttentionAlert,
  dispatchBrowserNotification,
  formatAttentionDocumentTitle,
  playAttentionChime,
  readDismissedFingerprints,
  recordDismissedFingerprint,
  shouldAnnounceAttentionEpisode,
} from './engine/attentionAlerts';
import {
  buildOfficialStage1Case,
  caseSummaryPill,
  OFFICIAL_STAGE1_CASE_ID,
  readSavedCases,
  writeSavedCases,
} from './engine/caseReplay';
import { caseReplayReducer, createCaseReplayState } from './engine/caseReplayState';
import { flowToGraph, graphToFlow } from './engine/flowAdapter';
import { isRunStatusActive, useLiveClock } from './engine/liveClock';
import { buildLiveRunGraph, deriveLiveRoleStates, projectLiveRunCanvas } from './engine/liveRunGraph';
import { deriveStates, stepIntervalMs } from './engine/playback';
import { buildShareUrl, decodeRecipeHash } from './engine/shareUrl';
import { I18nProvider, useI18n } from './i18n';
import { translatePresetText } from './i18n/presets';
import { hasSavedStudioMode, loadStudioMode, saveStudioMode, type StudioMode } from './lib/studioMode';
import { createRunStore, useRunStore, type RunStore } from './state/runStore';
import { ThemeProvider, useTheme } from './theme';
import type {
  BatonCaseBundle,
  BudgetProfile,
  GraphTraceEvent,
  GraphValidationResult,
  LiveRunSnapshot,
  NodeType,
  PresetItem,
  RolesConfigResponse,
  Scenario,
  WorkflowGraph,
  WorkflowNode,
} from './types/graph';

const starter = graphToFlow(starter_2tier);
const initialCanvasJson = JSON.stringify(flowToGraph(starter_2tier, starter.nodes, starter.edges));
const emptySelection: { nodeId: string | null; edgeId: string | null } = { nodeId: null, edgeId: null };
const emptyTrace: GraphTraceEvent[] = [];
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
  const [transferModal, setTransferModal] = useState<TransferModalKind>(null);
  const closeTransfer = useCallback(() => setTransferModal(null), []);
  const [caseExportRunId, setCaseExportRunId] = useState<string | null>(null);
  const [caseReplay, dispatchCaseReplay] = useReducer(
    caseReplayReducer, undefined, () => createCaseReplayState(readSavedCases()),
  );
  const { activeCaseId, savedCases, replayActive } = caseReplay;
  const savedCase = savedCases.find(({ case_id }) => case_id === activeCaseId);
  const activeCase = useMemo(() => savedCase ?? buildOfficialStage1Case(locale), [savedCase, locale]);
  const lastSavedCases = useRef(savedCases);
  const canvasBeforeReplay = useRef<WorkflowGraph | null>(null);
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
  const [playbackRunning, setPlaybackRunning] = useState(false);
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
  const runStoreRef = useRef<RunStore | null>(null);
  if (runStoreRef.current === null) {
    runStoreRef.current = createRunStore({
      client,
      onError: (error) => push(errorMessage(error), 'err'),
      onSnapshot: (snapshot) => syncQuotaReadiness(snapshot.quotas),
      onStreamSnapshot: (snapshot) => {
        if (initialSnapshotHydratedRef.current) return;
        const streamRunId = typeof snapshot.run?.id === 'string' ? snapshot.run.id : null;
        const initialFingerprint = buildAlertFingerprint(streamRunId, deriveAttentionAlert(snapshot));
        if (initialFingerprint) {
          announcedFingerprints.current.add(initialFingerprint);
        }
        initialSnapshotHydratedRef.current = true;
      },
    });
  }
  const runStore = runStoreRef.current;
  const {
    snapshot: liveSnapshot,
    recentRuns,
    selectedRunId,
    syncStatus: runSyncStatus,
    reconnecting: liveReconnecting,
    controlsBusy,
  } = useRunStore(runStore);
  const attentionAlert = useMemo(() => deriveAttentionAlert(liveSnapshot), [liveSnapshot]);
  const run = liveSnapshot?.run;
  const runId = typeof run?.run_id === 'string' ? run.run_id : typeof run?.id === 'string' ? run.id : null;
  const fingerprint = buildAlertFingerprint(runId, attentionAlert);
  const [dismissedFingerprints, setDismissedFingerprints] = useState<Set<string>>(() => readDismissedFingerprints());
  const [dismissedReady, setDismissedReady] = useState(false);
  const [battleReportToken, setBattleReportToken] = useState(0);
  const announcedFingerprints = useRef(new Set<string>());
  const initialSnapshotHydratedRef = useRef(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    () => typeof window === 'undefined' ? 'unsupported' : (window.Notification?.permission ?? 'unsupported'),
  );
  // Rejecting a decision pauses the run and resolves the attention episode in the same update.
  const visibleFingerprint = dismissedReady && fingerprint && !dismissedFingerprints.has(fingerprint) && !wasPausedByRejection(liveSnapshot)
    ? fingerprint
    : null;
  const visibleAttentionAlert = visibleFingerprint ? attentionAlert : null;
  const baseTitle = messages.docTitle;
  const isSelectedRunActive = isRunStatusActive(liveSnapshot?.run?.status);
  const liveNowSec = useLiveClock(isSelectedRunActive, liveSnapshot?.telemetry?.server_now);
  const [liveViewActive, setLiveViewActive] = useState(false);
  // A shared recipe link is shown on the Pro canvas, as before the workbench became the default; this is not saved.
  const [studioMode, setStudioMode] = useState<StudioMode>(() => (typeof window !== 'undefined' && window.location.hash.startsWith('#recipe=') ? 'pro' : loadStudioMode()));
  const [hasOpenedGuided, setHasOpenedGuided] = useState(() => studioMode === 'guided');
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const lastLiveCanvasRef = useRef<{ runId: string | null; signature: string } | null>(null);
  const availableCaseRunId = mode === 'local' ? selectedRunId ?? runId ?? recentRuns[0]?.id ?? null : null;
  const snapshotRunId = typeof liveSnapshot?.run?.id === 'string' ? liveSnapshot.run.id : null;
  const runSynced = runSyncStatus === 'synced' && (!selectedRunId || selectedRunId === snapshotRunId);
  const { toasts, push } = useToasts();

  const graph = useMemo(() => flowToGraph(baseGraph, nodes, edges), [baseGraph, nodes, edges]);
  const canvasDirty = transferModal === 'import'
    && JSON.stringify(canvasBeforeReplay.current ?? graph) !== initialCanvasJson;
  const isCustomCaseActive = activeCaseId !== OFFICIAL_STAGE1_CASE_ID;
  const replayCaseLabel = isCustomCaseActive
    ? `${messages.transfer.playback.startPrefix}${activeCase.title}`
    : messages.playback.replayButton;
  const summaryPill = caseSummaryPill(activeCase, locale);
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
      ? activeCase.trace
      : simulation?.validation === validation && simulation.scenario === scenario
        ? simulation.trace
        : emptyTrace;
  const stepCount = trace.length;
  const stepIndex = Math.min(caseReplay.stepIndex, stepCount);
  const playing = playbackRunning && stepIndex < stepCount;
  const resetPlayback = useCallback(() => {
    dispatchCaseReplay({ type: 'set_step', stepIndex: 0 });
    setPlaybackRunning(false);
  }, []);

  useEffect(() => {
    dispatchCaseReplay({ type: 'locale_changed', locale });
  }, [locale]);

  useEffect(() => {
    if (lastSavedCases.current === savedCases) return;
    writeSavedCases(savedCases);
    lastSavedCases.current = savedCases;
  }, [savedCases]);

  const announceAttention = useEffectEvent((episode: string) => {
    if (!visibleAttentionAlert || !shouldAnnounceAttentionEpisode(episode, announcedFingerprints.current, initialSnapshotHydratedRef.current)) {
      return;
    }
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
    if (mode === null) return;
    if (mode !== 'local') {
      setDismissedReady(true);
      return;
    }
    let active = true;
    setDismissedReady(false);
    void client.getDismissedAttention().then(
      (serverFingerprints) => {
        if (!active || serverFingerprints.length === 0) return;
        setDismissedFingerprints((current) => {
          let next = current;
          for (const item of serverFingerprints) {
            next = recordDismissedFingerprint(item, next);
          }
          return next;
        });
      },
      () => {},
    ).finally(() => {
      if (active) setDismissedReady(true);
    });
    return () => { active = false; };
  }, [client, mode]);

  useEffect(() => {
    let active = true;

    function reportError(error: unknown) {
      if (active) push(errorMessage(error), 'err');
    }

    async function initialize() {
      const nextMode = await (initialization.current ??= client.init());
      if (!active) return;
      setMode(nextMode);
      // The workbench needs the local server; without one a first visit shows the Pro canvas, as it always did.
      if (nextMode === 'demo' && !hasSavedStudioMode()) setStudioMode('pro');
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

  useEffect(() => {
    if (mode !== 'local') {
      runStore.reset();
      setLiveViewActive(false);
      initialSnapshotHydratedRef.current = false;
      return;
    }
    runStore.connect();
    return () => runStore.disconnect();
  }, [mode, runStore]);

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
    leaveReplay(decoded.graph);
    push(messages.toasts.loadedShared(translatePresetText(decoded.graph.name, locale)));
  });

  useEffect(() => {
    loadSharedHash();
  }, []);

  useEffect(() => {
    setSimulation(null);
    if (replayActive) return;
    resetPlayback();
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
          dispatchCaseReplay({ type: 'set_step', stepIndex: result.trace.length > 0 ? 1 : 0 });
          setPlaybackRunning(result.trace.length > 0);
        }
      } catch (error) {
        if (active) push(errorMessage(error), 'err');
      }
    }

    void simulate();
    return () => { active = false; };
  }, [client, liveViewActive, push, replayActive, resetPlayback, scenario, validation]);

  const advancePlayback = useEffectEvent(() => {
    if (!playing) return;
    const next = stepIndex + 1;
    dispatchCaseReplay({ type: 'set_step', stepIndex: next });
    if (next === stepCount) setPlaybackRunning(false);
  });

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => advancePlayback(), stepIntervalMs(speed));
    return () => clearInterval(timer);
  }, [canvasKey, playing, speed, stepCount]);

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
  }

  function leaveReplay(nextGraph = canvasBeforeReplay.current) {
    canvasBeforeReplay.current = null;
    pendingAutoPlayRef.current = false;
    dispatchCaseReplay({ type: 'stop_replay' });
    setPlaybackRunning(false);
    if (nextGraph) replaceGraph(nextGraph);
  }

  function showReplayCase(bundle: BatonCaseBundle) {
    latestPresetRequest.current += 1;
    pendingAutoPlayRef.current = false;
    canvasBeforeReplay.current ??= graph;
    setLiveViewActive(false);
    replaceGraph(bundle.graph);
    setPlaybackRunning(true);
    setPane('canvas');
  }

  function handleLoadCase(bundle: BatonCaseBundle) {
    if (bundle.case_id === OFFICIAL_STAGE1_CASE_ID) {
      handleSelectReplayCase(OFFICIAL_STAGE1_CASE_ID);
      return;
    }
    showReplayCase(bundle);
    dispatchCaseReplay({ type: 'load_case', bundle });
  }

  function handleSelectReplayCase(caseId: string) {
    const bundle = caseId === OFFICIAL_STAGE1_CASE_ID
      ? (isCustomCaseActive ? buildOfficialStage1Case(locale) : activeCase)
      : savedCases.find(({ case_id }) => case_id === caseId);
    if (!bundle) return;
    showReplayCase(bundle);
    dispatchCaseReplay({ type: 'select_case', caseId });
  }

  function handleResetTutorialCase() {
    leaveReplay();
    dispatchCaseReplay({ type: 'reset_tutorial' });
  }

  function handleOpenCaseExport(targetRunId: string) {
    setCaseExportRunId(targetRunId);
    setTransferModal('export-case');
  }

  function handleOpenTransfer(kind: TransferModalKind) {
    if (kind === 'export-case') {
      if (availableCaseRunId) handleOpenCaseExport(availableCaseRunId);
      return;
    }
    setTransferModal(kind);
  }

  function onSelectLiveRun() {
    if (!liveSnapshot?.run) return;
    if (liveViewActive) {
      setLiveViewActive(false);
      return;
    }
    latestPresetRequest.current += 1;
    leaveReplay();
    lastLiveCanvasRef.current = null;
    setLiveViewActive(true);
  }

  function onAttentionRunAction(action: 'approve' | 'reject' | 'resume', note?: string) {
    if (!runSynced || !runId) return;
    void runStore.changeRun(runId, action, note);
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
        leaveReplay(preset);
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
    const editableGraph = canvasBeforeReplay.current ?? graph;
    const node = newWorkflowNode(type, editableGraph.nodes, messages.nodeTypes[type]);
    const nextGraph = { ...editableGraph, nodes: [...editableGraph.nodes, node] };
    setLiveViewActive(false);
    if (replayActive) {
      leaveReplay(nextGraph);
      return;
    }
    const flow = graphToFlow({ ...graph, nodes: [node], edges: [] });
    setBaseGraph(nextGraph);
    setNodes((current) => [...current, ...flow.nodes]);
  }

  function handleApplyRecipe(imported: WorkflowGraph) {
    latestPresetRequest.current += 1;
    setLiveViewActive(false);
    leaveReplay(imported);
    push(messages.toasts.imported(translatePresetText(imported.name, locale)));
  }

  function onScenarioSelect(nextScenario: Scenario) {
    setLiveViewActive(false);
    leaveReplay();
    setScenario(nextScenario);
  }

  function onToggleReplay() {
    if (replayActive) {
      leaveReplay();
      return;
    }
    showReplayCase(activeCase);
    dispatchCaseReplay({ type: 'start_replay' });
    if (!isCustomCaseActive) push(messages.toasts.replayLoaded);
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
    if (!playing && stepIndex >= stepCount) dispatchCaseReplay({ type: 'set_step', stepIndex: 0 });
    setPlaybackRunning(!playing && stepCount > 0);
  }

  function onJumpToStep(index: number) {
    dispatchCaseReplay({ type: 'set_step', stepIndex: Math.min(Math.max(index, 0), stepCount) });
    setPlaybackRunning(false);
  }

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (studioMode !== 'pro' || liveViewActive || stepCount === 0 || tourState.open) return;
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

    if (event.key === ' ') {
      if (target?.closest('button, a, [role="button"], [role="tab"], [role="switch"]')) return;
      event.preventDefault();
      onPlayPause();
    } else if (event.key === 'ArrowRight') {
      if (target?.closest('[role="tablist"], .react-flow__node.selected')) return;
      if (stepIndex < stepCount) {
        event.preventDefault();
        onJumpToStep(stepIndex + 1);
      }
    } else if (event.key === 'ArrowLeft') {
      if (target?.closest('[role="tablist"], .react-flow__node.selected')) return;
      if (stepIndex > 0) {
        event.preventDefault();
        onJumpToStep(stepIndex - 1);
      }
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

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
    setScenario('happy_path');
    setGuideOpen(false);
    const editableGraph = canvasBeforeReplay.current ?? graph;
    if (replayActive || editableGraph.id !== starter_2tier.id) {
      leaveReplay(editableGraph.id === starter_2tier.id ? editableGraph : starter_2tier);
      pendingAutoPlayRef.current = true;
      return;
    }
    if (simulation?.scenario === 'happy_path' && simulation.trace.length > 0) {
      dispatchCaseReplay({ type: 'set_step', stepIndex: 1 });
      setPlaybackRunning(true);
    } else {
      pendingAutoPlayRef.current = true;
    }
  }

  function onGuideWatchReplay() {
    markGuideStep('replay');
    setGuideOpen(false);
    if (!replayActive || isCustomCaseActive) {
      handleSelectReplayCase(OFFICIAL_STAGE1_CASE_ID);
      push(messages.toasts.replayLoaded);
    }
    dispatchCaseReplay({ type: 'start_replay' });
    setPlaybackRunning(true);
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

  function onStudioModeChange(nextMode: StudioMode) {
    setStudioMode(nextMode);
    if (nextMode === 'guided') setHasOpenedGuided(true);
    saveStudioMode(nextMode);
  }

  // Every real run starts from the workbench launch bar; a run already going is shown there instead.
  const openLaunchBar = () => onStudioModeChange('guided');

  const headerBar = (
    <HeaderBar
      mode={mode ?? 'demo'}
      version={typeof version === 'string' ? version : undefined}
      graphName={graph.name}
      replayActive={replayActive}
      liveViewActive={liveViewActive}
      // Start Run and the Quick Start guide belong to the Pro layout; Guided Mode has its own flow.
      onOpenStartRun={studioMode === 'pro' && mode === 'local' ? openLaunchBar : undefined}
      onOpenGuide={studioMode === 'pro' ? () => setGuideOpen(true) : undefined}
      studioMode={studioMode}
      onStudioModeChange={onStudioModeChange}
      onOpenGlossary={() => setGlossaryOpen(true)}
    />
  );
  const glossaryDrawer = (
    <GlossaryDrawer open={glossaryOpen} onClose={() => setGlossaryOpen(false)} locale={locale} />
  );
  const dismissCurrentAttention = () => {
    if (fingerprint) {
      setDismissedFingerprints((current) => recordDismissedFingerprint(fingerprint, current));
      void client.dismissAttention(fingerprint).catch(() => {});
    }
  };
  const attentionBanner = (
    <AttentionBanner
      key={visibleFingerprint}
      alert={visibleAttentionAlert}
      runId={runId}
      locale={locale}
      notificationPermission={notificationPermission}
      busy={controlsBusy}
      controlsDisabled={!runSynced}
      onApprove={() => onAttentionRunAction('approve')}
      onReject={(note) => onAttentionRunAction('reject', note)}
      onResume={() => onAttentionRunAction('resume')}
      onOpenBattleReport={() => {
        if (studioMode !== 'pro') onStudioModeChange('pro');
        onRequirePane('inspector', 'live');
        setBattleReportToken((n) => n + 1);
      }}
      onEnableNotifications={() => void onEnableNotifications()}
      onDismiss={dismissCurrentAttention}
    />
  );

  return (
    <>
      {hasOpenedGuided && (
        <div className="guided-app" hidden={studioMode !== 'guided'}>
          {studioMode === 'guided' ? headerBar : null}
          {studioMode === 'guided' && visibleAttentionAlert ? (
            <div className="guided-app__attention">{attentionBanner}</div>
          ) : null}
          <GuidedWorkbench
            locale={locale}
            client={client}
            apiMode={mode}
            liveSnapshot={liveSnapshot}
            onFollowRun={(followRunId) => {
              lastLiveCanvasRef.current = null;
              setLiveViewActive(true);
              void runStore.followRun(followRunId);
            }}
            onResetSession={dismissCurrentAttention}
            onOpenBudget={() => {
              // The project budget is changed in the Pro sidebar's budget profile; the first-run guide must not cover it.
              onStudioModeChange('pro');
              setPane('sidebar');
              setGuideOpen(false);
            }}
          />
        </div>
      )}
      <div
        className="app"
        hidden={studioMode === 'guided'}
        style={{
          '--sidebar-w': `${paneWidths.sidebar}px`,
          '--inspector-w': `${paneWidths.inspector}px`,
        } as CSSProperties}
      >
        {studioMode === 'pro' ? headerBar : null}
      {studioMode === 'pro' ? attentionBanner : null}
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
          onOpenTransfer={handleOpenTransfer}
          caseExportAvailable={availableCaseRunId !== null}
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
            onExitReplay={() => leaveReplay()}
            liveViewActive={liveViewActive}
            liveRunId={runId}
            onExitLiveView={() => setLiveViewActive(false)}
            activeCaseId={activeCaseId}
            activeCaseTitle={activeCase.title}
            isCustomCaseActive={isCustomCaseActive}
            replayCaseLabel={replayCaseLabel}
            savedCases={savedCases.map(({ case_id, title }) => ({ case_id, title }))}
            summaryPill={replayActive ? summaryPill : null}
            onSelectReplayCase={handleSelectReplayCase}
            onImportCaseRequest={() => handleOpenTransfer('import')}
            onResetTutorialCase={handleResetTutorialCase}
            playing={playing}
            onPlayPause={onPlayPause}
            onStepBack={() => onJumpToStep(stepIndex - 1)}
            onStep={() => onJumpToStep(stepIndex + 1)}
            onReset={resetPlayback}
            speed={speed}
            onSpeedChange={setSpeed}
            stepIndex={stepIndex}
            stepCount={stepCount}
            currentEvent={currentEvent}
            disabled={stepCount === 0}
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
        <RunControlsContext.Provider value={{ busy: controlsBusy, changeRun: runStore.changeRun, onOpenCaseExport: handleOpenCaseExport }}>
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
            runSynced={runSynced}
            runSyncStatus={runSyncStatus}
            liveReconnecting={liveReconnecting}
            onSelectRunId={(id) => void runStore.selectRun(id)}
            onRefreshLiveRun={runStore.refresh}
            onOpenStartRun={mode === 'local' ? openLaunchBar : undefined}
            openBattleReportToken={battleReportToken}
          />
        </RunControlsContext.Provider>
      </div>
      <QuickStartModal
        open={studioMode === 'pro' && guideOpen}
        onClose={() => setGuideOpen(false)}
        completedSteps={completedGuideSteps}
        dontShowAgain={dontShowGuide}
        onDontShowAgainChange={onDontShowGuideChange}
        onTryStarter={onGuideTryStarter}
        onWatchReplay={onGuideWatchReplay}
        onInspectWorker={onGuideInspectWorker}
        onStartTour={onStartTour}
      />
      <ImportTransferModal
        open={studioMode === 'pro' && transferModal === 'import'}
        onClose={closeTransfer}
        onApplyRecipe={handleApplyRecipe}
        onLoadCase={handleLoadCase}
        canvasDirty={canvasDirty}
      />
      <ExportRecipeModal
        open={studioMode === 'pro' && transferModal === 'export-recipe'}
        onClose={closeTransfer}
        graph={graph}
        liveViewActive={liveViewActive}
        onSwitchToCaseExport={() => handleOpenTransfer('export-case')}
        buildShareUrl={(recipe) => buildShareUrl(recipe, window.location.href)}
        onToast={push}
      />
      <ExportCaseModal
        open={studioMode === 'pro' && transferModal === 'export-case'}
        onClose={closeTransfer}
        client={client}
        runId={caseExportRunId}
        defaultTitle={messages.transfer.exportCaseModal.defaultTitle}
        onPreviewInPlayer={handleLoadCase}
        onToast={push}
      />
      {studioMode === 'pro' && tourState.open && (
        <GuidedTourOverlay
          steps={tourState.steps}
          stepIndex={tourState.stepIndex}
          onStepChange={(stepIndex) => setTourState((current) => ({ ...current, stepIndex }))}
          onClose={onCloseTour}
          onRequirePane={onRequirePane}
        />
      )}
      </div>
      {glossaryDrawer}
      <ToastHost toasts={toasts} />
    </>
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
