import { describe, expect, test } from 'vitest';
import { resolveAvailableTourSteps, TOUR_STEP_ORDER, tourSelector, type TourStepId } from './tourSteps';

describe('resolveAvailableTourSteps', () => {
  test('includes all seven steps in order for a local live run', () => {
    const steps = resolveAvailableTourSteps('local', true, () => true);
    const ids = steps.map(({ id }) => id);

    expect(ids).toEqual([
      'live-run-card',
      'budget-profile',
      'recipe-plaza',
      'canvas-workspace',
      'inspector-live-tab',
      'start-real-run-btn',
      'header-controls',
    ]);
    expect(ids).toEqual(TOUR_STEP_ORDER);
  });

  test('keeps six steps in demo mode when all anchors are available', () => {
    const steps = resolveAvailableTourSteps('demo', true, () => true);

    expect(steps.map(({ id }) => id)).toEqual(TOUR_STEP_ORDER.filter((id) => id !== 'start-real-run-btn'));
  });

  test('builds a six-step offline demo tour with playback and trace', () => {
    const anchors = new Set<TourStepId>([
      'budget-profile',
      'recipe-plaza',
      'canvas-workspace',
      'demo-playback',
      'inspector-live-tab',
      'header-controls',
    ]);
    const steps = resolveAvailableTourSteps('demo', false, (id) => anchors.has(id));

    expect(steps.map(({ id }) => id)).toEqual([
      'recipe-plaza',
      'budget-profile',
      'canvas-workspace',
      'demo-playback',
      'inspector-live-tab',
      'header-controls',
    ]);
    expect(steps[3]).toMatchObject({ requiredPane: 'canvas', requiredInspectorTab: null });
  });

  test('filters missing anchors and preserves the order of the remaining steps', () => {
    const anchors = new Set<TourStepId>(['header-controls', 'recipe-plaza', 'live-run-card']);
    const steps = resolveAvailableTourSteps('local', true, (id) => anchors.has(id));

    expect(steps.map(({ id }) => id)).toEqual(['live-run-card', 'recipe-plaza', 'header-controls']);
  });

  test.each([false, true])('starts at Recipe Plaza without a live run (live card present: %s)', (hasLiveCard) => {
    const steps = resolveAvailableTourSteps('local', false, (id) => hasLiveCard || id !== 'live-run-card');

    expect(steps.map(({ id }) => id)).toEqual([
      'recipe-plaza',
      'budget-profile',
      'canvas-workspace',
      'inspector-live-tab',
      'start-real-run-btn',
      'header-controls',
    ]);
  });

  test('preserves the remaining steps when both live and recipe anchors are missing', () => {
    const steps = resolveAvailableTourSteps('local', false, (id) => id !== 'live-run-card' && id !== 'recipe-plaza');

    expect(steps.map(({ id }) => id)).toEqual([
      'budget-profile',
      'canvas-workspace',
      'inspector-live-tab',
      'start-real-run-btn',
      'header-controls',
    ]);
  });

  test('starts at Recipe Plaza when a local snapshot has no live card', () => {
    const steps = resolveAvailableTourSteps('local', true, (id) => id !== 'live-run-card');

    expect(steps[0]?.id).toBe('recipe-plaza');
  });

  test('returns an empty tour when no anchor is available', () => {
    expect(resolveAvailableTourSteps('local', true, () => false)).toEqual([]);
  });
});

describe('tourSelector', () => {
  test('selects the matching data-tour-id attribute', () => {
    expect(tourSelector('live-run-card')).toBe('[data-tour-id="live-run-card"]');
  });

  test('targets the existing playback controls inside the canvas in demo', () => {
    expect(tourSelector('demo-playback')).toBe('[data-tour-id="canvas-workspace"] .playback-bar');
  });
});
