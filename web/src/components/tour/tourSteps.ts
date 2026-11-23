export const TOUR_STEP_ORDER = [
  'live-run-card',
  'budget-profile',
  'recipe-plaza',
  'canvas-workspace',
  'inspector-live-tab',
  'start-real-run-btn',
  'header-controls',
] as const;

type CoreTourStepId = (typeof TOUR_STEP_ORDER)[number];
export type TourStepId = CoreTourStepId | 'demo-playback';

export interface TourStep {
  id: TourStepId;
  requiredPane: 'sidebar' | 'canvas' | 'inspector' | null;
  requiredInspectorTab: 'live' | null;
  localOnly: boolean;
  needsLiveRun: boolean;
  fallbackId?: TourStepId;
}

export interface GuidedTourOverlayProps {
  steps: TourStep[];
  stepIndex: number;
  onStepChange(index: number): void;
  onClose(): void;
  onRequirePane?(pane: TourStep['requiredPane'], tab: TourStep['requiredInspectorTab']): void;
}

const STEP_REQUIREMENTS: Record<CoreTourStepId, Omit<TourStep, 'id'>> = {
  'live-run-card': {
    requiredPane: 'sidebar',
    requiredInspectorTab: null,
    localOnly: false,
    needsLiveRun: true,
    fallbackId: 'recipe-plaza',
  },
  'budget-profile': {
    requiredPane: 'sidebar',
    requiredInspectorTab: null,
    localOnly: false,
    needsLiveRun: false,
  },
  'recipe-plaza': {
    requiredPane: 'sidebar',
    requiredInspectorTab: null,
    localOnly: false,
    needsLiveRun: false,
  },
  'canvas-workspace': {
    requiredPane: 'canvas',
    requiredInspectorTab: null,
    localOnly: false,
    needsLiveRun: false,
  },
  'inspector-live-tab': {
    requiredPane: 'inspector',
    requiredInspectorTab: 'live',
    localOnly: false,
    needsLiveRun: false,
  },
  'start-real-run-btn': {
    requiredPane: 'inspector',
    requiredInspectorTab: 'live',
    localOnly: true,
    needsLiveRun: false,
  },
  'header-controls': {
    requiredPane: null,
    requiredInspectorTab: null,
    localOnly: false,
    needsLiveRun: false,
  },
};

export const TOUR_STEPS: readonly TourStep[] = TOUR_STEP_ORDER.map((id) => ({
  id,
  ...STEP_REQUIREMENTS[id],
}));

const DEMO_PLAYBACK_STEP: TourStep = {
  id: 'demo-playback',
  requiredPane: 'canvas',
  requiredInspectorTab: null,
  localOnly: false,
  needsLiveRun: false,
};

export function resolveAvailableTourSteps(
  mode: 'local' | 'demo',
  hasLiveRun: boolean,
  hasElement: (id: TourStepId) => boolean,
): TourStep[] {
  const candidates = mode === 'demo' && !hasLiveRun
    ? TOUR_STEPS.flatMap((step) => step.id === 'canvas-workspace' ? [step, DEMO_PLAYBACK_STEP] : [step])
    : TOUR_STEPS;
  const available = candidates.filter((step) =>
    (!step.localOnly || mode === 'local')
    && (!step.needsLiveRun || hasLiveRun)
    && hasElement(step.id),
  );

  if (available.some(({ id }) => id === 'live-run-card')) return available;

  const fallbackId = STEP_REQUIREMENTS['live-run-card'].fallbackId;
  const fallback = available.find((step) => step.id === fallbackId);
  return fallback ? [fallback, ...available.filter((step) => step.id !== fallbackId)] : available;
}

export function tourSelector(id: TourStepId): string {
  if (id === 'demo-playback') return '[data-tour-id="canvas-workspace"] .playback-bar';
  return `[data-tour-id="${id}"]`;
}
