import type { ReactNode } from 'react';
import type { ApiMode, BatonApiClient } from '../api/client';
import type {
  GraphTraceEvent,
  GraphValidationResult,
  NodeType,
  PresetItem,
  Scenario,
  WorkflowGraph,
} from '../types/graph';

export interface LeftSidebarProps {
  presets: PresetItem[];
  currentGraphId: string;
  onSelectPreset(id: string): void;
  onAddNode(type: NodeType): void;
  onImportGraph(graph: WorkflowGraph): void;
  onExport(): void;
  onShare?: () => void;
  validation: GraphValidationResult | null;
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

export type NodePatch = {
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
}

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
