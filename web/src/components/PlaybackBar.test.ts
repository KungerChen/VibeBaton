import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { MESSAGES } from '../i18n/messages';
import { PlaybackBar } from './PlaybackBar';
import type { PlaybackBarProps } from './types';

function renderBar(overrides: Partial<PlaybackBarProps> = {}): string {
  return renderToStaticMarkup(createElement(PlaybackBar, {
    scenario: 'happy_path',
    onScenarioChange: vi.fn(),
    replayActive: false,
    onToggleReplay: vi.fn(),
    onExitReplay: vi.fn(),
    liveViewActive: false,
    liveRunId: null,
    onExitLiveView: vi.fn(),
    activeCaseId: 'official-stage1',
    activeCaseTitle: 'Stage 1',
    isCustomCaseActive: false,
    replayCaseLabel: 'Tutorial: Stage 1 (60×)',
    savedCases: [],
    summaryPill: '1h 47m · 14/14 tasks · sanitized replay',
    onSelectReplayCase: vi.fn(),
    onImportCaseRequest: vi.fn(),
    onResetTutorialCase: vi.fn(),
    playing: false,
    onPlayPause: vi.fn(),
    onStepBack: vi.fn(),
    onStep: vi.fn(),
    onReset: vi.fn(),
    speed: 1,
    onSpeedChange: vi.fn(),
    stepIndex: 2,
    stepCount: 10,
    currentEvent: null,
    disabled: false,
    ...overrides,
  }));
}

describe('PlaybackBar mode clarity and transport controls', () => {
  test('hides summaryPill and Exit Replay during normal simulation, and shows them during replay', () => {
    const simMarkup = renderBar({ replayActive: false, summaryPill: null });
    expect(simMarkup).not.toContain('playback-bar__summary-pill');
    expect(simMarkup).not.toContain(MESSAGES.en.playback.exitReplay);
    expect(simMarkup).toContain(`title="${MESSAGES.en.playback.replayTitle}"`);
    expect(simMarkup).toContain(`aria-label="${MESSAGES.en.playback.stepBack}"`);

    const replayMarkup = renderBar({
      replayActive: true,
      summaryPill: '1h 47m · 14/14 tasks · sanitized replay',
    });
    expect(replayMarkup).toContain('playback-bar__summary-pill');
    expect(replayMarkup).toContain('1h 47m · 14/14 tasks · sanitized replay');
    expect(replayMarkup).toContain(MESSAGES.en.playback.exitReplay);
  });

  test('renders Live Sync banner and Back to Blueprint with clickable scenarios during liveViewActive', () => {
    const liveMarkup = renderBar({
      liveViewActive: true,
      liveRunId: 'run-live-1',
      disabled: true,
    });
    expect(liveMarkup).toContain('Live Sync · run-live-1');
    expect(liveMarkup).toContain(MESSAGES.en.playback.backToBlueprint);
    // Scenario buttons stay enabled during Live View so users are never trapped.
    expect(liveMarkup).not.toMatch(/<button[^>]*disabled=""[^>]*>Happy Path<\/button>/);
  });
});
