import type { ReactNode } from 'react';
import type { ApiMode, BatonApiClient } from '../api/client';
import type {
  BudgetProfile,
  DoctorRoleResult,
  GraphTraceEvent,
  GraphValidationResult,
  LiveRunSnapshot,
  NodeType,
  PresetItem,
  RunListItem,
  Scenario,
  WorkflowGraph,
} from '../types/graph';
import type { DoctorTargets, ModelPinFields } from './nodes/readiness';

export interface LeftSidebarProps {
  presets: PresetItem[];
  budgetProfile: BudgetProfile | null;
  budgetProfileSaving: boolean;
  onBudgetProfileChange(profile: BudgetProfile): void;
  currentGraphId: string;
  onSelectPreset(id: string): void;
  onAddNode(type: NodeType): void;
  onImportGraph(graph: WorkflowGraph): void;
  onExport(): void;
  onShare?: () => void;
  validation: GraphValidationResult | null;
  liveSnapshot?: LiveRunSnapshot | null;
  /** Workspace clock in epoch seconds. */
  liveNowSec?: number;
  liveViewActive?: boolean;
  onSelectLiveRun?: () => void;
}

export interface PlaybackBarProps {
  scenario: Scenario;
  onScenarioChange(s: Scenario): void;
  replayActive?: boolean;
  onToggleReplay?: () => void;
  playing: boolean;
  onPlayPause(): void;
  onStep(): void;
  onReset(): void;
  speed: number;
  onSpeedChange(s: number): void;
  stepIndex: number;
  stepCount: number;
  currentEvent: GraphTraceEvent | null;
  disabled?: boolean;
}

export type NodePatch = ModelPinFields & {
  label?: string;
  role?: string;
  provider?: string;
  model?: string;
  max_loops?: number;
};

export type EdgePatch = {
  sourceHandle?: string;
  targetHandle?: string;
  max_loops?: number;
};

export interface RightInspectorProps {
  mode: ApiMode;
  client: BatonApiClient;
  graph: WorkflowGraph;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onUpdateNode(id: string, patch: NodePatch): void;
  onUpdateEdge(id: string, patch: EdgePatch): void;
  trace: GraphTraceEvent[];
  stepIndex: number;
  onJumpToStep(i: number): void;
  onToast(msg: string, kind?: 'ok' | 'err'): void;
  liveSnapshot?: LiveRunSnapshot | null;
  /** Workspace clock in epoch seconds. */
  liveNowSec?: number;
  recentRuns?: RunListItem[];
  selectedRunId?: string | null;
  liveReconnecting?: boolean;
  onSelectRunId?: (runId: string) => void;
  onRefreshLiveRun?: () => Promise<void> | void;
}

export type NodeDoctorProps = {
  doctorTargets?: DoctorTargets;
  onDoctorResult(result: DoctorRoleResult, sequence: number, fallbackRole?: string): void;
};

export interface HeaderBarProps {
  mode: ApiMode;
  version?: string;
  graphName: string;
  onOpenGuide?: () => void;
}

export interface ModalProps {
  open: boolean;
  title: string;
  wide?: boolean;
  onClose(): void;
  children: ReactNode;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: 'ok' | 'err';
}

export interface ToastHostProps {
  toasts: readonly ToastItem[];
}
